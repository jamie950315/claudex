import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { serveCollaborationSocket, callCollaboration } from '../src/collaboration-transport.mjs';
import { createModBridge } from '../src/claude-mod-bridge.mjs';
import { stageClaudeMod, MOD_STAGE_FILES } from '../src/claude-mod-install.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cwr-')));
  const cwd = join(root, 'project'); await mkdir(cwd, { mode: 0o700 });
  const collaboration = join(root, 'collaboration');
  const hub = await new CollaborationHub({ root: collaboration, run: async () => { throw new Error('No model work in tests.'); } }).initialize();
  const transport = await serveCollaborationSocket({ root: collaboration, dispatch: e => hub.dispatch(e) });
  t.after(async () => { await transport.close(); await hub.close(); await rm(root, { recursive: true, force: true }); });
  const context = { sessionId: '11111111-1111-4111-8111-111111111111', cwd };
  const bridge = createModBridge({ root });
  const call = (action, params = {}) => bridge({ version: 1, op: 'cache-warm', context, action, params });
  return { root, cwd, hub, context, call, rpc: (method, params = {}, peer = 'claude') =>
    callCollaboration({ root: collaboration, token: hub.controllerToken, peer, method, params }) };
}

test('cache warming uses real Unix RPC, stays default-off, and binds companion context', async t => {
  const f = await fixture(t), now = Date.now();
  const observation = { instanceId: 'fixture-instance', sequence: 1, phase: 'idle', epoch: 1,
    sample: { id: 'native-response-1', startedAt: now - 1500, completedAt: now - 500,
      model: 'claude-sonnet-5-5', effort: 'medium', ttlMs: 300000, ttlSource: 'native-setting',
      inputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 4000, outputTokens: 4, stopReason: 'end_turn' } };
  const first = await f.call('observe', observation);
  assert.notEqual(first.policy?.enabled, true);
  await assert.rejects(f.call('configure', { provider: 'claude', sessionId: '22222222-2222-4222-8222-222222222222',
    cwd: f.cwd, enabled: true, requestId: 'wrong-context' }), { code: 'CONTEXT_CHANGED' });
  const configured = await f.call('configure', { enabled: true, requestId: 'explicit-confirmation', ttl: '5m',
    maxMinutes: 60, maxRefreshes: 3, maxReadTokens: 250000, maxOutputTokens: 256 });
  assert.equal(configured.policy.enabled, true);
  assert.equal(configured.policy.ttlPreference, '5m');
  assert(Number.isSafeInteger(configured.nextAt));
  const repeated = await f.call('configure', { enabled: true, requestId: 'explicit-confirmation', ttl: '5m',
    maxMinutes: 60, maxRefreshes: 3, maxReadTokens: 250000, maxOutputTokens: 256 });
  assert.deepEqual(repeated.policy, configured.policy);
  assert.equal((await f.call('claim', { instanceId: 'fixture-instance', epoch: 1 })).claimed, false);
  assert.equal((await f.call('check', { instanceId: 'fixture-instance', epoch: 1, attemptId: 'missing' })).ready, false);
  const list = await f.call('list');
  assert.equal(list.policies.length, 1);
  assert.equal(list.policies[0].sessionId, f.context.sessionId);
  await assert.rejects(f.rpc('cache_warm_observe', { ...f.context, ...observation }, 'codex'));
  const disabled = await f.call('configure', { enabled: false, requestId: 'explicit-stop' });
  assert.equal(disabled.policy.enabled, false);
});

test('application stop blocks warming but permits status, disable and ended observations', async t => {
  const f = await fixture(t);
  await f.call('observe', { instanceId: 'fixture-instance', sequence: 1, phase: 'idle', epoch: 1 });
  await writeFile(join(f.root, 'app-stop.json'), JSON.stringify({ version: 1, stopped: true }), { mode: 0o600 });
  await assert.rejects(f.call('claim', { instanceId: 'fixture-instance', epoch: 1 }), { code: 'APP_STOPPED' });
  await f.call('list');
  assert.equal((await f.call('configure', { enabled: false, requestId: 'stop-while-held' })).policy.enabled, false);
  await f.call('observe', { instanceId: 'fixture-instance', sequence: 2, phase: 'ended', epoch: 2 });
});

test('the default warming limit is one broker setting for the Mod, Codex and the app', async t => {
  const f = await fixture(t), unsaved = { ttlPreference: null, ttlLastChoice: null };
  assert.deepEqual(await f.call('settings'), { defaultLimit: 'for=4h', saved: false, ...unsaved });
  assert.deepEqual(await f.rpc('cache_warm_settings', {}, 'codex'), { defaultLimit: 'for=4h', saved: false, ...unsaved });
  assert.deepEqual(await f.call('settings', { defaultLimit: 'rounds=12' }), { defaultLimit: 'rounds=12', saved: true, ...unsaved });
  assert.deepEqual(await f.rpc('cache_warm_settings', {}, 'codex'), { defaultLimit: 'rounds=12', saved: true, ...unsaved });
  for (const defaultLimit of ['until=11:18:30', 'for=200h', 'rounds=0', 'ttl=1h', '', null, 4])
    await assert.rejects(f.rpc('cache_warm_settings', { defaultLimit }), /limit|Limits|fits/i);
  await assert.rejects(f.rpc('cache_warm_settings', { defaultLimit: 'for=8h', enabled: true }), /Unsupported/);
  assert.equal((await f.rpc('cache_warm_settings')).defaultLimit, 'rounds=12');
  // The Claude Code startup TTL preference is kept beside it, with its remembered choice.
  const remember = { version: 1, mode: 'remember', ttl: '1h', revision: 'warm-fixture-1' };
  assert.deepEqual((await f.call('settings', { ttlPreference: remember })).ttlPreference, remember);
  await assert.rejects(f.call('settings', { ttlLastChoice: { revision: 'warm-other', ttl: '5m' } }), /does not belong/);
  assert.deepEqual((await f.call('settings', { ttlLastChoice: { revision: 'warm-fixture-1', ttl: '5m' } })).ttlLastChoice, { revision: 'warm-fixture-1', ttl: '5m' });
  const fixed = await f.rpc('cache_warm_settings', { ttlPreference: { version: 1, mode: 'default', ttl: '5m' } }, 'codex');
  assert.deepEqual(fixed.ttlPreference, { version: 1, mode: 'default', ttl: '5m' }); assert.equal(fixed.ttlLastChoice, null);
  await assert.rejects(f.call('settings', { ttlLastChoice: { revision: 'warm-fixture-1', ttl: '5m' } }), /does not belong/);
  for (const ttlPreference of [null, 'default', { version: 1, mode: 'default' }, { version: 1, mode: 'session', ttl: '1h' }, { version: 2, mode: 'session' }, { version: 1, mode: 'remember', ttl: '1h' }])
    await assert.rejects(f.rpc('cache_warm_settings', { ttlPreference }), /preference/i);
  assert.equal((await f.rpc('cache_warm_settings')).defaultLimit, 'rounds=12');
  // Saving a default enrolls nothing, and reading it stays possible while the app is stopped.
  assert.equal((await f.call('list')).policies.length, 0);
  await writeFile(join(f.root, 'app-stop.json'), JSON.stringify({ version: 1, stopped: true }), { mode: 0o600 });
  assert.equal((await f.call('settings')).defaultLimit, 'rounds=12');
  await assert.rejects(f.call('settings', { defaultLimit: 'for=1h' }), { code: 'APP_STOPPED' });
  await assert.rejects(f.call('settings', { ttlPreference: { version: 1, mode: 'session' } }), { code: 'APP_STOPPED' });
  const old = f.hub.actor;
  f.hub.actor = () => ({ peer: 'claude', task: { id: 'worker' } });
  try { await assert.rejects(f.hub.dispatch({ method: 'cache_warm_settings', params: {}, peer: 'claude', token: 'unused' }), /external controller/); }
  finally { f.hub.actor = old; }
});

test('worker capability cannot configure native cache warming', async t => {
  const f = await fixture(t);
  const old = f.hub.actor;
  f.hub.actor = () => ({ peer: 'claude', task: { id: 'worker' } });
  try { await assert.rejects(f.hub.dispatch({ method: 'cache_warm_configure', params: {}, peer: 'claude', token: 'unused' }), /external controller/); }
  finally { f.hub.actor = old; }
});

test('staged cache-warm helper reads the actual Unix broker after its source copy is removed', async t => {
  const f = await fixture(t), source = join(f.root, 'source'), output = join(f.root, 'stage');
  const repo = fileURLToPath(new URL('..', import.meta.url));
  for (const relative of MOD_STAGE_FILES) {
    const target = join(source, relative);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(repo, relative), target);
  }
  const staged = await stageClaudeMod({ repoRoot: source, output, stateRoot: f.root,
    nodeBinary: await realpath(process.execPath) });
  await rm(source, { recursive: true, force: true });
  const request = { version: 1, op: 'cache-warm', action: 'list', context: f.context, params: {} };
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(staged.plugin, 'runtime/bin/claudex-mod-bridge.mjs'), '--root', f.root],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDEX_COLLABORATION_WORKER: '' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify(request));
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.providers.codex, 'experimental-best-effort-separate-controller');
  assert.deepEqual(result.result.policies, []);
});
