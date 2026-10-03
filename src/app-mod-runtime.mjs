import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, opendir, realpath, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const MOD_MANAGER_PACKAGE = '@anthropic-ai/claude-code';
export const MOD_MANAGER_VERSION = '2.1.287';
export const MOD_MANAGER_INTEGRITY = 'sha512-V5WRpA+p41siSlf/Ujxjm//RtYvySxH/p9/rh6zRxNoHeBzqTgSDw3nP8PgtACM/KcVx/g5TFUNdVkq51dfg0g==';
export const MOD_MANAGER_NATIVE_INTEGRITIES = Object.freeze({
  arm64: 'sha512-ZQLmkEpiWd8sxUYRpQr1yZ39DyVBhrl8MUtbxe33E+z4jFPtUy+CrJXmeRRyyM+FEfvGe/2ab+E59GiSKkprRw==',
  x64: 'sha512-B5TXBZxGKqglEj5DUp0EjZRBypee4hLSfgkTJIPHdLNB4PAtt6hBkNZVxytny0jUjk0ReWUNtVSb0PTldKRW7Q==',
});
const PACKAGE_PATH = 'node_modules/@anthropic-ai/claude-code';
const TARBALL = `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-${MOD_MANAGER_VERSION}.tgz`;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const absolute = value => typeof value === 'string' && value.startsWith('/') && resolve(value) === value;
const absent = error => error?.code === 'ENOENT';
const fail = message => { throw new Error(message); };
const ready = (binary, version, source) => ({ state: 'ready', binary, version, source });
const missing = () => ({ state: 'missing', reason: 'No installed Mod manager advertises both configure and validate support.' });
const blocked = error => ({ state: 'blocked', reason: error.message });
const signature = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':');
function nativePackage(options) {
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  if (platform !== 'darwin' || !Object.hasOwn(MOD_MANAGER_NATIVE_INTEGRITIES, arch)) fail('Separate Mod manager bootstrap supports only macOS arm64 and x64.');
  const name = `${MOD_MANAGER_PACKAGE}-darwin-${arch}`;
  return { name, arch, path: `node_modules/${name}`, integrity: MOD_MANAGER_NATIVE_INTEGRITIES[arch],
    resolved: `https://registry.npmjs.org/${name}/-/claude-code-darwin-${arch}-${MOD_MANAGER_VERSION}.tgz` };
}
function verifyLock(lock, options) {
  const metadata = lock.packages?.[PACKAGE_PATH], native = nativePackage(options), nativeMetadata = lock.packages?.[native.path];
  if (![2, 3].includes(lock.lockfileVersion) || lock.packages?.['']?.dependencies?.[MOD_MANAGER_PACKAGE] !== MOD_MANAGER_VERSION
    || metadata?.version !== MOD_MANAGER_VERSION || metadata?.integrity !== MOD_MANAGER_INTEGRITY || metadata?.resolved !== TARBALL
    || nativeMetadata?.version !== MOD_MANAGER_VERSION || nativeMetadata?.integrity !== native.integrity || nativeMetadata?.resolved !== native.resolved)
    fail('Private Mod manager package-lock does not match the pinned official wrapper, native package, and integrity.');
  return native;
}

function environment(home, runtime) {
  return { HOME: home, LANG: 'C.UTF-8', PATH: `${runtime ? `${join(runtime, 'bin')}:` : ''}/usr/bin:/bin:/usr/sbin:/sbin` };
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (absent(error)) return false; throw error; } }
async function ownedDirectory(path, { privateMode = false, allowRoot = false } = {}) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !(info.uid === process.getuid() || allowRoot && info.uid === 0)
    || (privateMode ? (info.mode & 0o777) !== 0o700 : (info.mode & 0o022) !== 0)) fail('Mod manager directory is not canonical, owned, and protected from foreign writes.');
  if (await realpath(path) !== path) fail('Mod manager directory contains an unexpected symbolic-link alias.');
}
async function ownedFile(path, { executable = false, allowRoot = false } = {}) {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || !(info.uid === BigInt(process.getuid()) || allowRoot && info.uid === 0n) || info.nlink !== 1n
    || (info.mode & 0o022n) !== 0n || await realpath(path) !== path) fail('Mod manager file is not canonical, owned, and protected from foreign writes.');
  if (executable) await access(path, constants.X_OK);
  return info;
}
async function protectedJSON(path) {
  const before = await ownedFile(path);
  if (before.size > 1024n * 1024n) fail('Mod manager metadata exceeds its read bound.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (signature(await file.stat({ bigint: true })) !== signature(before)) fail('Mod manager metadata changed while opening.');
    const value = JSON.parse(await file.readFile('utf8'));
    if (signature(await file.stat({ bigint: true })) !== signature(before)
      || signature(await lstat(path, { bigint: true })) !== signature(before)) fail('Mod manager metadata changed while reading.');
    return value;
  } finally { await file.close(); }
}
async function boundedEntries(path, limit) {
  const entries = [];
  const directory = await opendir(path);
  for await (const entry of directory) {
    if (entries.length >= limit) fail('Native Mod manager cache inventory exceeds its bounded inspection limit.');
    entries.push(entry);
  }
  return entries;
}
async function runProbe(run, binary, args, env) {
  try { return await run(binary, args, { env, timeout: 10000, maxBuffer: 64 * 1024 }); }
  catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    if (args.includes('--help') && /(?:unknown command|unrecognized (?:command|argument))\s+['"]?(?:configure|validate)['"]?/i.test(output)) return { stdout: '', stderr: '' };
    fail('The selected native Mod manager failed its bounded capability probe; no alternate runtime was started.');
  }
}
async function capability(binary, options, source) {
  const canonical = await realpath(binary);
  const identityOptions = { executable: true, allowRoot: source === 'provided-native-cli' };
  const before = await ownedFile(canonical, identityOptions);
  const env = environment(options.home, options.runtime), run = options.run ?? execute;
  const versionReply = await runProbe(run, canonical, ['--version'], env);
  const version = (versionReply.stdout ?? '').trim().match(/^(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
  if (!version || !SEMVER.test(version)) fail('The selected Mod manager did not report an unambiguous native version.');
  for (const method of ['configure', 'validate']) {
    const reply = await runProbe(run, canonical, ['plugin', method, '--help'], env);
    if (!(new RegExp(`^Usage: claude plugin ${method}(?:\\s|$)`, 'm')).test(reply.stdout ?? '')) return null;
  }
  if (signature(await ownedFile(canonical, identityOptions)) !== signature(before)) fail('The Mod manager executable changed during capability inspection.');
  return ready(canonical, version, source);
}
async function privateManager(prefix, options) {
  await ownedDirectory(prefix, { privateMode: true });
  const lock = await protectedJSON(join(prefix, 'package-lock.json'));
  const native = verifyLock(lock, options);
  let current = prefix;
  for (const component of PACKAGE_PATH.split('/')) { current = join(current, component); await ownedDirectory(current); }
  const manifest = await protectedJSON(join(current, 'package.json'));
  if (manifest.name !== MOD_MANAGER_PACKAGE || manifest.version !== MOD_MANAGER_VERSION || manifest.bin?.claude !== 'bin/claude.exe'
    || manifest.optionalDependencies?.[native.name] !== MOD_MANAGER_VERSION)
    fail('Private Mod manager package metadata does not match the pinned executable.');
  // The wrapper executable is a placeholder until its postinstall copies or
  // hardlinks this exact optional binary. Select the pinned native file directly
  // and keep all third-party install scripts disabled.
  const nativeRoot = join(prefix, native.path); await ownedDirectory(nativeRoot);
  const nativeManifest = await protectedJSON(join(nativeRoot, 'package.json'));
  if (nativeManifest.name !== native.name || nativeManifest.version !== MOD_MANAGER_VERSION
    || JSON.stringify(nativeManifest.os) !== '["darwin"]' || JSON.stringify(nativeManifest.cpu) !== JSON.stringify([native.arch]))
    fail('Private native Mod manager metadata does not match the selected macOS architecture.');
  const value = await capability(join(nativeRoot, 'claude'), options, 'private-mod-manager');
  if (!value || value.version !== MOD_MANAGER_VERSION) fail('The pinned private Mod manager does not provide its required native version and capabilities.');
  return value;
}
async function desktopManager(options) {
  const cache = join(options.home, 'Library', 'Application Support', 'Claude', 'claude-code');
  if (!await exists(cache)) return null;
  let current = options.home;
  for (const name of ['Library', 'Application Support', 'Claude', 'claude-code']) { current = join(current, name); await ownedDirectory(current); }
  const versions = (await boundedEntries(cache, 64)).filter(entry => SEMVER.test(entry.name))
    .sort((a, b) => { const x = a.name.split('.').map(Number), y = b.name.split('.').map(Number); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; });
  let inspected = 0;
  for (const version of versions) {
    const versionPath = join(cache, version.name); await ownedDirectory(versionPath);
    const builds = (await boundedEntries(versionPath, 32)).filter(entry => /^[a-f0-9]{8,64}$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
    for (const build of builds) {
      if (++inspected > 128) fail('Native Mod manager cache inventory exceeds its candidate limit.');
      const buildPath = join(versionPath, build.name); await ownedDirectory(buildPath);
      const app = join(buildPath, 'claude.app'); if (!await exists(app)) continue;
      for (const path of [app, join(app, 'Contents'), join(app, 'Contents', 'MacOS')]) await ownedDirectory(path);
      const run = options.run ?? execute, env = environment(options.home, options.runtime);
      const binary = join(app, 'Contents', 'MacOS', 'claude');
      const proofPaths = [app, join(app, 'Contents'), join(app, 'Contents', 'MacOS'),
        join(app, 'Contents', 'Info.plist'), join(app, 'Contents', '_CodeSignature'), join(app, 'Contents', '_CodeSignature', 'CodeResources'), binary];
      await ownedDirectory(join(app, 'Contents', '_CodeSignature'));
      for (const path of [join(app, 'Contents', 'Info.plist'), join(app, 'Contents', '_CodeSignature', 'CodeResources'), binary]) await ownedFile(path);
      const identities = await Promise.all(proofPaths.map(async path => signature(await lstat(path, { bigint: true }))));
      const stable = async () => {
        for (const [index, path] of proofPaths.entries()) if (signature(await lstat(path, { bigint: true })) !== identities[index])
          fail('Desktop Mod manager bundle changed during signature or capability verification.');
      };
      try {
        await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { env, timeout: 15000, maxBuffer: 64 * 1024 });
        const result = await run('/usr/bin/codesign', ['-d', '--verbose=2', app], { env, timeout: 10000, maxBuffer: 64 * 1024 });
        const lines = (result.stderr ?? '').split('\n');
        if (!lines.includes('Identifier=com.anthropic.claude-code') || !lines.includes('TeamIdentifier=Q6L2SF6YDW')) throw new Error('publisher');
      } catch { fail('Desktop Mod manager signature or publisher verification failed; no alternate runtime was selected.'); }
      await stable();
      const selected = await capability(binary, options, 'desktop-cache');
      await stable();
      if (selected) return selected;
    }
  }
  return null;
}
function validateOptions(options) {
  if (!absolute(options.root) || !absolute(options.home) || options.runtime !== undefined && !absolute(options.runtime)
    || options.claudeBinary !== undefined && options.claudeBinary !== null && !absolute(options.claudeBinary)) fail('Canonical absolute root, home, runtime, and optional native CLI paths are required.');
}

/** Read-only discovery. A missing CLI capability is not a failed invocation, and
 * no arbitrary native failure is hidden by switching implementations. */
export async function findAppModRuntime(options = {}) {
  try {
    validateOptions(options); await ownedDirectory(options.home);
    if (await exists(options.root)) await ownedDirectory(options.root, { privateMode: true });
    if (options.claudeBinary && await exists(options.claudeBinary)) {
      const selected = await capability(options.claudeBinary, options, 'provided-native-cli');
      if (selected) return selected;
    }
    const desktop = await desktopManager(options); if (desktop) return desktop;
    const providers = join(options.root, 'providers');
    if (await exists(providers)) await ownedDirectory(providers, { privateMode: true });
    const prefix = join(providers, 'claude-mod-cli');
    return await exists(prefix) ? await privateManager(prefix, options) : missing();
  } catch (error) { return blocked(error); }
}

/** Install only a separate pinned manager. Existing provider binaries, settings,
 * model defaults and installed plugins are never replaced or configured here. */
export async function ensureAppModRuntime(options = {}) {
  const found = await findAppModRuntime(options);
  if (found.state !== 'missing') return found;
  try {
    if (!absolute(options.runtime)) fail('A bundled Node/npm runtime is required to bootstrap the separate Mod manager.');
    const native = nativePackage(options);
    await ownedDirectory(options.root, { privateMode: true });
    const node = join(options.runtime, 'bin', 'node'), npm = join(options.runtime, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    for (const path of [options.runtime, join(options.runtime, 'bin'), join(options.runtime, 'lib'),
      join(options.runtime, 'lib', 'node_modules'), join(options.runtime, 'lib', 'node_modules', 'npm'), dirname(npm)])
      await ownedDirectory(path, { allowRoot: true });
    await ownedFile(node, { executable: true, allowRoot: true }); await ownedFile(npm, { allowRoot: true });
    const providers = join(options.root, 'providers');
    await mkdir(providers, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await ownedDirectory(providers, { privateMode: true });
    const prefix = join(providers, 'claude-mod-cli');
    if (await exists(prefix)) return await privateManager(prefix, options);
    const candidate = join(providers, `.claude-mod-cli-${randomUUID()}`);
    await mkdir(candidate, { mode: 0o700 });
    const userConfig = join(candidate, '.npm-userconfig'), globalConfig = join(candidate, '.npm-globalconfig');
    await writeFile(userConfig, '', { flag: 'wx', mode: 0o600 }); await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 });
    await writeFile(join(candidate, 'package.json'), JSON.stringify({ name: 'claudex-private-mod-manager', private: true,
      dependencies: { [MOD_MANAGER_PACKAGE]: MOD_MANAGER_VERSION } }), { flag: 'wx', mode: 0o600 });
    const cache = join(providers, 'claude-mod-npm-cache');
    await mkdir(cache, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await ownedDirectory(cache, { privateMode: true });
    const env = { ...environment(options.home, options.runtime), npm_config_cache: cache,
      npm_config_registry: 'https://registry.npmjs.org', npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig };
    const run = options.run ?? execute;
    const common = ['--prefix', candidate, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--os=darwin', `--cpu=${native.arch}`];
    try {
      await run(node, [npm, 'install', '--package-lock-only', ...common], { cwd: candidate, env, timeout: 120000, maxBuffer: 128 * 1024 });
      const lock = await protectedJSON(join(candidate, 'package-lock.json'));
      verifyLock(lock, options);
      await run(node, [npm, 'ci', ...common], { cwd: candidate, env, timeout: 180000, maxBuffer: 128 * 1024 });
    } catch (error) {
      if (error.message.includes('package-lock does not match')) throw error;
      fail('Pinned Mod manager bootstrap failed; its isolated candidate and existing providers were preserved.');
    }
    await privateManager(candidate, options);
    if (await exists(prefix)) fail('Another Mod manager installation appeared; the verified candidate was preserved without replacing it.');
    await rename(candidate, prefix);
    return await privateManager(prefix, options);
  } catch (error) { return blocked(error); }
}
