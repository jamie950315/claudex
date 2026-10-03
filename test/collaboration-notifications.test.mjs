import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { drainNotifications, notificationPolicy } from '../src/collaboration-notifications.mjs';
import { writeJSON } from '../src/storage.mjs';
import { serveCollaborationSocket, callCollaboration } from '../src/collaboration-transport.mjs';

const sessionId = '11111111-1111-4111-8111-111111111111';
const otherSession = '22222222-2222-4222-8222-222222222222';
async function fixture(t, { verifier, ...options } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'cn-')));
  await chmod(parent, 0o700);
  const root = join(parent, 'collaboration'); await mkdir(root, { mode: 0o700 });
  const proofs = [];
  const verify = verifier ?? (async p => { proofs.push(p); return { provider: p.provider, sessionId: p.sessionId,
    cwd: p.cwd, toolUseId: p.toolUseId, turnId: p.turnId, source: 'synthetic-native-proof', verifiedAt: Date.now() }; });
  const hub = await new CollaborationHub({ root, originVerifier: verify,
    run: async () => { throw new Error('No inference allowed in notification tests'); }, ...options }).initialize();
  hub.schedule = () => {};
  t.after(async () => { await hub.close(); await rm(parent, { recursive: true, force: true }); });
  const call = (method, params = {}, peer = 'codex', token = hub.controllerToken) => hub.dispatch({ method, params, peer, token });
  const start = (requestId, notifications = { mode: 'queue' }) => call('start', {
    provider: 'claude', cwd: parent, prompt: 'Synthetic delegated work', requestId, notifications,
  });
  const bind = task => call('origin_bind', { taskId: task.taskId, sessionId, cwd: parent, toolUseId: `call-${task.taskId}`, turnId: 'turn-1' });
  const complete = async task => { await hub.mutate(state => { const value = state.tasks[task.taskId]; value.status = 'completed'; value.revision++; }); };
  await hub.chatMailbox.hook({ provider: 'codex', sessionId, cwd: parent, event: 'SessionStart' });
  return { hub, root, parent, call, start, bind, complete, proofs };
}
async function until(check) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(5); }
  throw new Error('Synthetic notification did not settle');
}

test('opt-in blocker notifications deduplicate transitions, omit content and ignore ordinary revisions', async t => {
  const f = await fixture(t); const task = await f.start('blocker'); await f.bind(task);
  await f.hub.mutate(state => {
    const value = state.tasks[task.taskId]; value.generation = 1;
    value.observability = { timeline: 'off', reports: 'off', blockerNotifications: true };
    value.blockers = [{ id: 'decision-one', generation: 1, revision: 3, state: 'open',
      question: 'PRIVATE QUESTION', impact: 'PRIVATE IMPACT', needs: 'PRIVATE NEED', updatedAt: Date.now() }];
  });
  await until(() => f.hub.state.tasks[task.taskId].notification.deliveries[0]?.state === 'queued');
  const first = f.hub.state.tasks[task.taskId].notification.deliveries[0];
  assert.equal(first.kind, 'blocker'); assert.equal(first.blockerId, 'decision-one');
  const message = await f.call('chat_status', { messageId: first.messageId });
  assert.doesNotMatch(JSON.stringify(message), /PRIVATE/);
  assert.equal(message.wakeRequested, false);
  await f.hub.mutate(state => { state.tasks[task.taskId].revision++; });
  await delay(20);
  assert.equal(f.hub.state.tasks[task.taskId].notification.deliveries.length, 1);
  await f.hub.mutate(state => { state.tasks[task.taskId].blockers[0].state = 'resolved'; });
  await f.hub.mutate(state => {
    const value = state.tasks[task.taskId]; value.generation = 2;
    value.blockers.push({ ...value.blockers[0], id: 'old-generation', state: 'open' });
  });
  await delay(20);
  assert.equal(f.hub.state.tasks[task.taskId].notification.deliveries.length, 1);
  await f.complete(task);
  await until(() => f.hub.state.tasks[task.taskId].notification.deliveries[1]?.state === 'queued');
  assert.equal(f.hub.state.tasks[task.taskId].notification.deliveries[1].kind, 'terminal');
});

test('blocker notifications require separate opt-in and revoke an awaited dispatch after response', async t => {
  let release;
  const f = await fixture(t, { nativeChatDiscovery: () => new Promise(resolve => {
    release = () => resolve([{ provider: 'codex', sessionId, cwd: f.parent }]);
  }) });
  const task = await f.start('blocker-fence'); await f.bind(task);
  await f.hub.mutate(state => {
    const value = state.tasks[task.taskId]; value.generation = 1;
    value.blockers = [{ id: 'decision', generation: 1, revision: 3, state: 'open', updatedAt: Date.now() }];
  });
  await delay(20); assert.equal(release, undefined);
  await f.hub.mutate(state => {
    state.tasks[task.taskId].observability = { timeline: 'off', reports: 'off', blockerNotifications: true };
  });
  await until(() => release);
  await f.hub.mutate(state => { state.tasks[task.taskId].blockers[0].state = 'responded'; });
  release(); await drainNotifications(f.hub);
  const delivery = f.hub.state.tasks[task.taskId].notification.deliveries[0];
  assert.equal(delivery.state, 'failed'); assert.equal(delivery.reason, 'blocker-superseded');
  assert.equal(delivery.messageId, undefined);
});

test('multiple rate-limited blockers retain individual suppression without rescheduling storms', async t => {
  const f = await fixture(t); const task = await f.start('blocker-quota'); await f.bind(task);
  await f.hub.mutate(state => {
    const value = state.tasks[task.taskId]; value.generation = 1;
    value.observability = { timeline: 'off', reports: 'off', blockerNotifications: true };
    value.notification.deliveries = Array.from({ length: 16 }, (_, i) => ({ revision: i + 1,
      state: 'queued', createdAt: Date.now(), expiresAt: Date.now() + 600000, requestId: `quota-${i}` }));
    value.blockers = ['one', 'two', 'three'].map(id => ({ id, generation: 1, revision: 1, state: 'open', updatedAt: Date.now() }));
  });
  await until(() => Object.keys(f.hub.state.tasks[task.taskId].notification.suppressedBlockers ?? {}).length === 3);
  await drainNotifications(f.hub);
  assert.equal(f.hub.state.tasks[task.taskId].notification.deliveries.length, 16);
  assert.deepEqual(f.hub.state.tasks[task.taskId].notification.suppressedBlockers, { '1:one': 1, '1:two': 1, '1:three': 1 });
});

test('default-off and unbound tasks never notify; exact root proof queues only once over Unix RPC', async t => {
  const f = await fixture(t);
  const off = await f.start('off', { mode: 'off' }), task = await f.start('queue');
  // Explicit off is the same as omitted policy at the production boundary.
  const disabled = await f.call('start', { provider: 'claude', cwd: f.parent, prompt: 'off', requestId: 'default-off' });
  assert.equal(disabled.originChallenge, undefined);
  await f.complete(task); await delay(10);
  assert.equal((await f.call('status', { taskId: task.taskId })).notification.bindingStatus, 'awaiting-native-proof');
  assert.equal(f.hub.state.tasks[task.taskId].notification.deliveries.length, 0);
  const server = await serveCollaborationSocket({ root: f.root, dispatch: envelope => f.hub.dispatch(envelope) });
  t.after(() => server.close());
  const params = { taskId: task.taskId, sessionId, cwd: f.parent, toolUseId: `call-${task.taskId}`, turnId: 'turn-1' };
  await callCollaboration({ root: f.root, peer: 'codex', token: f.hub.controllerToken, method: 'origin_bind', params });
  await until(() => f.hub.state.tasks[task.taskId].notification.deliveries[0]?.state === 'queued');
  const value = await f.call('status', { taskId: task.taskId });
  assert.equal(value.notification.deliveries.length, 1); assert.equal(value.notification.challenge, undefined);
  const message = await f.call('chat_status', { messageId: value.notification.deliveries[0].messageId });
  assert.equal(message.wakeRequested, false); assert.equal(message.targetSessionId, sessionId);
  assert.equal(message.state, 'queued');
  assert.equal(f.proofs[0].expectedReceipt.originChallenge, task.originChallenge);
  assert.equal((await f.bind(task)).replayed, true);
  assert.equal(f.proofs.length, 1);
  await assert.rejects(f.call('origin_bind', { ...params, sessionId: otherSession }), { code: 'CLAUDEX_ORIGIN_CONFLICT' });
  await assert.rejects(f.bind(disabled), { code: 'CLAUDEX_ORIGIN_UNAVAILABLE' });
  assert.equal(f.hub.running.size, 0); assert.equal(f.hub.state.tasks[off.taskId].notification, undefined);
});

test('unverified or late native proof cannot bind or notify after shutdown, expiry or app-stop', async t => {
  let finish;
  const f = await fixture(t, { verifier: p => new Promise(resolve => { finish = () => resolve({ ...p, source: 'synthetic', verifiedAt: Date.now() }); }) });
  const task = await f.start('late');
  const binding = f.bind(task);
  await until(() => finish);
  await writeJSON(join(f.parent, 'app-stop.json'), { version: 1, stopped: true });
  finish(); await assert.rejects(binding, { code: 'CLAUDEX_ORIGIN_EXPIRED' });
  assert.equal(f.hub.state.tasks[task.taskId].notification.origin, null);
  await writeJSON(join(f.parent, 'app-stop.json'), { version: 1, stopped: false });
  await f.hub.mutate(state => { state.tasks[task.taskId].notification.challengeExpiresAt = 1; });
  await assert.rejects(f.bind(task), { code: 'CLAUDEX_ORIGIN_EXPIRED' });
  const noVerifier = await fixture(t, { originVerifier: null });
  await assert.rejects(noVerifier.start('unsupported'), { code: 'CLAUDEX_ORIGIN_UNAVAILABLE' });
});

test('a mismatched native proof and worker capability cannot borrow controller notification authority', async t => {
  const f = await fixture(t, { verifier: async p => ({ ...p, sessionId: otherSession, source: 'synthetic', verifiedAt: Date.now() }) });
  const task = await f.start('mismatch');
  await assert.rejects(f.bind(task), { code: 'CLAUDEX_ORIGIN_REFUSED' });
  const { createHash } = await import('node:crypto'); const token = 'a'.repeat(64);
  await f.hub.mutate(state => {
    const value = state.tasks[task.taskId]; value.status = 'running'; value.owner = 'codex'; value.generation = 1;
    value.active = { generation: 1, messageCount: 1, tokenHash: createHash('sha256').update(token).digest('hex') };
  });
  await assert.rejects(f.call('origin_bind', { taskId: task.taskId, sessionId, cwd: f.parent, toolUseId: 'call-1' }, 'codex', token), { code: 'CLAUDEX_ORIGIN_REFUSED' });
  await assert.rejects(f.call('start', { provider: 'claude', cwd: f.parent, prompt: 'child', requestId: 'child', notifications: { mode: 'wake' } }, 'codex', token), { code: 'CLAUDEX_ORIGIN_UNAVAILABLE' });
});

test('lost notification responses and restart retain uncertainty without replay', async t => {
  const f = await fixture(t); const task = await f.start('lost');
  await f.bind(task);
  const dispatch = f.hub.dispatch.bind(f.hub); let sends = 0;
  f.hub.dispatch = async envelope => {
    if (envelope.method !== 'chat_send') return dispatch(envelope);
    sends++; await dispatch(envelope); throw new Error('Synthetic response loss after durable enqueue');
  };
  await f.complete(task);
  await until(() => f.hub.state.tasks[task.taskId].notification.deliveries[0]?.state === 'uncertain');
  await f.hub.close();
  const reopened = await new CollaborationHub({ root: f.root, originVerifier: async () => { throw new Error('No proof replay'); }, run: async () => { throw new Error('No inference'); } }).initialize();
  t.after(() => reopened.close());
  await delay(10);
  assert.equal(sends, 1);
  assert.equal(reopened.state.tasks[task.taskId].notification.deliveries[0].state, 'uncertain');
  assert.equal(reopened.state.tasks[task.taskId].notification.deliveries.length, 1);
});

test('interrupted write-ahead dispatch is uncertain on restart and same-origin storms are bounded', async t => {
  const f = await fixture(t);
  const tasks = [];
  for (let i = 0; i < 18; i++) { const task = await f.start(`storm-${i}`); await f.bind(task); tasks.push(task); }
  await f.hub.mutate(state => { for (const task of tasks) { state.tasks[task.taskId].status = 'completed'; state.tasks[task.taskId].revision++; } });
  await until(() => Object.values(f.hub.state.tasks).every(task => task.notification.deliveries[0]?.state === 'queued' || task.notification.suppressedRevision));
  assert.equal(Object.values(f.hub.state.tasks).flatMap(task => task.notification.deliveries).length, 16);
  assert.equal(Object.values(f.hub.state.tasks).filter(task => task.notification.suppressedRevision).length, 2);
  await drainNotifications(f.hub);
  await f.hub.mutate(state => { state.tasks[tasks[0].taskId].notification.deliveries[0].state = 'dispatching'; });
  await f.hub.close();
  const reopened = await new CollaborationHub({ root: f.root, run: async () => { throw new Error('No inference'); } }).initialize();
  t.after(() => reopened.close());
  assert.equal(reopened.state.tasks[tasks[0].taskId].notification.deliveries[0].state, 'uncertain');
  assert.equal(reopened.state.tasks[tasks[0].taskId].notification.deliveries.length, 1);
});

test('wake is explicit, preserves native refusal, and ended origins use ordinary resume boundaries', async t => {
  let wakes = 0;
  const f = await fixture(t, { chatWake: async () => { wakes++; return { status: 'busy' }; } });
  const queue = await f.start('queue'), wake = await f.start('wake', { mode: 'wake', expiresInMs: 1000 });
  await f.bind(queue); await f.bind(wake);
  await f.hub.chatMailbox.hook({ provider: 'codex', sessionId, cwd: f.parent, event: 'SessionEnd' });
  await f.complete(queue); await f.complete(wake);
  await until(() => [queue, wake].every(task => f.hub.state.tasks[task.taskId].notification.deliveries[0]?.state === 'queued'));
  assert.equal(wakes, 1);
  const receipt = await f.call('chat_status', { messageId: f.hub.state.tasks[queue.taskId].notification.deliveries[0].messageId });
  assert.equal(receipt.deliveryStatus, 'waiting-for-resume');
  assert.throws(() => notificationPolicy({ mode: 'wake', expiresInMs: 3600001 }), { code: 'CLAUDEX_INVALID_NOTIFICATION_POLICY' });
});

test('app-stop holds wait for an actual marker release instead of spinning or dropping notification work', async t => {
  const f = await fixture(t); const task = await f.start('hold'); await f.bind(task);
  await writeJSON(join(f.parent, 'app-stop.json'), { version: 1, stopped: true });
  await f.complete(task); await delay(25);
  assert.equal(f.hub.state.tasks[task.taskId].notification.deliveries.length, 0);
  await writeJSON(join(f.parent, 'app-stop.json'), { version: 1, stopped: false });
  await until(() => f.hub.state.tasks[task.taskId].notification.deliveries[0]?.state === 'queued');
  assert.equal(f.hub.state.tasks[task.taskId].notification.deliveries.length, 1);
});

test('stopping during awaited native preflight cannot dispatch a notification wake', async t => {
  let release, dispatches = 0;
  const f = await fixture(t, { chatWake: () => new Promise(resolve => { release = () => resolve({ status: 'ready',
    dispatch: async () => { dispatches++; return { status: 'accepted', turnId: 'never' }; } }); }) });
  const task = await f.start('stopped-wake', { mode: 'wake' }); await f.bind(task); await f.complete(task);
  await until(() => release);
  await writeJSON(join(f.parent, 'app-stop.json'), { version: 1, stopped: true });
  release(); await drainNotifications(f.hub);
  assert.equal(dispatches, 0);
});

test('an absolute notification deadline is not extended by slow native discovery', async t => {
  let release;
  const f = await fixture(t, { nativeChatDiscovery: () => new Promise(resolve => {
    release = () => resolve([{ provider: 'codex', sessionId, cwd: f.parent }]);
  }) });
  const task = await f.start('expired-discovery', { mode: 'queue', expiresInMs: 1000 });
  await f.bind(task); await f.complete(task); await until(() => release);
  await delay(1050); release(); await drainNotifications(f.hub);
  const notification = f.hub.state.tasks[task.taskId].notification;
  assert.equal(notification.deliveries[0].messageId, undefined);
  assert.equal((await f.hub.chatMailbox.pendingWakes()).length, 0);
});

test('native flush gaps retain identity hints and only matching lifecycle events recheck bounded proof', async t => {
  let available = false, attempts = 0;
  const f = await fixture(t, { verifier: async p => {
    attempts++;
    if (!available) throw Object.assign(new Error('native result not flushed'), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
    return { provider: p.provider, sessionId: p.sessionId, cwd: p.cwd, toolUseId: p.toolUseId,
      turnId: p.turnId, source: 'synthetic-native-proof', verifiedAt: Date.now() };
  } });
  const task = await f.start('flush'); await f.complete(task);
  assert.equal((await f.bind(task)).bound, false);
  await delay(15); assert.equal(attempts, 1, 'no polling rechecks');
  assert.equal((await f.call('origin_recheck', { sessionId: otherSession, cwd: f.parent, event: 'Stop' })).checked, 0);
  available = true;
  const result = await f.call('origin_recheck', { sessionId, cwd: f.parent, event: 'Stop' });
  assert.equal(result.results[0].bound, true);
  await until(() => f.hub.state.tasks[task.taskId].notification.deliveries[0]?.state === 'queued');
  assert.equal(attempts, 2);
  assert.equal((await f.call('origin_recheck', { sessionId, cwd: f.parent, event: 'SessionStart' })).checked, 0);
  const exhausted = await f.start('flush-limit'); available = false;
  await f.bind(exhausted);
  await f.call('origin_recheck', { sessionId, cwd: f.parent, event: 'Stop' });
  await f.call('origin_recheck', { sessionId, cwd: f.parent, event: 'UserPromptSubmit' });
  const before = attempts;
  assert.equal((await f.call('origin_recheck', { sessionId, cwd: f.parent, event: 'SessionStart' })).checked, 0);
  assert.equal(attempts, before); assert.equal(f.hub.state.tasks[exhausted.taskId].notification.origin, null);
});
