import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { callCollaboration, serveCollaborationSocket } from '../src/collaboration-transport.mjs';
import { writeJSON } from '../src/storage.mjs';
import { MOD_OBSERVATION_TTL } from '../src/mod-wake-broker.mjs';

const sessionId = '11111111-1111-4111-8111-111111111111';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const observation = (patch = {}) => ({ observerId: 'continuation-fixture', sequence: 1,
  lifecycle: 'loaded', nativeWake: true, selfWake: true, inboundPolicy: 'allow',
  capabilities: { sendMessage: true }, usage: { contextPercent: 10 }, ...patch });

async function fixture(t, { peer = 'codex', ...options } = {}) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'ccn-')));
  await chmod(parent, 0o700);
  const counters = { probes: 0, closed: 0, discovery: 0 };
  const hub = await new CollaborationHub({ root: join(parent, 'collaboration'),
    run: async () => assert.fail('Continuation inspection must not invoke a model'),
    chatWake: async () => assert.fail('Continuation inspection must not navigate or dispatch'),
    chatWakeProbe: async () => {
      counters.probes++;
      return { status: 'ready', close: () => { counters.closed++; },
        dispatch: () => assert.fail('Continuation inspection must never dispatch') };
    },
    nativeChatDiscovery: async () => {
      counters.discovery++;
      return [{ provider: 'codex', sessionId, cwd: parent, title: 'Synthetic source' }];
    },
    claudeWakeManifest: { verify: async () => ({ cwd: parent }),
      publish: async () => assert.fail('Inspection must not publish wake work') },
    originVerifier: async input => ({ ...input, source: 'synthetic-native-proof', verifiedAt: Date.now() }),
    ...options,
  }).initialize();
  hub.schedule = () => {};
  const server = await serveCollaborationSocket({ root: hub.root, dispatch: input => hub.dispatch(input) });
  t.after(async () => { await server.close(); await hub.close(); await rm(parent, { recursive: true, force: true }); });
  const call = (method, params = {}, extra = {}) => callCollaboration({ root: hub.root,
    peer, token: hub.controllerToken, method, params, ...extra });
  await hub.chatMailbox.register({ provider: peer, sessionId, cwd: parent, event: 'SessionStart' });
  const start = (mode = 'wake', requestId = 'continuation') => call('start', {
    provider: peer === 'codex' ? 'claude' : 'codex', cwd: parent,
    prompt: 'Synthetic task held before execution', permission: 'read-only', requestId,
    notifications: { mode },
  });
  const bind = task => call('origin_bind', { taskId: task.taskId, sessionId, cwd: parent,
    toolUseId: `call-${task.taskId}`, turnId: 'synthetic-turn' });
  const inspect = async task => (await call('status', { taskId: task.taskId,
    view: 'summary', checkNotification: true })).notification.continuation;
  return { parent, hub, counters, call, start, bind, inspect };
}

function expect(value, nextAction, reason) {
  assert.equal(value.nextAction, nextAction);
  assert.equal(value.reason, reason);
  assert.equal(value.diagnosticOnly, true);
  assert.equal(value.deliveryGuaranteed, false);
  assert.ok(Number.isSafeInteger(value.checkedAt));
}

test('Unix RPC continuation waits without probes for off, queue and unbound tasks', async t => {
  const f = await fixture(t);
  for (const [mode, reason] of [['off', 'notifications-off'], ['queue', 'queue-does-not-wake'], ['wake', 'awaiting-native-proof']]) {
    const task = await f.start(mode, mode);
    expect(await f.inspect(task), 'wait', reason);
  }
  assert.deepEqual(f.counters, { probes: 0, closed: 0, discovery: 0 });
});

test('terminal work requests its result without a native readiness probe', async t => {
  const f = await fixture(t), task = await f.start('off');
  await f.hub.mutate(state => { state.tasks[task.taskId].status = 'completed'; state.tasks[task.taskId].revision++; });
  expect(await f.inspect(task), 'read-result', 'task-terminal');
  assert.equal(f.counters.probes, 0);
});

test('bound exact Codex owner is diagnostic only and its read-only handle is closed', async t => {
  const f = await fixture(t), task = await f.start(); await f.bind(task);
  const before = JSON.stringify(f.hub.state);
  const ordinary = await f.call('status', { taskId: task.taskId });
  assert.equal(ordinary.notification.continuation, undefined);
  assert.equal(f.counters.probes, 0);
  const result = await f.inspect(task);
  expect(result, 'await-notification', 'native-owner-observed');
  assert.equal(result.evidence, 'native-owner');
  assert.deepEqual(f.counters, { probes: 1, closed: 1, discovery: 1 });
  assert.equal(JSON.stringify(f.hub.state), before, 'inspection must not change revisions or persistent state');
  assert.equal(f.hub.running.size, 0);
});

test('Codex continuation refuses missing probes, unavailable owners and unmapped sources', async t => {
  const f = await fixture(t), task = await f.start(); await f.bind(task);
  const probe = f.hub.chatWakeProbe;
  f.hub.chatWakeProbe = null;
  expect(await f.inspect(task), 'wait', 'wake-probe-unavailable');
  f.hub.chatWakeProbe = async () => ({ status: 'unavailable' });
  expect(await f.inspect(task), 'wait', 'native-owner-unavailable');
  f.hub.chatWakeProbe = probe;
  f.hub.nativeChatDiscovery = async () => [{ sessionId, cwd: '/different', title: 'Wrong source' }];
  expect(await f.inspect(task), 'wait', 'origin-unmapped');
  assert.equal(f.counters.probes, 0, 'an unmapped source must not reach native owner discovery');
  await f.hub.chatMailbox.register({ provider: 'codex', sessionId, cwd: f.parent, event: 'SessionEnd' });
  expect(await f.inspect(task), 'wait', 'waiting-for-resume');
});

test('app-stop and task revision changes during Codex discovery refuse stale continuation', async t => {
  const f = await fixture(t), task = await f.start(); await f.bind(task);
  for (const change of ['stop', 'revision', 'ended']) {
    const entered = deferred(), release = deferred();
    f.hub.chatWakeProbe = async () => { entered.resolve(); await release.promise;
      return { status: 'ready', close: () => { f.counters.closed++; } }; };
    const checking = f.inspect(task); await entered.promise;
    if (change === 'stop') await writeJSON(join(f.parent, 'app-stop.json'), { version: 1, stopped: true });
    else if (change === 'revision') await f.hub.mutate(state => { state.tasks[task.taskId].revision++; });
    else await f.hub.chatMailbox.register({ provider: 'codex', sessionId, cwd: f.parent, event: 'SessionEnd' });
    release.resolve();
    expect(await checking, 'wait', change === 'stop' ? 'app-stopped' : change === 'revision' ? 'task-or-route-changed' : 'waiting-for-resume');
    if (change === 'stop') await writeJSON(join(f.parent, 'app-stop.json'), { version: 1, stopped: false });
  }
  assert.equal(f.counters.closed, 3);
});

test('workers cannot inspect controller notification continuation over Unix RPC', async t => {
  const f = await fixture(t), task = await f.start('off');
  const token = 'c'.repeat(64);
  await f.hub.mutate(state => {
    const value = state.tasks[task.taskId]; value.status = 'running';
    value.active = { generation: 1, tokenHash: createHash('sha256').update(token).digest('hex') };
  });
  await assert.rejects(f.call('status', { taskId: task.taskId, checkNotification: true }, { peer: 'claude', token }),
    { code: 'CLAUDEX_ACCESS_DENIED' });
  await assert.rejects(f.call('status', { taskId: task.taskId, checkNotification: 'yes' }),
    { code: 'CLAUDEX_INVALID_QUERY' });
  await f.hub.mutate(state => { state.tasks[task.taskId].status = 'ready'; state.tasks[task.taskId].active = null; });
});

test('Claude mod-self continuation follows real observation policy, opt-ins and server TTL', async t => {
  const f = await fixture(t, { peer: 'claude' }), task = await f.start(); await f.bind(task);
  await f.call('native_wake', { route: 'mod-self' });
  expect(await f.inspect(task), 'wait', 'no-live-receiver');
  for (const [index, [patch, reason]] of [
    [{ nativeWake: false }, 'native-wake-disabled'], [{ selfWake: false }, 'self-delivery-disabled'],
    [{ inboundPolicy: 'hold' }, 'native-inbound-hold'], [{ inboundPolicy: 'refuse' }, 'native-inbound-refuse'],
    [{ inboundPolicy: 'unknown' }, 'native-policy-unknown'], [{}, 'receiver-observed'],
  ].entries()) {
    await f.call('mod_wake_observe', { source: { sessionId, cwd: f.parent },
      observation: observation({ sequence: index + 1, ...patch }) });
    const result = await f.inspect(task);
    expect(result, reason === 'receiver-observed' ? 'await-notification' : 'wait', reason);
    if (reason === 'receiver-observed') assert.equal(result.evidence, 'mod-self-reported');
  }
  const future = Date.now() + MOD_OBSERVATION_TTL + 1;
  t.mock.method(Date, 'now', () => future);
  expect(await f.inspect(task), 'wait', 'no-live-receiver');
  t.mock.restoreAll();
  assert.equal(f.hub.state.tasks[task.taskId].notification.deliveries.length, 0);
});

test('Claude route changes during awaited native mapping refuse stale continuation', async t => {
  const f = await fixture(t, { peer: 'claude' }), task = await f.start(); await f.bind(task);
  await f.call('native_wake', { route: 'mod-self' });
  await f.call('mod_wake_observe', { source: { sessionId, cwd: f.parent }, observation: observation() });
  const entered = deferred(), release = deferred();
  f.hub.claudeWakeManifest.verify = async () => { entered.resolve(); await release.promise; return { cwd: f.parent }; };
  const checking = f.inspect(task); await entered.promise;
  await f.call('native_wake', { route: 'renderer' }); release.resolve();
  expect(await checking, 'wait', 'task-or-route-changed');
  expect(await f.inspect(task), 'wait', 'renderer-readiness-unverified');
});

test('notification quotas refuse sleeping before any native probe', async t => {
  const f = await fixture(t), task = await f.start(); await f.bind(task);
  const other = await f.start('wake', 'other'); await f.bind(other);
  const deliveries = Array.from({ length: 16 }, (_, index) => ({ revision: index + 1, state: 'uncertain',
    requestId: `retained-${index}`, createdAt: Date.now(), expiresAt: Date.now() + 60000 }));
  await f.hub.mutate(state => { state.tasks[task.taskId].notification.deliveries = deliveries; });
  expect(await f.inspect(task), 'wait', 'task-notification-limit');
  expect(await f.inspect(other), 'wait', 'origin-rate-limit');
  assert.equal(f.counters.probes, 0);
});

test('final mailbox await cannot hide a changed task boundary', async t => {
  const f = await fixture(t), task = await f.start(); await f.bind(task);
  const list = f.hub.chatMailbox.list.bind(f.hub.chatMailbox);
  let count = 0;
  f.hub.chatMailbox.list = async () => {
    const value = await list();
    if (++count === 2) await f.hub.mutate(state => { state.tasks[task.taskId].revision++; });
    return value;
  };
  expect(await f.inspect(task), 'wait', 'task-or-route-changed');
  assert.equal(f.counters.closed, 1);
});
