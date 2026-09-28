import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { AppSetup, appPrivateJSON } from '../src/app-setup.mjs';

const readyProviders = (base, versions = {}) => ({
  codex: { binary: join(base, 'codex'), app: join(base, 'Codex.app'), version: versions.codex ?? 'codex-cli 0.155.0-alpha.16.4' },
  claude: { binary: join(base, 'claude'), app: join(base, 'Claude.app'), version: versions.claude ?? '2.1.281' },
});

async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'claudex-app-setup-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'state'), home = join(base, 'home'), runtimeDirectory = join(base, 'runtime');
  await mkdir(root, { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  await mkdir(join(runtimeDirectory, 'bin'), { recursive: true });
  await mkdir(join(runtimeDirectory, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
  await writeFile(join(runtimeDirectory, 'bin', 'node'), '', { mode: 0o755 });
  await writeFile(join(runtimeDirectory, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
  const events = [];
  const providers = options.providers ?? readyProviders(base);
  const run = async (_command, args) => {
    if (args[0] === 'login' && args[1] === 'status') {
      events.push(['auth-codex']);
      return { stdout: options.codexLoggedOut ? 'Not logged in' : 'Logged in using ChatGPT', stderr: '' };
    }
    if (args[0] === 'auth' && args[1] === 'status') {
      events.push(['auth-claude']);
      return { stdout: JSON.stringify({ loggedIn: !options.claudeLoggedOut, authMethod: 'claude.ai', apiProvider: 'firstParty' }), stderr: '' };
    }
    throw new Error(`Unexpected synthetic command: ${args.join(' ')}`);
  };
  const setup = new AppSetup({ root, home, runtimeDirectory, engineRoot: base, run, platform: 'darwin',
    discover: async () => providers, ensure: async () => { events.push(['ensure-providers']); return providers; },
    collaborationInstall: async (input, _options) => { events.push(['collaboration', input]); },
    desktopInstall: async input => { events.push(['desktop', input]); },
    serviceInstall: async input => { events.push(['service', input]); },
    ownership: async () => ({ allowed: options.ownerAllowed !== false }),
    foldersInstall: async input => { events.push(['folders', input]); },
    interfaceInstall: async input => { events.push(['interface', input]); },
    syncHooksInstall: async input => { events.push(['sync-hooks', input]); return { configured: true }; },
  });
  setup.collaborationStatus = async () => ({ limits: { allowWrite: true, defaultPermission: 'workspace-write' } });
  return { base, root, home, runtimeDirectory, providers, setup, events };
}

test('new setup enables all projects and task-scoped writes in broker and sync config', async t => {
  const { root, setup, events } = await fixture(t);
  const report = await setup.setup();
  const broker = events.find(([kind]) => kind === 'collaboration')?.[1];
  assert.equal(broker.allowWrite, true);
  assert.equal(broker.defaultPermission, 'workspace-write');
  const config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  assert.equal(config.mode, 'desktop');
  assert.equal(config.allProjects, true);
  assert.deepEqual(config.projects, []);
  assert.ok(events.some(([kind]) => kind === 'desktop'));
  assert.ok(events.some(([kind]) => kind === 'service'));
  assert.ok(events.some(([kind]) => kind === 'sync-hooks'));
  assert.equal(report.version, 1);
  assert.equal(report.allProjects, true);
  assert.equal(report.allowWrite, true);
});

test('model preferences use authenticated broker requests without running setup', async t => {
  const { root, setup, events } = await fixture(t);
  await mkdir(join(root, 'collaboration'), { mode: 0o700 });
  await writeFile(join(root, 'collaboration', 'controller-key'), 'a'.repeat(64) + '\n', { mode: 0o600 });
  const requests = [];
  setup.collaborationCall = async request => {
    requests.push(request);
    return { defaultModels: request.params.defaultModels ?? { codex: null, claude: null } };
  };
  assert.deepEqual(await setup.models(), { defaultModels: { codex: null, claude: null } });
  assert.deepEqual(await setup.models({ codex: 'test-codex', claude: 'test-claude' }),
    { defaultModels: { codex: 'test-codex', claude: 'test-claude' } });
  assert.ok(requests.every(request => request.method === 'models' && request.token === 'a'.repeat(64)));
  assert.deepEqual(events, []);
  setup.collaborationCall = async () => { throw Object.assign(new Error('Broker offline'), { code: 'ECONNREFUSED' }); };
  await assert.rejects(setup.models(), /Broker offline/);
});

test('background startup integrates the display without installing providers or services', async t => {
  const { setup, events } = await fixture(t);
  await setup.startup();
  assert.ok(events.some(([kind]) => kind === 'interface'));
  assert.ok(!events.some(([kind]) => ['ensure-providers', 'collaboration', 'desktop', 'service', 'folders'].includes(kind)));
});

test('new graphical installs default to no version-only blocking or warnings', async t => {
  const { root, base, setup } = await fixture(t);
  await setup.setup();
  assert.equal(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).versionPolicy, 'warn');
  const report = await setup.inspect({ providers: readyProviders(base, { codex: 'codex-cli 999.0.0', claude: '999.0.0' }) });
  assert.doesNotMatch(report.components.find(row => row.id === 'synchronization').detail, /unsupported|unvalidated|unverified|version.*changed/i);
});

test('display integration failures remain explicit while independent setup stays available', async t => {
  const { setup, events } = await fixture(t);
  setup.interfaceInstall = async () => { throw new Error('Legacy display bundle path differs.'); };
  const report = await setup.setup();
  assert.equal(report.components.find(row => row.id === 'interface').state, 'blocked');
  assert.equal(report.components.find(row => row.id === 'interface').action, 'retry');
  assert.equal((await setup.inspect()).components.find(row => row.id === 'interface').state, 'blocked');
  assert.ok(events.some(([kind]) => kind === 'collaboration'));
});

test('missing provider login leaves existing synchronization config intact', async t => {
  const { root, setup, events } = await fixture(t, { claudeLoggedOut: true });
  const existing = '{"version":1,"mode":"desktop","allProjects":false,"custom":"keep"}\n';
  await writeFile(join(root, 'config.json'), existing, { mode: 0o600 });
  const report = await setup.setup();
  assert.equal(await readFile(join(root, 'config.json'), 'utf8'), existing);
  assert.ok(events.some(([kind]) => kind === 'ensure-providers'));
  assert.ok(events.some(([kind]) => kind === 'auth-codex'));
  assert.ok(events.some(([kind]) => kind === 'auth-claude'));
  assert.ok(!events.some(([kind]) => ['collaboration', 'desktop', 'service'].includes(kind)));
  assert.equal(report.components.find(row => row.id === 'claude-login').state, 'login-required');
  assert.notEqual(report.phase, 'ready');
});

test('active native owner prevents sync mutation without blocking independent broker setup', async t => {
  const { root, setup, events } = await fixture(t, { ownerAllowed: false });
  const report = await setup.setup();
  assert.ok(events.some(([kind]) => kind === 'collaboration'));
  assert.ok(!events.some(([kind]) => kind === 'desktop' || kind === 'service'));
  assert.equal(await appPrivateJSON(join(root, 'config.json')), null);
  assert.equal(report.components.find(row => row.id === 'synchronization').state, 'blocked');
});

test('unsafe or malformed private state and failed provider inspection never report ready', async t => {
  const { base, root, setup, providers } = await fixture(t);
  const outside = join(base, 'outside.json');
  await writeFile(outside, '{}', { mode: 0o600 });
  await symlink(outside, join(root, 'config.json'));
  assert.equal((await setup.inspect({ providers })).components.find(row => row.id === 'synchronization').state, 'blocked');
  await assert.rejects(appPrivateJSON(join(root, 'config.json')));
  await rm(join(root, 'config.json'));
  await writeFile(join(root, 'config.json'), '{broken', { mode: 0o600 });
  assert.equal((await setup.inspect({ providers })).components.find(row => row.id === 'synchronization').state, 'blocked');
  setup.discover = async () => { throw new Error('Unsigned native application'); };
  const report = await setup.inspect();
  assert.equal(report.components.find(row => row.id === 'providers').state, 'blocked');
  assert.notEqual(report.phase, 'ready');
});

test('unknown native versions under strict policy are explicitly not ready', async t => {
  const { root, setup, base } = await fixture(t);
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, mode: 'desktop', allProjects: true, versionPolicy: 'strict' }), { mode: 0o600 });
  const report = await setup.inspect({ providers: readyProviders(base, { codex: 'codex-cli 999.0.0', claude: '999.0.0' }) });
  assert.equal(report.components.find(row => row.id === 'synchronization').state, 'blocked');
  assert.equal(report.phase, 'blocked');
});

test('reopening an already configured app does not stop or rewrite a live synchronization owner', async t => {
  const { root, base, setup, events, providers } = await fixture(t, { ownerAllowed: false });
  const config = { version: 1, mode: 'desktop', allProjects: true, projects: [], binary: providers.codex.binary,
    claudeBinary: providers.claude.binary, versionPolicy: 'strict' };
  await writeFile(join(root, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(root, 'desktop-launcher.json'), JSON.stringify({ launcher: join(base, 'bin', 'claudex-codex.mjs') }), { mode: 0o600 });
  await writeFile(join(root, 'service-install.json'), JSON.stringify({ cli: join(base, 'bin', 'claudex.mjs') }), { mode: 0o600 });
  await setup.setup();
  assert.deepEqual(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')), config);
  assert.ok(!events.some(([kind]) => ['desktop', 'service', 'folders'].includes(kind)));
});

test('missing prerequisite desktop apps do not install services or touch synchronization config', async t => {
  const { base, root, setup, events } = await fixture(t);
  const providers = readyProviders(base); providers.claude.app = null;
  setup.ensure = async () => providers;
  const report = await setup.setup();
  assert.equal(report.components.find(row => row.id === 'claude-desktop').state, 'missing');
  assert.ok(!events.some(([kind]) => ['collaboration', 'desktop', 'service', 'folders'].includes(kind)));
  assert.equal(await appPrivateJSON(join(root, 'config.json')), null);
});

test('native account inspection preserves the OS username without forwarding API credentials', async t => {
  const { setup, home } = await fixture(t);
  let environment;
  setup.run = async (_command, _args, options) => { environment = options.env; return { stdout: '' }; };
  await setup.nativeRun('/native/tool', ['--version'], { env: { USER: 'foreign-account',
    ANTHROPIC_API_KEY: 'synthetic-test-value', CLAUDE_CONFIG_DIR: '/wrong-namespace' } });
  assert.equal(environment.HOME, home);
  assert.equal(environment.USER, userInfo().username);
  assert.equal(environment.LOGNAME, userInfo().username);
  assert.equal(environment.ANTHROPIC_API_KEY, undefined);
  assert.equal(environment.CLAUDE_CONFIG_DIR, undefined);
});

test('a live watcher pending dependency hold is shown as paused rather than transport startup', async t => {
  const { root, setup } = await fixture(t);
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, mode: 'desktop', allProjects: true, versionPolicy: 'strict' }), { mode: 0o600 });
  await writeFile(join(root, 'watcher-status.json'), JSON.stringify({ mode: 'desktop', pid: process.pid, running: true,
    updatedAt: Date.now(), synchronization: 'blocked', blocked: { scope: 'pending', reason: 'Owned projection has dependent threads.' } }), { mode: 0o600 });
  const report = await setup.inspect();
  const row = report.components.find(item => item.id === 'synchronization');
  assert.equal(row.state, 'blocked');
  assert.match(row.detail, /older snapshot has dependent threads/);
  assert.match(row.detail, /pending transaction.*preserved/);
  assert.equal(row.action, 'diagnostics');
});

test('ordinary native waiting is not a request for user action and retains the exact reason', async t => {
  const { root, setup } = await fixture(t);
  await setup.setup();
  await writeFile(join(root, 'watcher-status.json'), JSON.stringify({ mode: 'desktop', pid: process.pid, running: true,
    updatedAt: Date.now(), foregroundCompletedAt: Date.now(), synchronization: 'waiting',
    waiting: 'Codex destination is active.', folderProjection: { state: 'ready' }, localHandoff: { state: 'ready' } }), { mode: 0o600 });
  const report = await setup.inspect();
  assert.equal(report.phase, 'waiting');
  assert.equal(report.message, 'No setup changes are required. Claudex will continue automatically.');
  assert.equal(report.components.find(item => item.id === 'synchronization').detail, 'Codex destination is active.');
});

test('initial readiness waits for the full sweep when progress fields are present', async t => {
  const { root, setup } = await fixture(t); await setup.setup();
  const status = { mode: 'desktop', pid: process.pid, running: true, updatedAt: Date.now(),
    foregroundCompletedAt: Date.now(), checkingConversationCount: 2, checkedConversationCount: 1,
    initialSweepCompletedAt: null, synchronization: 'ready' };
  await writeFile(join(root, 'watcher-status.json'), JSON.stringify(status), { mode: 0o600 });
  assert.equal((await setup.inspect()).components.find(row => row.id === 'synchronization').state, 'waiting');
  status.initialSweepCompletedAt = Date.now(); status.checkedConversationCount = 2;
  await writeFile(join(root, 'watcher-status.json'), JSON.stringify(status), { mode: 0o600 });
  assert.equal((await setup.inspect()).components.find(row => row.id === 'synchronization').state, 'ready');
});

test('actual runtime faults expose their exact reasons instead of generic setup messages', async t => {
  const { root, setup } = await fixture(t);
  await setup.setup();
  await writeFile(join(root, 'watcher-status.json'), JSON.stringify({ pid: process.pid, running: true, updatedAt: Date.now(),
    synchronization: 'blocked', blocked: { reason: 'Exact prefix conflict' },
    folderProjection: { state: 'error', error: 'Exact frontend resource conflict' },
    localHandoff: { state: 'error', error: 'Exact native identity conflict' } }), { mode: 0o600 });
  const report = await setup.inspect();
  assert.equal(report.phase, 'blocked');
  for (const [id, expected] of [['synchronization', 'Exact prefix conflict'], ['folders', 'Exact frontend resource conflict'], ['handoffs', 'Exact native identity conflict']]) {
    const row = report.components.find(item => item.id === id);
    assert.equal(row.detail, expected);
    assert.equal(row.action, 'diagnostics');
  }
});

test('uncertain collaboration work opens diagnostics instead of retrying setup', async t => {
  const { setup } = await fixture(t);
  setup.collaborationStatus = async () => ({ blockedByUncertainWork: true });
  const row = (await setup.inspect()).components.find(item => item.id === 'collaboration');
  assert.equal(row.state, 'blocked');
  assert.equal(row.action, 'diagnostics');
});
