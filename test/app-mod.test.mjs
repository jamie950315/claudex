import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, realpath, symlink, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspectAppMod, ensureAppMod, defaultNativeModRun } from '../src/app-mod.mjs';
import { MOD_STAGE_FILES, stageClaudeMod } from '../src/claude-mod-install.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
async function fixture(t) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'claudex-app-mod-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const home = join(scratch, 'home'), root = join(home, 'state');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const o = { root, home, engineRoot: repo, node: await realpath(process.execPath), claudeBinary: '/fixture/claude' };
  const model = { source: null, installed: null, configurations: {}, calls: [], failOnce: null };
  o.run = async (binary, args, options) => {
    model.calls.push({ args, input: options.input });
    assert.equal(options.env.HOME, home);
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
    const output = value => ({ stdout: JSON.stringify(value), stderr: '' });
    const commands = args[0].startsWith('--plugin-dir=') ? args.slice(1) : args;
    if (model.failOnce === commands[1]) { model.failOnce = null; throw new Error('Simulated native interruption'); }
    if (commands[1] === 'list') return output(model.installed ? [model.installed] : []);
    if (commands[1] === 'marketplace') {
      if (commands[2] === 'list') return output(model.source ? [model.source] : []);
      assert.equal(commands[2], 'add');
      model.source = { name: 'claudex-local', source: 'directory', path: commands[3], installLocation: commands[3] };
      return { stdout: 'Added', stderr: '' };
    }
    if (commands[1] === 'validate') return output({ success: true, strict: true });
    if (['install', 'update'].includes(commands[1])) {
      const source = join(model.source.path, 'plugins', 'claudex');
      const manifest = JSON.parse(await readFile(join(source, '.claude-plugin', 'plugin.json')));
      const installPath = join(home, '.claude', 'plugins', 'cache', 'claudex-local', 'claudex', manifest.version);
      await cp(source, installPath, { recursive: true });
      model.installed = { id: 'claudex@claudex-local', scope: 'user', enabled: model.installed?.enabled ?? true, version: manifest.version, installPath };
      return output({ outcome: 'ok' });
    }
    if (commands[1] === 'configure') {
      const schema = JSON.parse(await readFile(join(model.installed.installPath, '.claude-plugin', 'plugin.json'))).userConfig;
      const id = commands[2];
      if (options.input) model.configurations[id] = { ...model.configurations[id], ...JSON.parse(options.input) };
      const inputs = model.configurations[id] ?? {};
      return output({ pluginId: id, schema, inputs, configured: Object.keys(inputs), unconfigured: Object.keys(schema).filter(key => !(key in inputs)) });
    }
    if (commands[1] === 'enable') { model.installed.enabled = true; return output({ outcome: 'ok' }); }
    throw new Error(`Unexpected command: ${args}`);
  };
  return { o, model, scratch };
}

test('fresh app installation stages every dependency, configures both identities and is idempotent', async t => {
  const { o, model } = await fixture(t);
  assert.equal((await inspectAppMod(o)).state, 'missing');
  assert.equal(model.calls.some(c => c.input), false);
  const result = await ensureAppMod(o);
  assert.equal(result.state, 'ready', JSON.stringify(result));
  assert.equal(result.loaded, null);
  assert.equal(result.modSettings.inline.nativeWake, false);
  assert.equal(result.modSettings.marketplace.selfWake, false);
  assert.equal(result.modSettings.inline.stateRoot, o.root);
  const journal = JSON.parse(await readFile(join(o.root, 'app-mod', 'install.json')));
  assert.equal(journal.phase, 'complete');
  assert.equal(Object.keys(journal.hashes).length, 23);
  model.calls.length = 0;
  assert.equal((await ensureAppMod(o)).state, 'ready');
  assert.equal(model.calls.some(c => c.input || c.args.includes('add') || c.args.includes('install') || c.args.includes('update') || c.args.includes('validate')), false);
});

test('receiver is explicit, each identity preference is preserved, disabled installation stays disabled', async t => {
  const { o, model } = await fixture(t);
  await ensureAppMod(o);
  model.configurations['claudex@inline'].nativeWake = 'true';
  model.configurations['claudex@inline'].selfWake = 'true';
  assert.equal((await ensureAppMod(o)).modSettings.marketplace.nativeWake, false);
  assert.equal((await ensureAppMod(o)).modSettings.inline.nativeWake, true);
  const activated = await ensureAppMod({ ...o, receiver: 'enabled' });
  assert.equal(activated.modSettings.marketplace.nativeWake, true);
  model.installed.enabled = false;
  model.calls.length = 0;
  assert.equal((await ensureAppMod(o)).state, 'disabled');
  assert.equal(model.calls.some(c => c.args.includes('enable')), false);
  assert.equal((await ensureAppMod({ ...o, enable: true })).state, 'ready');
});

test('read-only refusal performs no native operation or filesystem mutation', async t => {
  const { o, model } = await fixture(t);
  assert.equal((await ensureAppMod({ ...o, readOnly: true })).reason, 'read-only');
  assert.equal(model.calls.length, 0);
  await assert.rejects(readFile(join(o.root, 'app-mod', 'install.json')), { code: 'ENOENT' });
});

test('foreign marketplace and symlinked app state are preserved', async t => {
  const { o, model, scratch } = await fixture(t);
  model.source = { name: 'claudex-local', source: 'github', repo: 'other/foreign' };
  assert.equal((await ensureAppMod(o)).reason, 'foreign-marketplace');
  assert.equal(model.calls.some(c => c.args.includes('add')), false);
  model.source = null;
  await rm(join(o.root, 'app-mod'), { recursive: true });
  const foreign = join(scratch, 'foreign'); await mkdir(foreign);
  await symlink(foreign, join(o.root, 'app-mod'));
  assert.equal((await ensureAppMod(o)).reason, 'unsafe-path');
});

test('interrupted install resumes from native inventory without reinstalling or replaying work', async t => {
  const { o, model } = await fixture(t);
  model.failOnce = 'configure';
  assert.equal((await ensureAppMod(o)).state, 'blocked');
  assert.ok(model.installed);
  model.calls.length = 0;
  assert.equal((await ensureAppMod(o)).state, 'ready');
  assert.equal(model.calls.some(c => c.args.includes('install') || c.args.includes('update')), false);
});

test('complete installed runtime hashing detects tampering and preserves the file', async t => {
  const { o, model } = await fixture(t);
  await ensureAppMod(o);
  const file = join(model.installed.installPath, 'runtime', 'src', 'collaboration-wait.mjs');
  await writeFile(file, 'changed runtime\n');
  const result = await inspectAppMod(o);
  assert.equal(result.reason, 'content-mismatch');
  assert.equal(await readFile(file, 'utf8'), 'changed runtime\n');
});

test('known native-generated types and live lease metadata do not hide unlisted code', async t => {
  const { o, model } = await fixture(t);
  await ensureAppMod(o);
  const installed = model.installed.installPath;
  for (const name of ['.claude-plugin/types/claude-code/index.d.ts', '.claude-plugin/types/tsconfig.json', '.claude-plugin/types/.gitignore', 'tsconfig.json', '.in_use/123']) {
    await mkdir(dirname(join(installed, name)), { recursive: true, mode: 0o700 });
    await writeFile(join(installed, name), '{}');
  }
  assert.equal((await inspectAppMod(o)).state, 'ready');
  await writeFile(join(installed, '.claude-plugin/types/unlisted.mjs'), 'export default 1;');
  assert.equal((await inspectAppMod(o)).reason, 'content-mismatch');
});

test('legacy owned stages migrate via native add and retain the original source', async t => {
  const { o, model, scratch } = await fixture(t);
  const legacy = join(scratch, 'legacy');
  await stageClaudeMod({ output: legacy, stateRoot: o.root, repoRoot: repo, nodeBinary: o.node });
  model.source = { name: 'claudex-local', source: 'directory', path: legacy };
  // Fresh installation from a legacy source must migrate the catalog, never remove it.
  const oldReport = await readFile(join(legacy, 'stage-report.json'));
  const result = await ensureAppMod(o);
  assert.equal(result.state, 'ready', JSON.stringify(result));
  assert.ok(model.source.path.startsWith(join(o.root, 'app-mod')));
  assert.deepEqual(await readFile(join(legacy, 'stage-report.json')), oldReport);
  assert.equal(model.calls.some(c => c.args.includes('remove') || c.args.includes('uninstall')), false);
});

test('foreign-writable source files are rejected before native mutation', async t => {
  const { o, model, scratch } = await fixture(t);
  const engineRoot = join(scratch, 'engine');
  await cp(repo + '/plugins', engineRoot + '/plugins', { recursive: true });
  await chmod(join(engineRoot, 'plugins', 'claudex', 'hooks', 'register.mjs'), 0o666);
  const result = await ensureAppMod({ ...o, engineRoot });
  assert.equal(result.reason, 'unsafe-file');
  assert.equal(model.calls.length, 0);
});

test('default native runner writes configuration JSON on stdin without shell evaluation', async () => {
  const result = await defaultNativeModRun(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: '{"nativeWake":"false"}', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.stdout, '{"nativeWake":"false"}');
});

async function versionedEngine(scratch, version) {
  const engine = join(scratch, `engine-${version}`);
  for (const name of MOD_STAGE_FILES) {
    await mkdir(dirname(join(engine, name)), { recursive: true, mode: 0o700 });
    await cp(join(repo, name), join(engine, name));
  }
  const path = join(engine, 'plugins/claudex/.claude-plugin/plugin.json');
  const manifest = JSON.parse(await readFile(path)); manifest.version = version;
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
  return engine;
}

test('upgrade preserves prior source and per-identity opt-ins; newer versions never downgrade', async t => {
  const { o, model, scratch } = await fixture(t);
  const older = await versionedEngine(scratch, '0.1.0');
  assert.equal((await ensureAppMod({ ...o, engineRoot: older })).state, 'ready');
  const oldSource = model.source.path;
  model.configurations['claudex@inline'].nativeWake = 'true';
  model.configurations['claudex@inline'].selfWake = 'true';
  assert.equal((await inspectAppMod(o)).state, 'update-available');
  const result = await ensureAppMod(o);
  assert.equal(result.state, 'ready', JSON.stringify(result));
  assert.equal(result.modSettings.inline.selfWake, true);
  assert.equal(result.modSettings.marketplace.selfWake, false);
  assert.ok(await readFile(join(oldSource, 'stage-report.json')));
  model.calls.length = 0;
  const downgrade = await ensureAppMod({ ...o, engineRoot: older });
  assert.equal(downgrade.state, 'ready');
  assert.equal(downgrade.reason, 'newer-installed-preserved');
  assert.equal(model.calls.some(c => c.args.includes('update') || c.args.includes('install') || c.input), false);
  const refusedReceiver = await ensureAppMod({ ...o, engineRoot: older, receiver: 'enabled' });
  assert.equal(refusedReceiver.state, 'blocked');
  assert.equal(refusedReceiver.reason, 'newer-version-settings-preserved');
  model.installed.enabled = false;
  const refusedEnable = await ensureAppMod({ ...o, engineRoot: older, enable: true });
  assert.equal(refusedEnable.state, 'blocked');
  assert.equal(refusedEnable.reason, 'newer-version-settings-preserved');
});

test('a pre-existing foreign cache is rejected without overwriting it', async t => {
  const { o, model } = await fixture(t);
  const version = JSON.parse(await readFile(join(repo, 'plugins/claudex/.claude-plugin/plugin.json'))).version;
  const path = join(o.home, '.claude/plugins/cache/claudex-local/claudex', version);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(join(path, 'foreign-file'), 'preserve');
  assert.equal((await ensureAppMod(o)).reason, 'content-mismatch');
  assert.equal(model.calls.some(c => c.args.includes('install')), false);
  assert.equal(await readFile(join(path, 'foreign-file'), 'utf8'), 'preserve');
});
