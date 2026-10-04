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
  assert.equal(result.result.providers.codex, 'unsupported');
  assert.deepEqual(result.result.policies, []);
});
