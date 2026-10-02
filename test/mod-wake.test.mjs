import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { createWakeOutbox } from '../src/claude-mod-wake-outbox.mjs';
import { deliverNativeWake, createNativeWakePump } from '../plugins/claudex/hooks/delivery.mjs';
const source = { sessionId: '11111111-1111-4111-8111-111111111111', cwd: '/sender' };
const target = { sessionId: '22222222-2222-4222-8222-222222222222', cwd: '/receiver' };
const other = { ...source, sessionId: '33333333-3333-4333-8333-333333333333' };
const id = '44444444-4444-4444-8444-444444444444';
const claimId = '55555555-5555-4555-8555-555555555555';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cmw-')));
  const hub = await new CollaborationHub({ root, run: async () => { throw new Error('No model runner'); },
    chatTitleResolver: async chats => chats.map(c => ({ ...c, title: 'Receiver' })),
    claudeWakeManifest: { verify: async () => ({ cwd: target.cwd }), publish: async () => ({ count: 0 }) },
  }).initialize();
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  await hub.chatMailbox.register({ provider: 'claude', sessionId: target.sessionId, cwd: target.cwd, event: 'SessionStart' });
  const call = (method, params = {}, extra = {}) => hub.dispatch({ peer: 'claude', token: hub.controllerToken, method, params, ...extra });
  const send = requestId => call('chat_send', { provider: 'claude', sessionId: target.sessionId, expectedTitle: 'Receiver', message: 'Synthetic fixture only', requestId, wake: true });
  return { root, hub, call, send };
}
test('route is captured per message, survives restart and does not reinterpret idempotent sends', async t => {
  const f = await setup(t);
  const old = await f.send('old'); assert.equal(old.wakeRoute, 'renderer');
  await f.call('native_wake', { route: 'mod' });
  const current = await f.send('new'); assert.equal(current.wakeRoute, 'mod');
  assert.equal(current.wakeStatus, 'waiting-for-mod');
  assert.equal((await f.send('old')).wakeRoute, 'renderer');
  assert.equal(JSON.parse(await readFile(join(f.root, 'work.json'))).nativeWakeRoute, 'mod');
  const second = await new CollaborationHub({ root: f.root, run: async () => {}, claudeWakeManifest: f.hub.claudeWakeManifest }).initialize();
  try { assert.equal(second.state.nativeWakeRoute, 'mod'); } finally { await second.close(); }
});
test('an event wakes waiting clients; renderer and other senders cannot steal a Mod claim', async t => {
  const f = await setup(t); await f.call('native_wake', { route: 'mod' });
  const waiting = f.call('mod_wake_wait', { source, timeoutMs: 1000 });
  await tick(); const message = await f.send('event');
  assert.equal((await waiting).messages[0].messageId, message.messageId);
  assert.equal(f.hub.modWaiters, 0);
  await assert.rejects(f.call('desktop_wake_claim', { messageId: message.messageId, sessionId: target.sessionId }), /Mod route/);
  const params = { source, target, messageId: message.messageId };
  const [a, b] = await Promise.all([f.call('mod_wake_claim', params), f.call('mod_wake_claim', { ...params, source: other })]);
  assert.equal(Number(a.claimed) + Number(b.claimed), 1);
  const owner = a.claimed ? source : other, claim = a.claimed ? a : b;
  const receipt = { source: owner, target, messageId: message.messageId, claimId: claim.claimId, status: 'accepted', reason: 'queued' };
  await assert.rejects(f.call('mod_wake_receipt', { ...receipt, source: a.claimed ? other : source }), /owner changed/);
  await f.call('mod_wake_check', { source: owner, target, messageId: message.messageId, claimId: claim.claimId });
  await f.call('mod_wake_receipt', receipt); await f.call('mod_wake_receipt', receipt);
  await f.hub.chatMailbox.consume({ provider: 'claude', sessionId: target.sessionId, event: 'Stop', lastAssistantMessage: `CLAUDEX_ACK:${message.messageId}` });
  assert.equal((await f.call('mod_wake_receipt', receipt)).state, 'acknowledged');
  assert.equal((await f.call('mod_wake_claim', params)).claimed, false);
});
test('disconnect and shutdown release wait listeners without native work', async t => {
  const f = await setup(t); await f.call('native_wake', { route: 'mod' });
  const abort = new AbortController();
  const waiting = f.call('mod_wake_wait', { source }, { signal: abort.signal });
  abort.abort(); assert.equal((await waiting).state, 'disconnected');
  assert.equal(f.hub.listenerCount('chat-wake'), 0);
  const stopWait = f.call('mod_wake_wait', { source }); await f.hub.close();
  assert.equal((await stopWait).state, 'stopping'); assert.equal(f.hub.modWaiters, 0);
});
test('self-delivery, expired messages and unavailable identities never authorize sends', async t => {
  const f = await setup(t); await f.call('native_wake', { route: 'mod' });
  const m = await f.send('identity');
  assert.deepEqual((await f.call('mod_wake_wait', { source: target, timeoutMs: 0 })).messages, []);
  await assert.rejects(f.call('mod_wake_claim', { source: target, target, messageId: m.messageId }), /identity/);
  f.hub.claudeWakeManifest.verify = async () => { throw new Error('Native metadata unavailable'); };
  await assert.rejects(f.call('mod_wake_claim', { source, target, messageId: m.messageId }), { code: 'MOD_TARGET_UNAVAILABLE' });
  assert.equal((await f.call('chat_status', { messageId: m.messageId })).state, 'queued');
  const expired = await f.hub.chatMailbox.send({ fromProvider: 'codex', targetProvider: 'claude', targetSessionId: target.sessionId,
    message: 'Expiring fixture', requestId: 'expired', expiresInMs: 1, wakeRequested: true, wakeRoute: 'mod' });
  await new Promise(resolve => setTimeout(resolve, 5));
  const waiting = await f.call('mod_wake_wait', { source, timeoutMs: 0, excludeIds: [m.messageId] });
  assert.deepEqual(waiting.messages, []);
  assert.equal((await f.call('chat_status', { messageId: expired.messageId })).state, 'expired');
});
test('restart preserves unknown dispatch, never requeues it and permits bound receipt completion', async t => {
  const f = await setup(t); await f.call('native_wake', { route: 'mod' });
  const m = await f.send('restart');
  const c = await f.call('mod_wake_claim', { source, target, messageId: m.messageId });
  await f.hub.close();
  const h = await new CollaborationHub({ root: f.root, run: async () => {}, claudeWakeManifest: f.hub.claudeWakeManifest }).initialize();
  try {
    const call = (method, params) => h.dispatch({ peer: 'claude', token: h.controllerToken, method, params });
    assert.deepEqual((await call('mod_wake_wait', { source, timeoutMs: 0 })).messages, []);
    assert.equal((await call('mod_wake_claim', { source, target, messageId: m.messageId })).claimed, false);
    await call('mod_wake_receipt', { source, target, messageId: m.messageId, claimId: c.claimId, status: 'uncertain', reason: 'native_exception' });
    assert.equal((await call('chat_status', { messageId: m.messageId })).wake.state, 'uncertain');
  } finally { await h.close(); }
});
test('durable receipt outbox retries only the receipt after a lost response', async t => {
  const f = await setup(t); let calls = 0, fail = true;
  const publish = async r => {
    calls++; if (fail) throw new Error('Socket response lost');
    return { state: 'offered', messageId: r.messageId, targetProvider: 'claude', targetSessionId: r.target.sessionId,
      wakeRoute: 'mod', wake: { claimId: r.claimId, state: r.status, source: r.context } };
  };
  const request = { version: 1, op: 'wake-receipt', context: source, target, messageId: id, claimId, status: 'accepted', reason: 'queued' };
  const outbox = createWakeOutbox(f.root, publish);
  await assert.rejects(outbox.record(request));
  assert.deepEqual(await readdir(join(f.root, 'mod-wake-receipts')), [`${claimId}.pending.json`]);
  fail = false; await createWakeOutbox(f.root, publish).recover();
  assert.deepEqual(await readdir(join(f.root, 'mod-wake-receipts')), [`${claimId}.done.json`]);
  await outbox.record(request); assert.equal(calls, 2);
  await assert.rejects(outbox.record({ ...request, status: 'rejected', reason: 'native_rejected' }));
});
function host() {
  const calls = [], timers = []; let sends = 0;
  const api = { worker: async () => false, context: async () => source, tools: async () => [{ name: 'SendMessage' }], redraw() {},
    after(ms, fn) { const timer = { ms, fn, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(timer); return timer; },
    sendSession: async () => { sends++; return { isDelivered: true }; },
    bridge: async r => { calls.push(r);
      if (r.op === 'wake-next') return { state: 'pending', messages: [{ target, messageId: id }] };
      if (r.op === 'wake-claim') return { claimed: true, messageId: id, claimId, context: 'Quoted peer note' };
      return { ready: true };
    } };
  return { api, calls, timers, sends: () => sends };
}
test('missing SendMessage does not claim, and native refusal is not uncertainty or replay', async () => {
  const h = host(); h.api.tools = async () => [];
  assert.equal((await deliverNativeWake(h.api, source, target, id)).reason, 'missing-SendMessage');
  assert.equal(h.calls.length, 0);
  h.api.tools = async () => [{ name: 'SendMessage' }]; h.api.sendSession = async () => ({ isDelivered: false, reason: 'Recipient policy' });
  assert.equal((await deliverNativeWake(h.api, source, target, id)).state, 'rejected');
  assert.equal(h.calls.at(-1).status, 'rejected');
});
test('late wait completion after session end cannot claim or dispatch', async () => {
  const h = host(); let release;
  h.api.bridge = async r => { h.calls.push(r); return new Promise(resolve => { release = resolve; }); };
  const p = createNativeWakePump({ enabled: true }); p.start(h.api); h.timers[0].fn(); await tick();
  p.stop(); release({ messages: [{ target, messageId: id }] }); await tick();
  assert.equal(h.sends(), 0); assert.deepEqual(h.calls.map(r => r.op), ['wake-next']);
});
test('automatic delivery is serialized and excludes an uncertain message on the next wait', async () => {
  const h = host(), base = h.api.bridge;
  h.api.bridge = async r => { if (r.op === 'wake-receipt') throw new Error('Lost receipt'); return base(r); };
  const p = createNativeWakePump({ enabled: true }); p.start(h.api); h.timers[0].fn(); await tick();
  assert.equal(h.sends(), 1); assert.equal(p.state.lastOutcome.reason, 'receipt-unconfirmed');
  const timer = h.timers.at(-1); timer.fn(); await tick();
  assert.deepEqual(h.calls.filter(r => r.op === 'wake-next').at(-1).excludeIds, [id]);
  assert.equal(h.sends(), 1);
  p.stop();
});

test('a busy native queue can finish after lifecycle stop without a duplicate send', async () => {
  const h = host(); let complete, delivered = 0;
  h.api.sendSession = async () => { delivered++; return new Promise(resolve => { complete = resolve; }); };
  const p = createNativeWakePump({ enabled: true }); p.start(h.api); h.timers[0].fn(); await tick();
  assert.equal(delivered, 1); p.stop(); complete({ isDelivered: true }); await tick();
  assert.equal(h.calls.filter(r => r.op === 'wake-receipt').length, 1);
  assert.equal(h.calls.at(-1).status, 'accepted'); assert.equal(delivered, 1);
});
test('changed context after the final guard cannot reach the native send', async () => {
  const h = host(), base = h.api.bridge;
  h.api.bridge = async r => { const result = await base(r); if (r.op === 'wake-check') h.api.context = async () => other; return result; };
  const result = await deliverNativeWake(h.api, source, target, id);
  assert.equal(result.reason, 'context_changed'); assert.equal(h.sends(), 0);
  assert.equal(h.calls.at(-1).context.sessionId, source.sessionId);
});
test('broker connection failures back off before claim, while unsafe receipt storage blocks', async () => {
  const h = host(); h.api.bridge = async () => { throw new Error('Socket absent'); };
  const p = createNativeWakePump({ enabled: true }); p.start(h.api); h.timers[0].fn(); await tick();
  assert.equal(h.timers.at(-1).ms, 1000); assert.equal(h.sends(), 0);
  h.api.bridge = async () => { const error = new Error('Unsafe state'); error.code = 'INVALID_RECEIPT'; throw error; };
  const count = h.timers.length; h.timers.at(-1).fn(); await tick();
  assert.equal(p.state.status, 'blocked-INVALID_RECEIPT'); assert.equal(h.timers.length, count);
});
test('an unavailable recipient is deferred without blocking other eligible recipients', async () => {
  const h = host(), base = h.api.bridge;
  h.api.bridge = async r => {
    if (r.op === 'wake-claim') { const error = new Error('Unavailable'); error.code = 'MOD_TARGET_UNAVAILABLE'; throw error; }
    return base(r);
  };
  const p = createNativeWakePump({ enabled: true }); p.start(h.api); h.timers[0].fn(); await tick();
  h.timers.at(-1).fn(); await tick();
  assert.deepEqual(h.calls.filter(r => r.op === 'wake-next').at(-1).excludeIds, [id]);
  assert.equal(h.sends(), 0); p.stop();
});

test('malformed final readiness replies cannot authorize a native send', async () => {
  for (const reply of [null, {}, false, { ready: false }, { ready: 'true' }]) {
    const h = host(), base = h.api.bridge;
    h.api.bridge = r => r.op === 'wake-check' ? reply : base(r);
    const outcome = await deliverNativeWake(h.api, source, target, id);
    assert.equal(h.sends(), 0, JSON.stringify(reply));
    assert.equal(outcome.state, 'uncertain');
    assert.equal(outcome.reason, 'pre_dispatch_stopped');
  }
});

test('malformed receipt replies preserve pending evidence instead of marking publication complete', async t => {
  const f = await setup(t);
  const request = { version: 1, op: 'wake-receipt', context: source, target, messageId: id, claimId, status: 'accepted', reason: 'queued' };
  const outbox = createWakeOutbox(f.root, async () => ({ state: 'offered', messageId: target.sessionId,
    targetProvider: 'claude', targetSessionId: target.sessionId, wakeRoute: 'mod',
    wake: { claimId, state: 'accepted', source } }));
  await assert.rejects(outbox.record(request), { code: 'INVALID_RECEIPT' });
  assert.deepEqual(await readdir(join(f.root, 'mod-wake-receipts')), [`${claimId}.pending.json`]);
});
