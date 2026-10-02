import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { createModBridge } from '../src/claude-mod-bridge.mjs';
import { createClaudeChatWakeManifest } from '../src/claude-chat-wake-manifest.mjs';
import { serveCollaborationSocket } from '../src/collaboration-transport.mjs';
import { deliverNativeWake, createNativeWakePump } from '../plugins/claudex/hooks/delivery.mjs';

const own = { sessionId: '11111111-1111-4111-8111-111111111111', cwd: '/fixture/own' };
const other = { sessionId: '22222222-2222-4222-8222-222222222222', cwd: '/fixture/other' };
const make = (op, data = {}) => ({ version: 1, op, context: own, target: own, route: 'mod-self', ...data });

test('ordinary hooks cannot bypass the explicit own-inbox route or its native inbound policy', async t => {
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    const f = await fixture(t);
    await f.call('native_wake', { route: 'mod-self' });
    const self = await f.send(`self-${event}`);
    const hook = await f.hub.chatMailbox.consume({ provider: 'claude', sessionId: own.sessionId, event });
    assert.equal(hook.message, undefined, event);
    assert.equal((await f.call('chat_status', { messageId: self.messageId })).state, 'queued');
    const queued = await f.call('chat_send', { provider: 'claude', sessionId: own.sessionId, expectedTitle: 'Fixture',
      message: 'Explicit queue-only fixture', requestId: `hook-${event}`, wake: false });
    assert.equal((await f.hub.chatMailbox.consume({ provider: 'claude', sessionId: own.sessionId, event })).message.messageId, queued.messageId);
  }
});

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-self-wake-')));
  await chmod(root, 0o700);
  const manifest = { verify: async sessionId => ({ cwd: sessionId === own.sessionId ? own.cwd : other.cwd }),
    publish: async () => ({ count: 0 }) };
  const createHub = () => new CollaborationHub({ root: join(root, 'collaboration'),
    run: async () => assert.fail('Synthetic checks never invoke a model'), claudeWakeManifest: manifest,
    chatTitleResolver: async chats => chats.map(chat => ({ ...chat, title: 'Fixture' })) }).initialize();
  const f = { root, manifest, hub: await createHub(), writes: [], inspected: 0, rpcCalls: [] };
  t.after(async () => { await f.hub.close(); await rm(root, { recursive: true, force: true }); });
  for (const ctx of [own, other]) await f.hub.chatMailbox.register({ provider: 'claude', ...ctx, event: 'SessionStart' });
  f.call = (method, params = {}) => f.hub.dispatch({ peer: 'claude', token: f.hub.controllerToken, method, params });
  f.send = (requestId, target = own) => f.call('chat_send', { provider: 'claude', sessionId: target.sessionId,
    expectedTitle: 'Fixture', message: 'Synthetic quoted peer note', requestId, wake: true });
  f.rpc = async request => {
    f.rpcCalls.push(request);
    return f.hub.dispatch({ ...request, params: { ...request.params,
      ...(request.method === 'mod_wake_wait' ? { timeoutMs: 0 } : {}) } });
  };
  f.bridge = (options = {}) => createModBridge({ root, rpc: f.rpc, allowNativeWake: true, allowSelfWake: true,
    inspectInbox: async () => { f.inspected++; return { ready: true }; },
    submitInbox: async (text, { beforeWrite }) => {
      assert.equal(await beforeWrite(), true);
      f.writes.push(text);
      return { state: 'submitted', reason: 'socket-written', automaticReplay: false };
    }, ...options });
  f.restart = async () => { await f.hub.close(); f.hub = await createHub(); };
  f.claim = async message => {
    const c = await f.bridge()(make('wake-claim', { messageId: message.messageId }));
    return { messageId: message.messageId, claimId: c.claimId };
  };
  f.host = (bridge = f.bridge()) => ({ selfEnabled: true, worker: async () => false,
    inbound: async () => undefined, context: async () => own, bridge,
    tools: async () => assert.fail('Own-inbox reception must not require SendMessage'),
    sendSession: async () => assert.fail('Own-inbox must never fall back to peer send'), redraw() {} });
  return f;
}

test('explicit own-inbox route captures only new messages and exposes only own-session work to opted-in clients', async t => {
  const f = await fixture(t);
  await f.call('native_wake', { route: 'mod' });
  const legacy = await f.send('legacy');
  await f.call('native_wake', { route: 'mod-self' });
  const ownMessage = await f.send('own');
  await f.send('other', other);
  assert.equal(legacy.wakeRoute, 'mod');
  assert.equal((await f.send('legacy')).wakeRoute, 'mod');
  assert.equal(ownMessage.wakeRoute, 'mod-self');
  const disabled = await f.call('mod_wake_wait', { source: own, timeoutMs: 0 });
  assert.equal(disabled.state, 'disabled');
  const result = await f.call('mod_wake_wait', { source: own, self: true, timeoutMs: 0 });
  assert.deepEqual(result.messages.map(m => m.messageId), [ownMessage.messageId]);
  assert.deepEqual(result.messages[0].target, own);
  assert.equal(result.messages[0].route, 'mod-self');
  await f.restart();
  assert.equal((await f.call('native_wake')).route, 'mod-self');
});

test('bridge requires both opt-ins and exact own context before socket capability inspection or claim', async t => {
  const f = await fixture(t);
  await f.call('native_wake', { route: 'mod-self' });
  const message = await f.send('opt-in');
  const request = make('wake-claim', { messageId: message.messageId });
  await assert.rejects(f.bridge({ allowNativeWake: false })(request), { code: 'NATIVE_WAKE_DISABLED' });
  await assert.rejects(f.bridge({ allowSelfWake: false })(request), { code: 'SELF_WAKE_DISABLED' });
  await assert.rejects(f.bridge()(make('wake-claim', { messageId: message.messageId, context: other })), { code: 'SELF_WAKE_DISABLED' });
  assert.equal(f.inspected, 0);
  assert.equal((await f.call('chat_status', { messageId: message.messageId })).state, 'queued');
  const result = await f.bridge()(request);
  assert.equal(result.claimed, true);
  assert.equal(f.inspected, 1);
});

test('self submission uses identifiers only and remains offered until the real matching Stop ACK', async t => {
  const f = await fixture(t);
  await f.call('native_wake', { route: 'mod-self' });
  const message = await f.send('submit');
  const result = await deliverNativeWake(f.host(), own, own, message.messageId, () => true, 'mod-self');
  assert.equal(result.state, 'submitted');
  assert.equal(f.writes.length, 1);
  assert.ok(f.writes[0].startsWith('CLAUDEX_SELF_INBOX_V1\n'));
  assert.ok(!f.writes[0].includes('Synthetic quoted peer note'));
  const ids = JSON.parse(f.writes[0].split('\n')[1]);
  assert.deepEqual(Object.keys(ids).sort(), ['claimId', 'messageId', 'target']);
  const submitted = await f.call('chat_status', { messageId: message.messageId });
  assert.equal(submitted.state, 'offered');
  assert.equal(submitted.wake.state, 'submitted');
  await f.hub.chatMailbox.consume({ provider: 'claude', sessionId: other.sessionId,
    event: 'Stop', lastAssistantMessage: `CLAUDEX_ACK:${message.messageId}` });
  assert.equal((await f.call('chat_status', { messageId: message.messageId })).state, 'offered');
  const received = await f.bridge()(make('wake-self-receive', ids));
  assert.equal(received.ready, true);
  assert.match(received.context, /Synthetic quoted peer note/);
  await f.hub.chatMailbox.consume({ provider: 'claude', sessionId: own.sessionId,
    event: 'Stop', lastAssistantMessage: `CLAUDEX_ACK:${message.messageId}` });
  assert.equal((await f.call('chat_status', { messageId: message.messageId })).state, 'acknowledged');
});

test('native hold/refuse and disabled self capability do not claim or use a peer-send fallback', async t => {
  const f = await fixture(t);
  await f.call('native_wake', { route: 'mod-self' });
  const message = await f.send('policy');
  for (const policy of ['hold', 'refuse']) {
    const result = await deliverNativeWake({ ...f.host(), inbound: async () => policy }, own, own,
      message.messageId, () => true, 'mod-self');
    assert.equal(result.reason, `native-inbound-${policy}`);
  }
  const off = await deliverNativeWake({ ...f.host(), selfEnabled: false }, own, own,
    message.messageId, () => true, 'mod-self');
  assert.equal(off.reason, 'self-delivery-disabled');
  assert.equal(f.inspected, 0);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.call('chat_status', { messageId: message.messageId })).state, 'queued');
});

test('source, cwd, route and claim changes cannot read or dispatch own-inbox peer context', async t => {
  const f = await fixture(t);
  await f.call('native_wake', { route: 'mod-self' });
  const message = await f.send('identity');
  const ids = await f.claim(message);
  const params = { source: own, target: own, route: 'mod-self', ...ids };
  for (const changed of [{ source: other }, { source: { ...own, cwd: '/changed' } },
    { target: other }, { route: 'mod' }, { claimId: other.sessionId }]) {
    await assert.rejects(f.call('mod_wake_receive', { ...params, ...changed }));
  }
  f.manifest.verify = async () => ({ cwd: '/changed' });
  await assert.rejects(f.call('mod_wake_receive', params), { code: 'MOD_TARGET_UNAVAILABLE' });
  assert.equal(f.writes.length, 0);
});

test('app-stop and route revocation fence native receive after awaited metadata validation', async t => {
  const f = await fixture(t);
  await f.call('native_wake', { route: 'mod-self' });
  const message = await f.send('receive-fence');
  const ids = await f.claim(message);
  let release, started;
  const entered = new Promise(resolve => started = resolve);
  f.manifest.verify = async () => { started(); await new Promise(resolve => release = resolve); return { cwd: own.cwd }; };
  const receiving = f.bridge()(make('wake-self-receive', ids));
  await entered;
  await writeFile(join(f.root, 'app-stop.json'), JSON.stringify({ version: 1, stopped: true }), { mode: 0o600 });
  release();
  await assert.rejects(receiving, { code: 'APP_STOPPED' });
  await rm(join(f.root, 'app-stop.json'));
  f.manifest.verify = async () => ({ cwd: own.cwd });
  await f.call('native_wake', { route: 'renderer' });
  await assert.rejects(f.bridge()(make('wake-self-receive', ids)), /no longer authorized/);
  assert.equal(f.writes.length, 0);
});

test('lost submitted receipt response recovers only the durable receipt across broker and bridge restart', async t => {
  const f = await fixture(t);
  await f.call('native_wake', { route: 'mod-self' });
  const message = await f.send('receipt-restart');
  let lost = false;
  const bridge = f.bridge({ rpc: async request => {
    const result = await f.rpc(request);
    if (request.method === 'mod_wake_receipt' && !lost) { lost = true; throw Error('Lost response'); }
    return result;
  } });
  const outcome = await deliverNativeWake(f.host(bridge), own, own, message.messageId, () => true, 'mod-self');
  assert.equal(outcome.reason, 'receipt-unconfirmed');
  const names = await readdir(join(f.root, 'mod-wake-receipts'));
  assert.equal(names.filter(name => name.endsWith('.pending.json')).length, 1);
  await f.restart();
  const next = await f.bridge()({ version: 1, op: 'wake-next', context: own, excludeIds: [] });
  assert.deepEqual(next.messages, []);
  assert.equal(f.writes.length, 1);
  assert.equal((await readdir(join(f.root, 'mod-wake-receipts'))).filter(name => name.endsWith('.done.json')).length, 1);
  const status = await f.call('chat_status', { messageId: message.messageId });
  assert.equal(status.state, 'offered');
  assert.equal(status.wake.state, 'submitted');
});

test('automatic pump selects explicit own-inbox route without another loaded sender', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.call('native_wake', { route: 'mod-self' });
  const message = await f.send('automatic');
  const timers = [];
  const host = f.host();
  host.after = (ms, fn) => {
    const timer = { ms, fn, cancel() {} }; timers.push(timer); return timer;
  };
  const pump = createNativeWakePump({ enabled: true });
  let completed;
  const finished = new Promise(resolve => completed = resolve);
  host.redraw = () => { if (pump.state.lastOutcome) completed(); };
  t.after(() => pump.stop());
  pump.start(host); timers[0].fn();
  await finished;
  assert.equal(pump.state.lastOutcome?.state, 'submitted');
  assert.equal(pump.state.lastOutcome.messageId, message.messageId);
  assert.equal(f.writes.length, 1);
  pump.stop();
  assert.equal((await f.call('chat_status', { messageId: message.messageId })).state, 'offered');
});

test('renderer cannot claim or publish own-inbox messages', async t => {
  const f = await fixture(t);
  await f.call('native_wake', { route: 'mod-self' });
  const message = await f.send('renderer-exclusion');
  await assert.rejects(f.call('desktop_wake_claim', { messageId: message.messageId, sessionId: own.sessionId }), /Mod route/);
  const manifest = createClaudeChatWakeManifest({ root: f.root, mappings: async (_, ids) => {
    assert.deepEqual(ids, []); return new Map();
  } });
  assert.deepEqual(await manifest.publish(f.hub.chatMailbox), { count: 0 });
  const saved = JSON.parse(await readFile(join(f.root, 'chat-mailbox', 'wake-manifest.json')));
  assert.deepEqual(saved.messages, []);
});

test('an own-inbox receive claim is consumed once and cannot replay after ACK or restart', async t => {
  const f = await fixture(t);
  await f.call('native_wake', { route: 'mod-self' });
  const message = await f.send('receive-once');
  const ids = await f.claim(message);
  assert.equal((await f.bridge()(make('wake-self-receive', ids))).ready, true);
  await assert.rejects(f.bridge()(make('wake-self-receive', ids)));
  await f.hub.chatMailbox.consume({ provider: 'claude', sessionId: own.sessionId,
    event: 'Stop', lastAssistantMessage: `CLAUDEX_ACK:${message.messageId}` });
  await f.restart();
  await assert.rejects(f.bridge()(make('wake-self-receive', ids)));
});

test('concurrent and repeated own-inbox helper requests dispatch only once and recover the saved outcome', async t => {
  const f = await fixture(t);
  await f.call('native_wake', { route: 'mod-self' });
  const message = await f.send('send-once');
  const ids = await f.claim(message);
  let release, entered;
  const started = new Promise(resolve => entered = resolve);
  let sends = 0;
  const bridge = f.bridge({ submitInbox: async (_, { beforeWrite }) => {
    assert.equal(await beforeWrite(), true);
    sends++;
    entered();
    await new Promise(resolve => release = resolve);
    return { state: 'submitted', reason: 'socket-written', automaticReplay: false };
  } });
  const first = bridge(make('wake-self-send', ids));
  await started;
  const concurrent = await f.bridge()(make('wake-self-send', ids));
  assert.equal(concurrent.state, 'locked');
  assert.equal(f.writes.length, 0);
  release();
  assert.equal((await first).state, 'submitted');
  await f.restart();
  assert.equal((await f.bridge()(make('wake-self-send', ids))).state, 'submitted');
  assert.equal(sends, 1);
  assert.equal(f.writes.length, 0);
});

test('an own-inbox helper lost after its durable intent is uncertain and never dispatched again', async t => {
  const f = await fixture(t);
  await f.call('native_wake', { route: 'mod-self' });
  const message = await f.send('unknown-send');
  const ids = await f.claim(message);
  let sends = 0;
  await assert.rejects(f.bridge({ submitInbox: async (_, { beforeWrite }) => {
    assert.equal(await beforeWrite(), true);
    sends++;
    throw Error('Synthetic helper response lost');
  } })(make('wake-self-send', ids)));
  await f.restart();
  const outcome = await f.bridge()(make('wake-self-send', ids));
  assert.deepEqual(outcome, { state: 'uncertain', reason: 'dispatch-recorded', automaticReplay: false });
  assert.equal(sends, 1);
  assert.equal(f.writes.length, 0);
});

test('route revocation during durable receive authorization cannot return usable peer context', async t => {
  const f = await fixture(t);
  await f.call('native_wake', { route: 'mod-self' });
  const message = await f.send('receive-durable-race');
  const ids = await f.claim(message);
  let release, entered;
  const enteredReceive = new Promise(resolve => entered = resolve);
  const original = f.hub.chatMailbox.receiveSelfWake.bind(f.hub.chatMailbox);
  f.hub.chatMailbox.receiveSelfWake = async (...args) => {
    const result = await original(...args);
    entered();
    await new Promise(resolve => release = resolve);
    return result;
  };
  const receiving = f.bridge()(make('wake-self-receive', ids));
  await enteredReceive;
  await f.call('native_wake', { route: 'renderer' });
  release();
  await assert.rejects(receiving, /no longer authorized/);
  await f.call('native_wake', { route: 'mod-self' });
  await assert.rejects(f.bridge()(make('wake-self-receive', ids)));
});

test('own-inbox claim, outcome and receive authorization cross the real private RPC transport', async t => {
  const f = await fixture(t);
  const server = await serveCollaborationSocket({ root: join(f.root, 'collaboration'),
    dispatch: envelope => f.hub.dispatch(envelope) });
  t.after(() => server.close());
  await f.call('native_wake', { route: 'mod-self' });
  const message = await f.send('real-rpc');
  // Undefined selects createModBridge's actual callCollaboration transport,
  // rather than the direct hub dispatcher used by the other isolated cases.
  const bridge = f.bridge({ rpc: undefined });
  const sent = await deliverNativeWake(f.host(bridge), own, own, message.messageId, () => true, 'mod-self');
  assert.equal(sent.state, 'submitted');
  assert.equal(f.writes.length, 1);
  const ids = JSON.parse(f.writes[0].split('\n')[1]);
  const received = await bridge(make('wake-self-receive', ids));
  assert.equal(received.ready, true);
  assert.match(received.context, /Synthetic quoted peer note/);
  await assert.rejects(bridge(make('wake-self-receive', ids)));
  const status = await f.call('chat_status', { messageId: message.messageId });
  assert.equal(status.state, 'offered');
  assert.ok(Number.isSafeInteger(status.wake.receiveClaimedAt));
});
