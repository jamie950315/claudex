import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, rm, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { callCollaboration, serveCollaborationSocket } from '../src/collaboration-transport.mjs';

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cwa-'))); await chmod(root, 0o700);
  const hub = await new CollaborationHub({ root, run: async () => assert.fail('No inference'), ...options }).initialize();
  hub.schedule = () => {};
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  const call = (method, params = {}) => hub.dispatch({ peer: 'codex', token: hub.controllerToken, method, params });
  const start = (requestId, prompt = 'Synthetic work') => call('start', { requestId, provider: 'claude', cwd: root, prompt });
  const complete = async task => hub.mutate(state => {
    const value = state.tasks[task.taskId]; value.status = 'completed'; value.revision++; value.generation = 1;
    value.result = { text: 'Preserved result', generation: 1, provider: 'claude', at: Date.now() };
    value.messages.push({ from: 'claude', kind: 'result', text: 'Preserved result', at: Date.now() });
  });
  return { root, hub, call, start, complete };
}
const hash = value => createHash('sha256').update(value).digest('hex');

test('capacity archives complete history and exact request decisions across restart and Unix RPC', async t => {
  const f = await fixture(t, { maxTasks: 1, maxRequests: 1 });
  const first = await f.start('first'); await f.complete(first);
  const saved = structuredClone(f.hub.state.tasks[first.taskId]);
  const second = await f.start('second');
  assert.equal(Object.keys(f.hub.state.tasks).length, 1);
  assert.equal(f.hub.state.tasks[first.taskId], undefined);
  const status = await f.call('status', { taskId: first.taskId });
  assert.equal(status.archived, true); assert.deepEqual(status.messages, saved.messages);
  assert.equal(status.result.text, 'Preserved result');
  assert.deepEqual(status.limits.transitionBudget, { used: 1, remaining: 11 });
  assert.deepEqual(await f.start('first'), { ...first, replayed: true });
  await assert.rejects(f.start('first', 'Different input'), { code: 'CLAUDEX_REQUEST_ID_CONFLICT' });
  const inventory = await f.call('list');
  assert.equal(inventory.inventoryScope, 'active'); assert.equal(inventory.archivedTaskCount, 1);
  assert.equal(inventory.limits.capacity.tasks.used, 1); assert.equal(inventory.limits.capacity.tasks.remaining, 0);
  assert.equal(inventory.limits.capacity.requests.used, 1); assert.equal(inventory.limits.archive.requests, 1);
  await f.hub.close();
  const reopened = await new CollaborationHub({ root: f.root, maxTasks: 1, maxRequests: 1,
    run: async () => assert.fail('No inference') }).initialize(); reopened.schedule = () => {};
  t.after(() => reopened.close());
  const server = await serveCollaborationSocket({ root: f.root, dispatch: input => reopened.dispatch(input) });
  t.after(() => server.close());
  const rpc = (method, params) => callCollaboration({ root: f.root, peer: 'codex', token: reopened.controllerToken, method, params });
  const result = await rpc('wait', { targets: [{ taskId: first.taskId }, { taskId: second.taskId }], timeoutMs: 0 });
  assert.equal(result.tasks[0].result.text, 'Preserved result'); assert.equal(result.tasks[0].archived, true);
  const replay = await rpc('start', { requestId: 'first', provider: 'claude', cwd: f.root, prompt: 'Synthetic work' });
  assert.deepEqual(replay, { ...first, replayed: true });
});

test('request-only pressure archives receipts without retiring active tasks or weakening conflicts', async t => {
  const f = await fixture(t, { maxRequests: 1 });
  const task = await f.start('running');
  const receipt = await f.call('cancel', { taskId: task.taskId, requestId: 'cancel' });
  assert.equal(receipt.status, 'cancelled'); assert.equal(Object.keys(f.hub.state.tasks).length, 1);
  assert.equal((await f.start('running')).replayed, true);
  await assert.rejects(f.start('running', 'Changed'), { code: 'CLAUDEX_REQUEST_ID_CONFLICT' });
  assert.equal((await f.call('cancel', { taskId: task.taskId, requestId: 'cancel' })).replayed, true);
});

test('byte pressure archives only settled old trees and reports compact used bytes', async t => {
  const f = await fixture(t, { maxStateBytes: 7000 });
  const first = await f.start('large-one', 'x'.repeat(3000)); await f.complete(first);
  const second = await f.start('large-two', 'y'.repeat(3000));
  assert.equal((await f.call('status', { taskId: first.taskId })).archived, true);
  assert.ok(f.hub.state.tasks[second.taskId]);
  const capacity = (await f.call('list')).limits.capacity;
  assert.equal(capacity.bytes.used, Buffer.byteLength(JSON.stringify(f.hub.state)));
  assert.equal(capacity.bytes.remaining, 7000 - capacity.bytes.used);
});

for (const status of ['ready', 'waiting', 'paused', 'uncertain']) test(`${status} work is pinned and capacity refusal is typed and atomic`, async t => {
  const f = await fixture(t, { maxTasks: 1 });
  const first = await f.start('pinned');
  await f.hub.mutate(state => { state.tasks[first.taskId].status = status; });
  const saved = JSON.stringify(f.hub.state);
  await assert.rejects(f.start('overflow'), { code: 'CLAUDEX_WORK_CAPACITY_EXHAUSTED' });
  assert.equal(JSON.stringify(f.hub.state), saved);
});

test('a settled root and children archive together and a follow-up restores their original contracts', async t => {
  const f = await fixture(t, { maxTasks: 3 });
  const first = await f.start('tree-root'); await f.complete(first);
  const childId = '22222222-2222-4222-8222-222222222222';
  await f.hub.mutate(state => { state.tasks[childId] = { ...structuredClone(state.tasks[first.taskId]),
    id: childId, parentId: first.taskId, depth: 1, returnTo: first.taskId }; });
  const filler = await f.start('filler'); await f.complete(filler);
  const live = await f.start('live');
  assert.equal((await f.call('status', { taskId: childId })).archived, true);
  assert.equal((await f.call('status', { taskId: first.taskId })).children[0].taskId, childId);
  await f.call('cancel', { taskId: live.taskId, requestId: 'close-live' });
  const follow = await f.call('send', { taskId: childId, message: 'Continue this child', requestId: 'follow' });
  assert.equal(follow.status, 'ready');
  assert.equal(f.hub.state.tasks[childId].parentId, first.taskId);
  assert.equal(f.hub.state.tasks[first.taskId].status, 'completed');
  assert.equal(f.hub.state.tasks[childId].messages.at(-1).text, 'Continue this child');
});

test('unsafe exact archive lookup refuses without replacing evidence or replaying a request', async t => {
  const f = await fixture(t, { maxRequests: 1 });
  const first = await f.start('safe'); await f.complete(first); await f.start('other');
  const key = hash('controller:codex:safe');
  const path = join(f.root, 'work-archive', 'requests', `${key}.json`);
  const original = await readFile(path, 'utf8');
  await rm(path); await symlink(join(f.root, 'work.json'), path);
  const state = JSON.stringify(f.hub.state);
  await assert.rejects(f.start('safe'));
  assert.equal(JSON.stringify(f.hub.state), state);
  assert.ok(original.includes(first.taskId));
});

test('interrupted archive publication leaves committed active history and exact replay intact', async t => {
  const f = await fixture(t, { maxTasks: 1 });
  const first = await f.start('before-interrupt'); await f.complete(first);
  const before = JSON.stringify(f.hub.state), publish = f.hub.workArchive.saveTree.bind(f.hub.workArchive);
  f.hub.workArchive.saveTree = async (...args) => { await publish(...args); throw new Error('Synthetic crash before active commit'); };
  await assert.rejects(f.start('interrupted'), /Synthetic crash/);
  assert.equal(JSON.stringify(f.hub.state), before);
  assert.equal((await f.call('status', { taskId: first.taskId })).archived, false);
  assert.equal((await f.start('before-interrupt')).replayed, true);
  f.hub.workArchive.saveTree = publish;
  await f.start('after-interrupt');
  assert.equal((await f.call('status', { taskId: first.taskId })).archived, true);
});

test('origin verification and uncertain native delivery pin otherwise settled work', async t => {
  const f = await fixture(t, { maxTasks: 1, originVerifier: async input => input });
  const first = await f.start('pending-proof'); await f.complete(first);
  const saved = JSON.stringify(f.hub.state);
  await assert.rejects(f.start('new-proof'), { code: 'CLAUDEX_WORK_CAPACITY_EXHAUSTED' });
  assert.equal(JSON.stringify(f.hub.state), saved);
  await f.hub.mutate(state => {
    const n = state.tasks[first.taskId].notification; n.challengeExpiresAt = Date.now() - 1;
    n.deliveries.push({ revision: 1, createdAt: Date.now() - 120000, expiresAt: Date.now() - 1000,
      state: 'uncertain', requestId: 'preserve-uncertain' });
  });
  await assert.rejects(f.start('new-uncertain'), { code: 'CLAUDEX_WORK_CAPACITY_EXHAUSTED' });
  assert.equal(f.hub.state.tasks[first.taskId].notification.deliveries[0].state, 'uncertain');
});

test('compact writes restart at the byte limit without pretty-print overhead', async t => {
  const f = await fixture(t, { maxStateBytes: 6000 });
  await f.start('compact', 'x'.repeat(4000));
  const text = await readFile(join(f.root, 'work.json'), 'utf8');
  assert.equal(text, JSON.stringify(f.hub.state) + '\n');
  await f.hub.close();
  const reopened = await new CollaborationHub({ root: f.root, maxStateBytes: 6000,
    run: async () => assert.fail('No inference') }).initialize(); reopened.schedule = () => {};
  t.after(() => reopened.close());
  assert.equal(Object.keys(reopened.state.tasks).length, 1);
});
