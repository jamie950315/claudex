import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { readFile, chmod, lstat, unlink, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { privateDirectory, publishExclusive, readJSON, writeJSON, hash, withLock } from './storage.mjs';

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

/** Configure the native launcher for the next normal Desktop start. Never quit the app. */
export async function installDesktopLauncher({ root, node = process.execPath, launcher, binary, run = execute, platform = process.platform }) {
  if (platform !== 'darwin') throw new Error('Automatic Desktop launcher installation requires macOS.');
  root = await privateDirectory(resolve(root));
  const shim = join(root, 'codex-launcher');
  const content = desktopShim({ root, node, launcher, binary });
  await Promise.all([node, binary].map(path => access(path, constants.X_OK)));
  await access(launcher, constants.R_OK);
  return withLock(join(root, 'desktop-install.lock'), async () => {
    let state = await readJSON(manifestPath(root), null);
    const current = await nativeEnvironment(run);
    if (state) {
      if (state.version !== 1 || state.shim !== shim || state.shimHash !== hash(content)) throw new Error('Existing Desktop installation differs; it was not overwritten.');
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
  });
}

/** Reapply only our exact override after login; the watcher calls this before connecting. */
export async function applyDesktopEnvironment({ root, run = execute }) {
  const state = await readJSON(manifestPath(root), null);
  if (!state || state.version !== 1) throw new Error('Desktop launcher has not been installed.');
  await checkedShim(state);
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
