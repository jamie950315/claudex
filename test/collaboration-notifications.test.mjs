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

test('reviewing or closing a completed result does not create another completion wake or unread result', async t => {
  const f = await fixture(t); const task = await f.start('completed-annotation'); await f.bind(task);
  await f.hub.mutate(state => {
    const value = state.tasks[task.taskId]; value.generation = 1; value.status = 'completed'; value.revision++;
    value.result = { text: 'Synthetic result', generation: 1, provider: 'claude', at: Date.now() };
    value.blockers = [{ id: 'decision', generation: 1, revision: 1, state: 'open',
      question: 'Synthetic question', impact: 'Synthetic impact', needs: 'Synthetic decision', updatedAt: Date.now() }];
  });
  await until(() => f.hub.state.tasks[task.taskId].notification.deliveries[0]?.state === 'queued');
  const before = f.hub.state.tasks[task.taskId];
  await f.call('work_control', { taskId: task.taskId, generation: 1, action: 'resolve-blocker', blockerId: 'decision',
    text: 'The controller independently resolved the question.', requestId: 'close-decision' });
  await f.call('work_control', { taskId: task.taskId, generation: 1, action: 'review-result', decision: 'reviewed', requestId: 'review-result' });
  await delay(25); await drainNotifications(f.hub);
  const after = f.hub.state.tasks[task.taskId];
  assert.equal(after.blockers[0].state, 'resolved'); assert.equal(after.resultReview.state, 'reviewed');
  assert.equal(after.revision, before.revision, 'completion revision is the same result, not new work');
  assert.equal(after.updatedAt, before.updatedAt, 'annotations do not extend the completion notification lifetime');
  assert.equal(after.notification.deliveries.length, 1);
});

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

test('explicit off and unbound tasks never notify; exact root proof queues only once over Unix RPC', async t => {
  const f = await fixture(t);
  const off = await f.start('off', { mode: 'off' }), task = await f.start('queue');
  assert.equal(off.originChallenge, undefined);
  assert.deepEqual((await f.call('status', { taskId: off.taskId })).notification, { mode: 'off' });
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
  await assert.rejects(f.bind(off), { code: 'CLAUDEX_ORIGIN_UNAVAILABLE' });
  assert.equal(f.hub.running.size, 0); assert.equal(f.hub.state.tasks[off.taskId].notification, undefined);
});

test('external root omission defaults to visible wake with the existing expiry and exact proof', async t => {
  let wakes = 0;
  const f = await fixture(t, { chatWake: async () => { wakes++; return { status: 'busy' }; } });
  const params = { provider: 'claude', cwd: f.parent, prompt: 'Default completion wake', requestId: 'default-wake' };
  const task = await f.call('start', params);
  assert.equal(task.notificationMode, 'wake');
  assert.match(task.originChallenge, /^[a-f0-9]{64}$/);
  assert.deepEqual(notificationPolicy(), { mode: 'wake', expiresInMs: 600000 });
  assert.equal((await f.call('status', { taskId: task.taskId })).notification.expiresInMs, 600000);
  assert.equal((await f.call('start', params)).originChallenge, task.originChallenge);
  await f.complete(task); await drainNotifications(f.hub);
  assert.equal(wakes, 0, 'default wake still requires independent native origin proof');
  assert.equal(f.hub.state.tasks[task.taskId].notification.deliveries.length, 0);
  await f.bind(task);
  await until(() => f.hub.state.tasks[task.taskId].notification.deliveries[0]?.state === 'queued');
  const value = f.hub.state.tasks[task.taskId], delivery = value.notification.deliveries[0];
  assert.equal(delivery.expiresAt, value.updatedAt + 600000);
  const message = await f.call('chat_status', { messageId: delivery.messageId });
  assert.equal(message.wakeRequested, true); assert.equal(wakes, 1);
  const { createHash } = await import('node:crypto');
  assert.equal(f.proofs[0].expectedFingerprint,
    createHash('sha256').update(JSON.stringify({ method: 'start', params })).digest('hex'));
  assert.equal(f.proofs[0].expectedReceipt.notificationMode, 'wake');
});

test('roots without an origin verifier stay off and handoff preserves the original policy', async t => {
  const f = await fixture(t, { originVerifier: null });
  const task = await f.call('start', { provider: 'claude', cwd: f.parent, prompt: 'No native origin', requestId: 'no-origin' });
  assert.equal(task.originChallenge, undefined);
  assert.equal(f.hub.state.tasks[task.taskId].notification, undefined);
  const transferred = await f.call('handoff', { taskId: task.taskId, revision: task.revision,
    provider: 'codex', message: 'Same task, no new origin', requestId: 'no-origin-handoff' });
  assert.equal(transferred.originChallenge, undefined);
  assert.equal(f.hub.state.tasks[task.taskId].notification, undefined);
  const enabled = await fixture(t);
  const wake = await enabled.call('start', { provider: 'claude', cwd: enabled.parent, prompt: 'Root wake', requestId: 'handoff-wake' });
  const before = structuredClone(enabled.hub.state.tasks[wake.taskId].notification);
  await enabled.call('handoff', { taskId: wake.taskId, revision: wake.revision,
    provider: 'codex', message: 'Preserve the same origin', requestId: 'wake-handoff' });
  assert.deepEqual(enabled.hub.state.tasks[wake.taskId].notification, before);
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
  const child = await f.call('start', { provider: 'claude', cwd: f.parent, prompt: 'child', requestId: 'child-omitted' }, 'codex', token);
  assert.equal(child.originChallenge, undefined); assert.equal(child.notificationMode, undefined);
  assert.equal(f.hub.state.tasks[child.taskId].parentId, task.taskId);
  assert.equal(f.hub.state.tasks[child.taskId].notification, undefined);
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

test('wake preserves native refusal, and ended origins use ordinary resume boundaries', async t => {
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

test('matching lifecycle events share bounded origin proof recovery with scheduled follow-ups', async t => {
  let available = false, attempts = 0;
  const f = await fixture(t, { verifier: async p => {
    attempts++;
    if (!available) throw Object.assign(new Error('native result not flushed'), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
    return { provider: p.provider, sessionId: p.sessionId, cwd: p.cwd, toolUseId: p.toolUseId,
      turnId: p.turnId, source: 'synthetic-native-proof', verifiedAt: Date.now() };
  } });
  const task = await f.start('flush'); await f.complete(task);
  assert.equal((await f.bind(task)).bound, false);
  await delay(15); assert.equal(attempts, 1, 'the scheduled follow-up is not immediate');
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

const unavailable = () => Object.assign(new Error('Synthetic native flush gap'), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
const syntheticProof = p => ({ provider: p.provider, sessionId: p.sessionId, cwd: p.cwd, toolUseId: p.toolUseId,
  turnId: p.turnId, source: 'synthetic-native-proof', verifiedAt: Date.now() });
async function settle(check) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setImmediate(resolve));
    if (check()) { await new Promise(resolve => setImmediate(resolve)); return; }
  }
  throw new Error('Synthetic proof follow-up did not settle');
}

test('origin follow-ups reread one exact hint after 1 and 3 seconds and stop at three shared attempts', async t => {
  const reads = [];
  const f = await fixture(t, { verifier: async p => { reads.push(p); throw unavailable(); } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const task = await f.start('automatic-bound', { mode: 'wake' });
  assert.equal((await f.bind(task)).attempts, 1);
  const initial = await f.call('status', { taskId: task.taskId, checkNotification: true });
  assert.equal(initial.notification.continuation.reason, 'awaiting-native-proof');
  assert.equal(initial.notification.continuation.retryAfterMs, 2000);
  await assert.rejects(f.call('origin_bind', { taskId: task.taskId, sessionId: otherSession, cwd: f.parent,
    toolUseId: 'other-call', turnId: 'turn-1' }), { code: 'CLAUDEX_ORIGIN_CONFLICT' });
  t.mock.timers.tick(999); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads.length, 1);
  t.mock.timers.tick(1);
  await settle(() => f.hub.state.tasks[task.taskId].notification.originHint.attempts === 2);
  await f.hub.serial; await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(2999); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads.length, 2);
  t.mock.timers.tick(1);
  await settle(() => f.hub.state.tasks[task.taskId].notification.originHint.attempts === 3);
  await f.hub.serial; await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(300000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 3); assert.deepEqual(reads, [reads[0], reads[0], reads[0]]);
  assert.equal((await f.bind(task)).reason, 'native-proof-attempts-exhausted');
  assert.equal((await f.call('origin_recheck', { sessionId, cwd: f.parent, event: 'Stop' })).checked, 0);
  const status = await f.call('status', { taskId: task.taskId, checkNotification: true });
  assert.equal(status.notification.continuation.reason, 'native-proof-attempts-exhausted');
  assert.equal(status.notification.continuation.retryAfterMs, undefined);
  assert.equal(reads.length, 3); assert.equal(f.hub.state.tasks[task.taskId].notification.deliveries.length, 0);
});

test('timer, lifecycle and duplicate bind checks coalesce and success cancels remaining follow-ups', async t => {
  let reads = 0, finish;
  const f = await fixture(t, { verifier: async p => {
    if (++reads === 1) throw unavailable();
    return new Promise(resolve => { finish = () => resolve(syntheticProof(p)); });
  } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const task = await f.start('coalesced'); await f.bind(task);
  t.mock.timers.tick(1000); await settle(() => finish);
  const lifecycle = f.call('origin_recheck', { sessionId, cwd: f.parent, event: 'Stop' });
  const duplicate = f.bind(task);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 2);
  finish(); assert.equal((await duplicate).bound, true); assert.equal((await lifecycle).results[0].bound, true);
  t.mock.timers.tick(300000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2); assert.equal(f.hub.state.tasks[task.taskId].notification.originHint, undefined);
});

for (const code of ['ORIGIN_PROOF_INVALID', 'ORIGIN_PROOF_BOUND_EXCEEDED']) test(`${code} ends scheduled origin proof recovery`, async t => {
  let reads = 0;
  const f = await fixture(t, { verifier: async () => {
    if (++reads === 1) throw unavailable();
    throw Object.assign(new Error('Synthetic refused native proof'), { code });
  } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const task = await f.start(`refused-${code}`); await f.bind(task);
  t.mock.timers.tick(1000);
  await settle(() => f.hub.state.tasks[task.taskId].notification.originHint.attempts === 3);
  t.mock.timers.tick(300000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2); assert.equal(f.hub.state.tasks[task.taskId].notification.originHint.error, code);
  assert.equal(f.hub.state.tasks[task.taskId].notification.origin, null);
});

test('origin expiry prevents both a scheduled read and a follow-up beyond the challenge deadline', async t => {
  let reads = 0;
  const f = await fixture(t, { verifier: async () => { reads++; throw unavailable(); } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = await f.start('expire-pending'); await f.bind(pending);
  await f.hub.mutate(state => { state.tasks[pending.taskId].notification.challengeExpiresAt = 1; });
  t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 1);
  const expiring = await f.start('expire-before-delay');
  await f.hub.mutate(state => { state.tasks[expiring.taskId].notification.challengeExpiresAt = Date.now() + 500; });
  await f.bind(expiring); assert.equal(reads, 2);
  t.mock.timers.tick(300000); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 2);
  assert.equal(f.hub.state.tasks[pending.taskId].notification.origin, null);
  assert.equal(f.hub.state.tasks[expiring.taskId].notification.origin, null);
});

test('close clears origin timers; restart waits for matching lifecycle recovery without rearming them', async t => {
  let reads = 0;
  const f = await fixture(t, { verifier: async () => { reads++; throw unavailable(); } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const task = await f.start('restart-hint'); await f.bind(task); await f.hub.close();
  t.mock.timers.tick(300000); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 1);
  const reopened = await new CollaborationHub({ root: f.root, originVerifier: async p => { reads++; return syntheticProof(p); },
    run: async () => { throw new Error('No inference'); } }).initialize();
  reopened.schedule = () => {}; t.after(() => reopened.close());
  t.mock.timers.tick(300000); await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 1);
  assert.equal(reopened.state.tasks[task.taskId].notification.originHint.attempts, 1);
  const call = params => reopened.dispatch({ peer: 'codex', token: reopened.controllerToken, method: 'origin_recheck', params });
  assert.equal((await call({ sessionId: otherSession, cwd: f.parent, event: 'Stop' })).checked, 0);
  assert.equal((await call({ sessionId, cwd: f.parent, event: 'UserPromptSubmit' })).results[0].bound, true);
  assert.equal(reads, 2);
});

test('app-stop clears origin follow-ups without exhausting the stored hint or rearming on resume', async t => {
  let available = false, reads = 0;
  const f = await fixture(t, { verifier: async p => {
    reads++; if (!available) throw unavailable(); return syntheticProof(p);
  } });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const task = await f.start('stop-hint'); await f.bind(task);
  const before = clear.mock.calls.length;
  await writeJSON(join(f.parent, 'app-stop.json'), { version: 1, stopped: true });
  await until(() => clear.mock.calls.slice(before).some(call => call.arguments[0] !== undefined));
  await writeJSON(join(f.parent, 'app-stop.json'), { version: 1, stopped: false });
  available = true; await delay(1100);
  assert.equal(reads, 1); assert.equal(f.hub.state.tasks[task.taskId].notification.originHint.attempts, 1);
  assert.equal((await f.call('origin_recheck', { sessionId, cwd: f.parent, event: 'Stop' })).results[0].bound, true);
  assert.equal(reads, 2);
});

for (const boundary of ['close', 'app-stop', 'expiry']) test(`${boundary} fences an in-flight scheduled origin proof`, async t => {
  let reads = 0, finish;
  const f = await fixture(t, { verifier: async p => {
    if (++reads === 1) throw unavailable();
    return new Promise(resolve => { finish = () => resolve(syntheticProof(p)); });
  } });
  const task = await f.start(`late-followup-${boundary}`); await f.bind(task); await until(() => finish);
  let closing;
  if (boundary === 'close') closing = f.hub.close();
  else if (boundary === 'app-stop') {
    await writeJSON(join(f.parent, 'app-stop.json'), { version: 1, stopped: true });
  } else await f.hub.mutate(state => { state.tasks[task.taskId].notification.challengeExpiresAt = 1; });
  finish();
  if (closing) await closing;
  else { await delay(25); await f.hub.serial; }
  assert.equal(reads, 2); assert.equal(f.hub.state.tasks[task.taskId].notification.origin, null);
  assert.equal(f.hub.state.tasks[task.taskId].notification.originHint.attempts, 2);
  assert.equal(f.hub.state.tasks[task.taskId].notification.deliveries.length, 0);
  if (boundary === 'close') {
    const reopened = await new CollaborationHub({ root: f.root, originVerifier: async () => { reads++; throw unavailable(); },
      run: async () => { throw new Error('No inference'); } }).initialize();
    try {
      const recheck = () => reopened.dispatch({ peer: 'codex', token: reopened.controllerToken, method: 'origin_recheck',
        params: { sessionId, cwd: f.parent, event: 'Stop' } });
      assert.equal((await recheck()).results[0].attempts, 3);
      assert.equal((await recheck()).checked, 0); assert.equal(reads, 3, 'restart never refunds an interrupted read');
    } finally { await reopened.close(); }
  }
});
