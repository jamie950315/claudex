import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { createModBridge } from '../src/claude-mod-bridge.mjs';
import { serveCollaborationSocket } from '../src/collaboration-transport.mjs';
import { modDeliveryDiagnosis, modSessionObservation, MOD_OBSERVATION_TTL } from '../src/mod-wake-broker.mjs';
import { createSessionObserver } from '../plugins/claudex/hooks/delivery.mjs';
const source = { sessionId: '11111111-1111-4111-8111-111111111111', cwd: '/fixture' };
const other = { sessionId: '22222222-2222-4222-8222-222222222222', cwd: '/other' };
const observation = (more = {}) => ({ observerId: 'fixture-mod', sequence: 1, lifecycle: 'loaded', nativeWake: true,
  selfWake: true, inboundPolicy: 'allow', capabilities: { sendMessage: true }, usage: { contextPercent: 42 }, ...more });
async function setup(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cmo-')));
  const hub = await new CollaborationHub({ root: join(root, 'collaboration'), run: async () => { throw new Error('No inference'); },
    chatTitleResolver: async chats => chats.map(chat => ({ ...chat, title: 'Fixture' })),
    claudeWakeManifest: { verify: async () => ({ cwd: source.cwd }), publish: async () => ({ count: 0 }) },
  }).initialize();
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  await hub.chatMailbox.register({ provider: 'claude', ...source, event: 'SessionStart' });
  const call = (method, params = {}, extra = {}) => hub.dispatch({ method, params, peer: 'claude', token: hub.controllerToken, ...extra });
  await call('native_wake', { route: 'mod-self' });
  const send = () => call('chat_send', { provider: 'claude', sessionId: source.sessionId, expectedTitle: 'Fixture',
    message: 'Synthetic only', requestId: 'observation-fixture', wake: true });
  return { root, hub, call, send };
}
test('exact receiver diagnostics distinguish absent, opt-out, native policy and mapping without claiming', async t => {
  const f = await setup(t), message = await f.send();
  assert.equal((await modDeliveryDiagnosis(f.hub, message)).reason, 'no-live-receiver');
  for (const [index, [patch, reason]] of [
    [{ selfWake: false }, 'self-delivery-disabled'], [{ inboundPolicy: 'hold' }, 'native-inbound-hold'],
    [{ inboundPolicy: 'refuse' }, 'native-inbound-refuse'], [{ inboundPolicy: 'unknown' }, 'native-policy-unknown'],
    [{ nativeWake: false }, 'native-wake-disabled'], [{}, 'receiver-observed'],
  ].entries()) {
    await f.call('mod_wake_observe', { source, observation: observation({ sequence: index + 1, ...patch }) });
    assert.equal((await modDeliveryDiagnosis(f.hub, message)).reason, reason);
    assert.equal((await f.call('chat_status', { messageId: message.messageId })).state, 'queued');
  }
  f.hub.claudeWakeManifest.verify = async () => { throw new Error('No Desktop registry mapping'); };
  assert.equal((await modDeliveryDiagnosis(f.hub, message)).reason, 'target-unmapped');
  assert.equal((await f.call('chat_status', { messageId: message.messageId })).deliveryObservation.reason, 'target-unmapped');
  await assert.rejects(f.call('mod_wake_claim', { source, target: source, messageId: message.messageId, route: 'mod-self' }), { code: 'MOD_TARGET_UNAVAILABLE' });
  assert.deepEqual(await f.hub.chatMailbox.consume({ provider: 'claude', sessionId: source.sessionId, event: 'UserPromptSubmit' }), { acknowledgedIds: [] });
  assert.equal((await f.call('chat_status', { messageId: message.messageId })).state, 'queued');
});
test('peer delivery reports missing SendMessage on observed sender without assuming receiver authority', async t => {
  const f = await setup(t); await f.call('native_wake', { route: 'mod' });
  const message = await f.send();
  await f.call('mod_wake_observe', { source: other, observation: observation({ capabilities: { sendMessage: false } }) });
  assert.equal((await modDeliveryDiagnosis(f.hub, message)).reason, 'missing-SendMessage');
  await f.call('mod_wake_observe', { source: other, observation: observation({ sequence: 2, capabilities: { sendMessage: null } }) });
  assert.equal((await modDeliveryDiagnosis(f.hub, message)).reason, 'native-tools-unavailable');
  await f.call('mod_wake_observe', { source: other, observation: observation({ sequence: 3 }) });
  assert.equal((await modDeliveryDiagnosis(f.hub, message)).reason, 'sender-observed');
});
test('observations expire, end fences late results and restart never restores online evidence', async t => {
  const f = await setup(t), originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now; t.after(() => { Date.now = originalNow; });
  await f.call('mod_wake_observe', { source, observation: observation() });
  const first = modSessionObservation(f.hub, source);
  assert.equal(first.diagnosticOnly, true); assert.equal(first.provenance, 'mod-self-reported');
  assert.equal(modSessionObservation(f.hub, { ...source, cwd: '/changed' }), null);
  now += MOD_OBSERVATION_TTL;
  assert.equal(modSessionObservation(f.hub, source), null);
  await f.call('mod_wake_observe', { source, observation: observation({ sequence: 2 }) });
  await f.call('mod_wake_observe', { source, observation: observation({ sequence: 4, lifecycle: 'ended' }) });
  assert.equal((await f.call('mod_wake_observe', { source, observation: observation({ sequence: 3 }) })).observed, false);
  assert.equal(modSessionObservation(f.hub, source), null);
  await f.call('mod_wake_observe', { source, observation: observation({ observerId: 'reloaded' }) });
  await f.hub.close();
  const restarted = await new CollaborationHub({ root: f.hub.root, run: async () => {} }).initialize();
  try { assert.equal(modSessionObservation(restarted, source), null); } finally { await restarted.close(); }
});
test('event-backed wait refreshes observation, disconnect invalidates it, bounds reject content', async t => {
  const f = await setup(t), abort = new AbortController();
  const waiting = f.call('mod_wake_wait', { source, self: true, observation: observation() }, { signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(modSessionObservation(f.hub, source)); abort.abort();
  assert.equal((await waiting).state, 'disconnected'); assert.equal(modSessionObservation(f.hub, source), null);
  for (const patch of [{ prompt: 'private' }, { usage: { contextPercent: 101 } }, { inboundPolicy: 'invented' }, { capabilities: { toolArgs: {} } }])
    await assert.rejects(f.call('mod_wake_observe', { source, observation: observation(patch) }), { code: 'INVALID_REQUEST' });
  for (let index = 0; index < 64; index++)
    await f.call('mod_wake_observe', { source, observation: observation({ observerId: `observer-${index}` }) });
  await assert.rejects(f.call('mod_wake_observe', { source, observation: observation({ observerId: 'overflow' }) }), { code: 'MOD_OBSERVATION_CAPACITY' });
});
test('observation traverses real Unix RPC, preserves typed errors and cannot enable configured opt-ins', async t => {
  const f = await setup(t);
  const server = await serveCollaborationSocket({ root: f.hub.root, dispatch: request => f.hub.dispatch(request) });
  t.after(() => server.close());
  const bridge = createModBridge({ root: f.root });
  await bridge({ version: 1, op: 'wake-observe', context: source, observation: observation() });
  const value = modSessionObservation(f.hub, source);
  assert.equal(value.nativeWake, false); assert.equal(value.selfWake, false);
  assert.deepEqual(value.usage, { contextPercent: 42 });
  const listed = await bridge({ version: 1, op: 'read', context: source, method: 'chat_list', params: {} });
  assert.equal(listed.chats[0].modObservation.observerId, 'fixture-mod');
  const message = await f.send();
  const status = await bridge({ version: 1, op: 'read', context: source, method: 'chat_status', params: { messageId: message.messageId } });
  assert.equal(status.deliveryObservation.reason, 'native-wake-disabled');
  for (let index = 0; index < 63; index++)
    await f.call('mod_wake_observe', { source, observation: observation({ observerId: `rpc-${index}` }) });
  await assert.rejects(bridge({ version: 1, op: 'wake-observe', context: source,
    observation: observation({ observerId: 'overflow' }) }), { code: 'MOD_OBSERVATION_CAPACITY' });
});
test('native lifecycle observation strips content and fences suspended callbacks after end', async () => {
  const calls = [], observer = createSessionObserver();
  const api = { worker: async () => false, context: async () => source, inbound: async () => 'hold',
    tools: async () => [{ name: 'SendMessage', privateArgs: 'not copied' }],
    usage: async () => ({ context: { percent: 38 }, prompt: 'never copied' }), nativeWakeEnabled: true, selfEnabled: false,
    bridge: async request => { calls.push(request); return { observed: true }; } };
  await observer.start(api);
  assert.deepEqual(calls[0].observation.usage, { contextPercent: 38 });
  assert.equal(JSON.stringify(calls).includes('copied'), false);
  let release;
  api.usage = () => new Promise(resolve => { release = resolve; });
  const refresh = observer.refresh();
  await observer.stop(); release({ context: { percent: 99 } }); await refresh;
  assert.equal(calls.length, 2); assert.equal(calls[1].observation.lifecycle, 'ended');
  assert.ok(calls[1].observation.sequence > calls[0].observation.sequence);
  api.context = () => new Promise(resolve => { release = resolve; });
  const starting = observer.start(api);
  await new Promise(resolve => setImmediate(resolve));
  await observer.stop(); release(source); await starting;
  assert.equal(calls.length, 2);
});

test('unavailable native tool inventory is unknown rather than a false missing-tool claim', async () => {
  const calls = [], observer = createSessionObserver();
  await observer.start({ worker: async () => false, context: async () => source, inbound: async () => 'allow',
    tools: async () => { throw new Error('Synthetic native inspection failure'); },
    usage: async () => null, nativeWakeEnabled: true, selfEnabled: false,
    bridge: async request => { calls.push(request); return { observed: true }; } });
  assert.equal(calls[0].observation.capabilities.sendMessage, null);
  await observer.stop();
});
