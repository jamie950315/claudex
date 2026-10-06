import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { MOD_STAGE_FILES, stageClaudeMod } from './claude-mod-install.mjs';
import { writeJSON, withLock } from './storage.mjs';

const ID = 'claudex@claudex-local';
const INLINE = 'claudex@inline';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const target = file => file.startsWith('plugins/claudex/') ? file.slice(16) : `runtime/${file}`;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const requireValue = (value, code, message) => { if (!value) fail(code, message); };
const absent = error => error.code === 'ENOENT';

/** Dedicated stdin-capable native runner. Callers supply a minimal environment. */
export function defaultNativeModRun(command, args, { input, ...options } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = execFile(command, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, ...options },
      (error, stdout, stderr) => error ? reject(error) : resolveResult({ stdout, stderr }));
    child.stdin.on('error', () => {}); // The exit result remains authoritative on early native refusal.
    child.stdin.end(input ?? '');
  });
}

async function directory(path, { privateMode = false, missing = false, packaged = false } = {}) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (missing && absent(error)) return false; throw error; }
  requireValue(stat.isDirectory() && !stat.isSymbolicLink() && (stat.uid === process.getuid() || packaged && stat.uid === 0)
    && !(stat.mode & (privateMode ? 0o077 : 0o022)) && await realpath(path) === path,
  'unsafe-path', 'The Mod path must be a canonical owned directory without foreign write access.');
  return true;
}

async function safeBytes(path, { optional = false, privateMode = false, packaged = false } = {}) {
  let fd;
  try { fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (optional && absent(error)) return null; throw error; }
  try {
    const before = await fd.stat({ bigint: true });
    requireValue(before.isFile() && (before.uid === BigInt(process.getuid()) || packaged && before.uid === 0n) && before.nlink === 1n
      && !(before.mode & BigInt(privateMode ? 0o077 : 0o022)) && before.size <= 2n * 1024n * 1024n,
    'unsafe-file', 'The Mod file must be bounded, owned, regular and protected from foreign writes.');
    const bytes = await fd.readFile(), after = await fd.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    requireValue(['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key] && after[key] === named[key]),
      'changed-file', 'The Mod file changed during verification.');
    return bytes;
  } finally { await fd.close(); }
}
async function jsonFile(path, options) {
  const bytes = await safeBytes(path, options);
  if (!bytes) return null;
  try { return JSON.parse(bytes); } catch { fail('invalid-state', 'The Mod metadata is malformed; existing state was preserved.'); }
}

async function fileTree(root, hashes, { nativeMetadata = false } = {}) {
  await directory(root);
  requireValue(hashes && typeof hashes === 'object' && Object.keys(hashes).length > 0 && Object.keys(hashes).length <= 128,
    'invalid-stage', 'The Mod stage does not declare a bounded file inventory.');
  const found = []; let entries = 0;
  async function visit(path, prefix = '') {
    await directory(path);
    for (const name of await readdir(path)) {
      const relative = prefix + name, child = join(path, name), stat = await lstat(child);
      requireValue(++entries <= 256 && prefix.split('/').length <= 16 && !stat.isSymbolicLink(), 'unsafe-stage', 'The Mod tree contains an unsafe entry.');
      if (stat.isDirectory()) await visit(child, `${relative}/`);
      else {
        // The native manager's type generator, loaded-plugin leases and
        // orphan marker add these metadata files to its cache. Each native
        // release may add another declaration package, so any
        // types/<package>/index.d.ts is accepted. They are not shipping code
        // and must never exempt an additional script or packaged file.
        const generated = nativeMetadata && !Object.hasOwn(hashes, relative)
          && (/^\.in_use\/[1-9][0-9]{0,9}$/.test(relative)
            || /^\.claude-plugin\/types\/[a-z0-9][a-z0-9-]{0,63}\/index\.d\.ts$/.test(relative)
            || ['tsconfig.json', '.orphaned_at', '.claude-plugin/types/.gitignore', '.claude-plugin/types/tsconfig.json'].includes(relative));
        if (generated) { await safeBytes(child); continue; }
        requireValue(/^[a-f0-9]{64}$/.test(hashes[relative] ?? '') && digest(await safeBytes(child)) === hashes[relative],
          'content-mismatch', 'The installed Mod differs from its verified packaged files.');
        found.push(relative);
      }
    }
  }
  await visit(root);
  requireValue(found.length === Object.keys(hashes).length, 'content-mismatch', 'The Mod installation has missing files.');
}

function options(input) {
  const value = { home: homedir(), run: defaultNativeModRun, node: process.execPath, ...input };
  for (const key of ['root', 'home', 'engineRoot', 'node']) requireValue(typeof value[key] === 'string' && isAbsolute(value[key]), 'invalid-options', 'Mod installation paths must be absolute.');
  value.base = join(value.root, 'app-mod');
  requireValue(value.receiver === undefined || ['enabled', 'disabled'].includes(value.receiver), 'invalid-options', 'The Mod receiver preference is invalid.');
  value.env = { HOME: value.home, PATH: `${dirname(value.node)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8' };
  return value;
}
async function command(o, args, { input, json = true } = {}) {
  requireValue(typeof o.claudeBinary === 'string' && isAbsolute(o.claudeBinary), 'native-manager-unavailable', 'A Claude runtime supporting Mod management is required.');
  const result = await o.run(o.claudeBinary, args, { env: o.env, cwd: o.home, timeout: 30000, maxBuffer: 1024 * 1024, ...(input ? { input: JSON.stringify(input) } : {}) });
  if (!json) return result;
  try { return JSON.parse(result.stdout); } catch { fail('native-response', 'The native Mod manager returned an unsupported response.'); }
}

async function bundle(o) {
  await directory(o.engineRoot, { packaged: true });
  const hashes = {};
  let manifest;
  for (const file of MOD_STAGE_FILES) {
    let parent = o.engineRoot;
    for (const name of file.split('/').slice(0, -1)) { parent = join(parent, name); await directory(parent, { packaged: true }); }
    let bytes = await safeBytes(join(o.engineRoot, file), { packaged: true });
    if (file.endsWith('/.claude-plugin/plugin.json')) {
      manifest = JSON.parse(bytes);
      requireValue(manifest.name === 'claudex' && /^\d+\.\d+\.\d+$/.test(manifest.version), 'invalid-bundle', 'The bundled Mod identity or version is invalid.');
      manifest.userConfig.stateRoot.default = o.root;
      manifest.userConfig.nodeBinary.default = o.node;
      manifest.userConfig.nativeWake.default = false;
      manifest.userConfig.selfWake.default = false;
      bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    }
    hashes[target(file)] = digest(bytes);
  }
  return { version: manifest.version, hashes, key: `${manifest.version}-${digest(JSON.stringify(hashes)).slice(0, 20)}` };
}
const compareVersion = (a, b) => {
  requireValue(/^\d+\.\d+\.\d+$/.test(a) && /^\d+\.\d+\.\d+$/.test(b), 'unsupported-version', 'The installed Mod uses an unsupported version format.');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
};

async function nativeState(o) {
  const [plugins, marketplaces] = await Promise.all([
    command(o, ['plugin', 'list', '--json']), command(o, ['plugin', 'marketplace', 'list', '--json']),
  ]);
  requireValue(Array.isArray(plugins) && Array.isArray(marketplaces), 'native-response', 'The native Mod inventory is not supported.');
  const installed = plugins.filter(p => p.id === ID), sources = marketplaces.filter(p => p.name === 'claudex-local');
  requireValue(installed.length <= 1 && installed.every(p => p.scope === 'user') && sources.length <= 1,
    'installation-conflict', 'Multiple or non-user Claudex Mod installations require review.');
  return { installed: installed[0], source: sources[0] };
}

async function sourceReport(o, source) {
  requireValue(source?.source === 'directory' && typeof source.path === 'string' && isAbsolute(source.path),
    'foreign-marketplace', 'The existing claudex-local marketplace is not a verified local Claudex stage.');
  await directory(source.path);
  await directory(join(source.path, '.claude-plugin'));
  const catalog = await jsonFile(join(source.path, '.claude-plugin', 'marketplace.json'));
  const report = await jsonFile(join(source.path, 'stage-report.json'));
  requireValue(catalog.name === 'claudex-local' && catalog.plugins?.length === 1 && catalog.plugins[0].name === 'claudex'
    && catalog.plugins[0].source === './plugins/claudex' && report.version === 1 && report.stateRoot === o.root
    && report.synchronizationPolicy === 'unchanged' && report.hashes,
  'foreign-marketplace', 'The existing marketplace is not a Claudex stage for this application root.');
  // A legacy stage may have been copied intact to a stable catalog path. Its
  // recorded original path is diagnostic only; the current tree must verify.
  await fileTree(join(source.path, 'plugins', 'claudex'), report.hashes);
  const manifest = await jsonFile(join(source.path, 'plugins', 'claudex', '.claude-plugin', 'plugin.json'));
  requireValue(manifest.name === 'claudex' && manifest.userConfig?.stateRoot?.default === o.root,
    'foreign-marketplace', 'The existing Mod belongs to a different state root.');
  return { ...report, plugin: join(source.path, 'plugins', 'claudex'), version: manifest.version };
}

async function settings(o, installed) {
  await directory(installed.installPath);
  const market = await command(o, ['plugin', 'configure', ID, '--json']);
  const inline = await command(o, [`--plugin-dir=${installed.installPath}`, 'plugin', 'configure', INLINE, '--json']);
  const parse = (data, id) => {
    requireValue(data.pluginId === id && data.inputs && data.schema, 'native-configuration', 'The native Mod configuration could not be verified.');
    const values = {};
    for (const name of ['stateRoot', 'nodeBinary', 'nativeWake', 'selfWake']) {
      requireValue(data.schema[name]?.type === (name.endsWith('Wake') ? 'boolean' : 'string'), 'native-configuration', 'The Mod configuration schema is unsupported.');
      values[name] = data.inputs[name] ?? data.schema[name].default;
      if (name.endsWith('Wake')) {
        requireValue([true, false, 'true', 'false'].includes(values[name]), 'native-configuration', 'The native Mod wake preference is invalid.');
        values[name] = values[name] === true || values[name] === 'true';
      }
    }
    return { ...values, configured: ['stateRoot', 'nodeBinary', 'nativeWake', 'selfWake'].every(key => data.configured?.includes(key)) };
  };
  return { marketplace: parse(market, ID), inline: parse(inline, INLINE) };
}
function report(state, reason, packaged, current = {}, extra = {}) {
  return { state, reason, bundledVersion: packaged?.version ?? null, installedVersion: current.installed?.version ?? null,
    enabled: current.installed?.enabled ?? false, loaded: null, activation: 'new-session', ...extra };
}
async function inspect(o, packaged) {
  const current = await nativeState(o);
  if (current.source) current.stage = await sourceReport(o, current.source);
  if (!current.installed) return { ...current, result: report('missing', 'not-installed', packaged, current) };
  requireValue(current.stage, 'missing-marketplace', 'The installed Mod has no verified marketplace.');
  const cacheRoot = join(o.home, '.claude', 'plugins', 'cache', 'claudex-local', 'claudex');
  requireValue(current.installed.installPath === join(cacheRoot, current.installed.version), 'foreign-installation', 'The native Mod install path is outside its owned user cache.');
  const relative = compareVersion(current.installed.version, packaged.version);
  // Use its verified original stage for older/newer versions; an equal bundled
  // version must match the complete shipping inventory (including runtime code).
  const expected = relative === 0 ? packaged.hashes : current.stage.version === current.installed.version ? current.stage.hashes : null;
  if (expected) await fileTree(current.installed.installPath, expected, { nativeMetadata: true });
  else requireValue(relative < 0, 'unverified-newer-version', 'The newer installed Mod cannot be verified against its source.');
  current.modSettings = await settings(o, current.installed);
  const configReady = Object.values(current.modSettings).every(v => v.configured && v.stateRoot === o.root && v.nodeBinary === o.node);
  let state = 'ready', reason = relative > 0 ? 'newer-installed-preserved' : 'installed-current';
  if (current.installed.enabled !== true) { state = 'disabled'; reason = 'disabled-by-user'; }
  else if (relative < 0) { state = 'update-available'; reason = 'bundled-update'; }
  else if (!configReady) { state = 'update-available'; reason = 'configuration-required'; }
  current.result = report(state, reason, packaged, current, { installPath: current.installed.installPath, modSettings: current.modSettings });
  return current;
}

/** Read-only: never creates a stage, journal, setting, or model session. */
export async function inspectAppMod(input) {
  let packaged;
  try {
    const o = options(input); packaged = await bundle(o);
    if (!await directory(o.root, { privateMode: true, missing: true })) return report('missing', 'root-not-created', packaged);
    if (await directory(o.base, { privateMode: true, missing: true })) await jsonFile(join(o.base, 'install.json'), { optional: true, privateMode: true });
    return (await inspect(o, packaged)).result;
  } catch (error) { return report('blocked', error.code ?? 'native-operation-failed', packaged, {}, { detail: 'Mod inspection could not verify the installation. Existing state was preserved.' }); }
}

/** Install/update only through the native plugin manager, with a recoverable
 * app-owned stage and journal. Never removes native plugins or source trees. */
export async function ensureAppMod(input) {
  let packaged;
  try {
    const o = options(input);
    requireValue(!o.readOnly, 'read-only', 'Read-only Mod inspection cannot install or configure plugins.');
    await directory(o.root, { privateMode: true }); packaged = await bundle(o);
    if (!await directory(o.base, { privateMode: true, missing: true })) await mkdir(o.base, { mode: 0o700 });
    await directory(o.base, { privateMode: true });
    return await withLock(join(o.base, 'install.lock'), async () => {
      const current = await inspect(o, packaged);
      if (current.installed && compareVersion(current.installed.version, packaged.version) > 0) {
        const requestedReceiverMatches = o.receiver === undefined || Object.values(current.modSettings).every(value =>
          value.nativeWake === (o.receiver === 'enabled') && value.selfWake === (o.receiver === 'enabled'));
        if (!requestedReceiverMatches || o.enable === true && current.installed.enabled !== true)
          return { ...current.result, state: 'blocked', reason: 'newer-version-settings-preserved',
            detail: 'The newer installed Mod was preserved. Use its native manager to change these settings.' };
        return current.result;
      }
      if (current.installed?.enabled === false && !o.enable) return current.result;
      if (current.result.state === 'ready' && o.receiver === undefined && !o.enable) return current.result;
      const releases = join(o.base, 'releases');
      if (!await directory(releases, { privateMode: true, missing: true })) await mkdir(releases, { mode: 0o700 });
      let stagePath = join(releases, packaged.key);
      const journalPath = join(o.base, 'install.json');
      const previous = await jsonFile(journalPath, { optional: true, privateMode: true });
      requireValue(!previous || previous.version === 1 && previous.owner === 'claudex-app', 'invalid-journal', 'Unknown Mod installation journal was preserved.');
      let staged;
      if (await directory(stagePath, { privateMode: true, missing: true })
        && !await jsonFile(join(stagePath, 'stage-report.json'), { optional: true })) {
        // An interrupted exclusive stage has never been handed to the native
        // manager. Preserve it intact and build into another fresh directory.
        stagePath = `${stagePath}-recovery-${randomUUID()}`;
      }
      if (await directory(stagePath, { privateMode: true, missing: true })) {
        staged = await sourceReport(o, { source: 'directory', path: stagePath });
        await fileTree(staged.plugin, packaged.hashes);
      } else staged = await stageClaudeMod({ output: stagePath, stateRoot: o.root, repoRoot: o.engineRoot, nodeBinary: o.node });
      const validation = await command(o, ['plugin', 'validate', staged.plugin, '--strict', '--json']);
      requireValue(validation.success === true && validation.strict === true, 'native-validation', 'The native runtime refused strict Mod validation.');
      await fileTree(staged.plugin, packaged.hashes);
      const journal = { version: 1, owner: 'claudex-app', bundledVersion: packaged.version, stagePath,
        previousSource: previous?.previousSource ?? current.source?.path ?? null,
        previousVersion: current.installed?.version ?? null, hashes: packaged.hashes, startedAt: new Date().toISOString() };
      const save = async phase => writeJSON(journalPath, { ...journal, phase, updatedAt: new Date().toISOString() });
      await save('validated');
      const beforeRegistration = await nativeState(o);
      requireValue(beforeRegistration.source?.path === current.source?.path
        && beforeRegistration.source?.source === current.source?.source
        && beforeRegistration.installed?.version === current.installed?.version
        && beforeRegistration.installed?.enabled === current.installed?.enabled,
      'installation-changed', 'The native Mod installation changed during setup; inspect again before retrying.');
      if (current.source?.path !== stagePath) {
        await command(o, ['plugin', 'marketplace', 'add', stagePath, '--scope', 'user'], { json: false });
        const check = await nativeState(o);
        requireValue(check.source?.source === 'directory' && check.source.path === stagePath, 'marketplace-not-applied', 'The native marketplace change was not observed.');
      }
      await save('marketplace-registered');
      const native = await nativeState(o);
      if (!native.installed || native.installed.version !== packaged.version) {
        await fileTree(staged.plugin, packaged.hashes);
        const candidate = join(o.home, '.claude', 'plugins', 'cache', 'claudex-local', 'claudex', packaged.version);
        if (await directory(candidate, { missing: true })) await fileTree(candidate, packaged.hashes, { nativeMetadata: true });
        const result = await command(o, ['plugin', native.installed ? 'update' : 'install', ID, '--scope', 'user', '--json']);
        requireValue(result.outcome === 'ok', 'native-installation', 'The native Mod installation did not report success.');
      }
      const installed = (await nativeState(o)).installed;
      requireValue(installed?.version === packaged.version, 'installation-not-applied', 'The native manager did not install the bundled Mod version.');
      requireValue(installed.installPath === join(o.home, '.claude', 'plugins', 'cache', 'claudex-local', 'claudex', packaged.version),
        'foreign-installation', 'The native Mod cache path is not the expected owned installation.');
      await fileTree(installed.installPath, packaged.hashes, { nativeMetadata: true });
      await save('installed');
      const existing = await settings(o, installed);
      for (const [key, id] of [['marketplace', ID], ['inline', INLINE]]) {
        const prior = existing[key];
        const values = { stateRoot: o.root, nodeBinary: o.node,
          nativeWake: String(o.receiver === undefined ? prior.nativeWake : o.receiver === 'enabled'),
          selfWake: String(o.receiver === undefined ? prior.selfWake : o.receiver === 'enabled') };
        if (Object.entries(values).every(([name, value]) => String(existing[key][name]) === value) && existing[key].configured) continue;
        await command(o, [...(key === 'inline' ? [`--plugin-dir=${installed.installPath}`] : []), 'plugin', 'configure', id, '--values-stdin', '--json'], { input: values });
      }
      if (o.enable === true && installed.enabled !== true) await command(o, ['plugin', 'enable', ID, '--scope', 'user', '--json']);
      const result = (await inspect(o, packaged)).result;
      requireValue(result.state === 'ready', 'configuration-not-applied', 'The native Mod configuration was not fully applied.');
      if (o.receiver !== undefined) requireValue(Object.values(result.modSettings).every(v => v.nativeWake === (o.receiver === 'enabled') && v.selfWake === (o.receiver === 'enabled')),
        'configuration-not-applied', 'The native Mod receiver preference was not applied.');
      await save('complete');
      return { ...result, changed: true };
    }, { recoverDead: true });
  } catch (error) { return report('blocked', error.code ?? 'native-operation-failed', packaged, {}, { detail: 'Mod installation could not complete. Existing plugins and recoverable installation state were preserved.' }); }
}
