import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { serveCollaborationSocket, callCollaboration } from '../src/collaboration-transport.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ccwr-')));
  const context = { sessionId: '11111111-1111-4111-8111-111111111111', cwd: root };
  const state = { ...context, phase: 'idle', model: 'fixture-model', effort: 'medium', fingerprint: 'fixture', ownerClientId: 'fixture' };
  let connections = 0;
  const native = { async inspect() { return state; }, async connect() { connections++; return {
    state, initialTurn: null, listen() {}, close() {}, inspect: async () => state,
    preflight: async () => { throw new Error('No native inference in tests.'); },
  }; } };
  const hub = await new CollaborationHub({ root: join(root, 'collaboration'), run: async () => { throw new Error('No model work.'); },
    codexCacheOptions: { native } }).initialize();
  const socket = await serveCollaborationSocket({ root: hub.root, dispatch: e => hub.dispatch(e) });
  t.after(async () => { await socket.close(); await hub.close(); await rm(root, { recursive: true, force: true }); });
  return { root, context, hub, get connections() { return connections; }, call: (action, params = {}, peer = 'codex') =>
    callCollaboration({ root: hub.root, peer, token: hub.controllerToken, method: `codex_cache_warm_${action}`, params }) };
}

test('Codex cache preview/confirm/status/off work over private Unix RPC without native inference', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('list')).policies.length, 0); assert.equal(f.connections, 0);
  await assert.rejects(f.call('prepare', f.context), /consent/);
  const p = await f.call('prepare', { ...f.context, bestEffort: true, refreshMinutes: 20 });
  assert.equal(f.connections, 0);
  await assert.rejects(f.call('confirm', { confirmationId: p.confirmationId, bestEffort: true }, 'claude'), /controller/);
  await assert.rejects(f.call('confirm', { confirmationId: p.confirmationId, bestEffort: true,
    ...f.context, sessionId: '22222222-2222-4222-8222-222222222222' }), /another native chat/);
  const result = await f.call('confirm', { confirmationId: p.confirmationId, bestEffort: true });
  assert.equal(result.policy.provider, 'codex'); assert.equal(result.policy.enabled, true);
  assert.equal(f.connections, 1);
  await assert.rejects(f.call('confirm', { confirmationId: p.confirmationId, bestEffort: true }), /consumed/);
  await assert.rejects(f.call('prepare', { ...f.context, bestEffort: true, sample: {} }), /fields/);
  assert.equal((await f.call('off', f.context)).policy.enabled, false);
  assert.equal((await f.hub.cacheWarm.list()).policies.length, 0, 'Claude policies are independent.');
});

test('Codex warming refuses stopped-app enrollment and worker controllers', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'app-stop.json'), JSON.stringify({ version: 1, stopped: true }), { mode: 0o600 });
  await assert.rejects(f.call('prepare', { ...f.context, bestEffort: true }), /stopped/);
  await f.call('list'); await f.call('off', f.context);
  const actor = f.hub.actor;
  f.hub.actor = () => ({ peer: 'codex', task: { id: 'worker' } });
  try { await assert.rejects(f.hub.dispatch({ method: 'codex_cache_warm_list', params: {} }), /workers/); }
  finally { f.hub.actor = actor; }
});

test('Codex CLI preserves the exact broker root and peer in the confirmation command', async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL('../bin/claudex-collaboration.mjs', import.meta.url));
  const run = promisify(execFile), env = { ...process.env };
  delete env.CLAUDEX_WORK_TOKEN;
  const base = [cli, 'cache-warm'];
  const { stdout } = await run(process.execPath, [...base, 'on', '--provider', 'codex', '--accept-best-effort',
    '--root', f.hub.root, '--peer', 'claude', '--session', f.context.sessionId, '--cwd', f.context.cwd,
    '--refresh-minutes', '1', '--max-minutes', '2'], { env });
  const preview = JSON.parse(stdout);
  assert.ok(preview.confirm.includes(`--root '${f.hub.root}'`)); assert.ok(preview.confirm.includes("--peer 'claude'"));
  assert.equal(preview.refreshMinutes, 1); assert.equal(f.connections, 0);
  await assert.rejects(run(process.execPath, [...base, 'confirm', preview.confirmationId, '--provider', 'codex',
    '--accept-best-effort', '--root', f.hub.root, '--peer', 'claude', '--max-output-tokens', '1'], { env }), /confirmation cannot override/);
  await assert.rejects(run(process.execPath, [...base, 'on', '--provider', 'codex',
    '--root', f.hub.root, '--max-read-tokens', '1'], { env }), /Read-token limits have been removed/);
  const result = await run(process.execPath, [...base, 'confirm', preview.confirmationId, '--provider', 'codex',
    '--accept-best-effort', '--root', f.hub.root, '--peer', 'claude'], { env });
  assert.equal(JSON.parse(result.stdout).policy.enabled, true);
});
