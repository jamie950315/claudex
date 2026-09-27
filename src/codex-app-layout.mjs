import { lstat, readFile, access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const flat = '/Contents/Resources/codex';
const packaged = '/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const shell = '/Contents/Resources/codex-cli/bin/codex';

export function codexAppBundle(binary) {
  if (typeof binary !== 'string' || !binary.startsWith('/') || resolve(binary) !== binary) return null;
  for (const suffix of [packaged, shell, flat]) if (binary.endsWith(suffix)) {
    const app = binary.slice(0, -suffix.length);
    if (app.endsWith('.app')) return app;
  }
  return null;
}

export function isBundledCodexRelocation(previous, next) {
  const app = codexAppBundle(previous);
  return Boolean(app && codexAppBundle(next) === app && previous !== next
    && [app + flat, app + shell].includes(previous) && next === app + packaged);
}

export async function verifyBundledCodex(binary, run = execute) {
  await run('/usr/bin/codesign', ['--verify', '--strict', binary]);
  const { stderr } = await run('/usr/bin/codesign', ['-d', '--verbose=2', binary]);
  if (!/^Identifier=codex$/m.test(stderr) || !/^TeamIdentifier=2DC432GLL2$/m.test(stderr))
    throw new Error('Desktop CLI relocation requires the original OpenAI-signed Codex executable.');
}

/** Only the two observed official layouts are recognized. A malformed new
 * package never falls back to an old executable or a PATH-installed provider.
 */
export async function resolveBundledCodex(binary, { verify = verifyBundledCodex } = {}) {
  const app = codexAppBundle(binary);
  if (!app) return binary;
  const resources = join(app, 'Contents', 'Resources');
  const packageRoot = join(resources, 'codex-cli');
  let info;
  try { info = await lstat(packageRoot); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return binary; }
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(packageRoot) !== packageRoot)
    throw new Error('Bundled Codex package directory has an unverified identity.');
  const metadata = await lstat(join(packageRoot, 'codex-package.json'));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096)
    throw new Error('Bundled Codex package metadata is invalid.');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'codex-package.json'), 'utf8'));
  if (manifest.layoutVersion !== 1 || manifest.variant !== 'codex' || manifest.entrypoint !== 'bin/codex'
    || manifest.resourcesDir !== 'codex-resources' || manifest.pathDir !== 'codex-path')
    throw new Error('Bundled Codex package layout is not supported.');
  const next = app + packaged;
  const target = await lstat(next);
  if (!target.isFile() || target.isSymbolicLink() || await realpath(next) !== next)
    throw new Error('Bundled Codex executable has an unverified identity.');
  await access(next, constants.X_OK);
  await verify(next);
  return next;
}

export function bundledDesktopNode(binary) {
  const app = codexAppBundle(binary);
  return app ? join(app, 'Contents', 'Resources', 'cua_node', 'bin', 'node') : null;
}
