import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, dirname } from 'node:path';
import { readFile, chmod, lstat, unlink, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { privateDirectory, publishExclusive, atomicWrite, readJSON, writeJSON, hash, withLock } from './storage.mjs';

const execute = promisify(execFile);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const manifestPath = root => join(root, 'desktop-launcher.json');

export function desktopShim({ root, node, launcher, binary }) {
  for (const value of [root, node, launcher, binary]) {
    if (typeof value !== 'string' || !value.startsWith('/') || /[\r\n\0]/.test(value)) throw new Error('Desktop launcher paths must be absolute single-line paths.');
  }
  return `#!/bin/sh\n# Claudex-owned native Desktop transport launcher.\nexport CLAUDEX_HOME=${quote(root)}\nexport CLAUDEX_CODEX_BINARY=${quote(binary)}\nexec ${quote(node)} ${quote(launcher)} "$@"\n`;
}

async function checkedShim(state) {
  const info = await lstat(state.shim);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700
    || hash(await readFile(state.shim, 'utf8')) !== state.shimHash) throw new Error('Desktop launcher ownership changed; configuration was not modified.');
}

async function nativeEnvironment(run) {
  return (await run('launchctl', ['getenv', 'CODEX_CLI_PATH'])).stdout.trim();
}

export async function verifyDesktopNode(node, run = execute) {
  await run('/usr/bin/codesign', ['--verify', '--strict', node]);
  const identity = await run('/usr/bin/codesign', ['-d', '--verbose=2', node]);
  if (!/^Identifier=node$/m.test(identity.stderr) || !/^TeamIdentifier=2DC432GLL2$/m.test(identity.stderr)) {
    throw new Error('Desktop transport requires the original OpenAI-signed bundled Node runtime.');
  }
}

async function recoverRuntimeUpdate(root, state, verifyRuntime) {
  if (!state.pendingRuntime) return state;
  const next = state.pendingRuntime;
  if (next.version !== 1 || next.shim !== join(root, 'codex-launcher') || next.shim !== state.shim
      || next.binary !== state.binary || next.launcher !== state.launcher || next.pendingRuntime) throw new Error('Invalid Desktop runtime update intent.');
  const content = desktopShim({ root, ...next });
  if (hash(content) !== next.shimHash) throw new Error('Desktop runtime update content does not match its intent.');
  await verifyRuntime(next.node);
  const info = await lstat(state.shim);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || ![0o600, 0o700].includes(info.mode & 0o777)) throw new Error('Desktop launcher ownership changed during update.');
  const actual = hash(await readFile(state.shim, 'utf8'));
  if (actual !== state.shimHash && actual !== next.shimHash) throw new Error('Desktop launcher changed during update; it was not replaced.');
  if (actual !== next.shimHash) await atomicWrite(state.shim, content);
  await chmod(state.shim, 0o700);
  await checkedShim(next);
  await writeJSON(manifestPath(root), next);
  return next;
}

/** Configure the native launcher for the next normal Desktop start. Never quit the app. */
export async function installDesktopLauncher({ root, node, launcher, binary, run = execute, verifyRuntime = verifyDesktopNode, platform = process.platform }) {
  if (platform !== 'darwin') throw new Error('Automatic Desktop launcher installation requires macOS.');
  root = await privateDirectory(resolve(root));
  node ??= join(dirname(binary), 'cua_node', 'bin', 'node');
  const shim = join(root, 'codex-launcher');
  const content = desktopShim({ root, node, launcher, binary });
  await Promise.all([node, binary].map(path => access(path, constants.X_OK)));
  await access(launcher, constants.R_OK);
  await verifyRuntime(node);
  return withLock(join(root, 'desktop-install.lock'), async () => {
    let state = await readJSON(manifestPath(root), null);
    const current = await nativeEnvironment(run);
    if (current && current !== shim) throw new Error('An existing CODEX_CLI_PATH override is in use; it was not overwritten.');
    if (state) {
      state = await recoverRuntimeUpdate(root, state, verifyRuntime);
      if (state.version !== 1 || state.shim !== shim || state.binary !== binary || state.launcher !== launcher) throw new Error('Existing Desktop installation differs; it was not overwritten.');
      if (state.shimHash !== hash(content)) {
        if (state.shimHash !== hash(desktopShim({ root, ...state }))) throw new Error('Existing Desktop runtime identity is unproven.');
        await checkedShim(state);
        const next = { ...state, node, shimHash: hash(content) };
        state = { ...state, pendingRuntime: next };
        await writeJSON(manifestPath(root), state);
        state = await recoverRuntimeUpdate(root, state, verifyRuntime);
      }
    } else {
      if (current && current !== shim) throw new Error('An existing CODEX_CLI_PATH override is in use; it was not overwritten.');
      state = { version: 1, shim, shimHash: hash(content), previousCliPath: null, node, binary, launcher };
      // The intent is durable before the executable or login environment changes.
      await writeJSON(manifestPath(root), state);
    }
    try { await lstat(shim); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await publishExclusive(shim, content);
      await chmod(shim, 0o700);
    }
    await checkedShim(state);
    if (current && current !== shim) throw new Error('CODEX_CLI_PATH changed since installation; it was not overwritten.');
    await run('launchctl', ['setenv', 'CODEX_CLI_PATH', shim]);
    if (await nativeEnvironment(run) !== shim) throw new Error('The next-launch Codex environment could not be verified.');
    return { installed: true, shim, activation: 'next-normal-desktop-start', appRestarted: false };
  }, { recoverDead: true });
}

/** Reapply only our exact override after login; the watcher calls this before connecting. */
export async function applyDesktopEnvironment({ root, run = execute, verifyRuntime = verifyDesktopNode }) {
  root = await privateDirectory(resolve(root));
  let state = await readJSON(manifestPath(root), null);
  if (!state || state.version !== 1) throw new Error('Desktop launcher has not been installed.');
  if (state.pendingRuntime) state = await withLock(join(root, 'desktop-install.lock'), async () => recoverRuntimeUpdate(root,
    await readJSON(manifestPath(root)), verifyRuntime), { recoverDead: true });
  await checkedShim(state);
  await verifyRuntime(state.node);
  const current = await nativeEnvironment(run);
  if (current && current !== state.shim) throw new Error('Another CODEX_CLI_PATH override is active; it was not overwritten.');
  await run('launchctl', ['setenv', 'CODEX_CLI_PATH', state.shim]);
}

export async function uninstallDesktopLauncher({ root, run = execute }) {
  return withLock(join(root, 'desktop-install.lock'), async () => {
    const state = await readJSON(manifestPath(root), null);
    if (!state) return { removed: false };
    await checkedShim(state);
    const current = await nativeEnvironment(run);
    if (current && current !== state.shim) throw new Error('Another CODEX_CLI_PATH override is active; it was not modified.');
    if (current === state.shim) await run('launchctl', ['unsetenv', 'CODEX_CLI_PATH']);
    // The launcher is a reproducible generated artifact, never conversation data.
    await unlink(state.shim);
    await unlink(manifestPath(root));
    return { removed: true, conversationDataPreserved: true, appRestarted: false };
  });
}
