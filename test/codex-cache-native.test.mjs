import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCodexCacheNative } from '../src/codex-cache-native.mjs';

const sessionId = '00000000-0000-4000-8000-000000000001';
const ownerClientId = '00000000-0000-4000-8000-000000000002';
const turnId = '00000000-0000-4000-8000-000000000003';
const target = { sessionId, cwd: '/tmp/synthetic-project' };
const usage = { totalTokens: 105, inputTokens: 100, cachedInputTokens: 90, cacheWriteInputTokens: 0,
  outputTokens: 5, reasoningOutputTokens: 2 };
function fixture(options = {}) {
  const calls = [], events = [];
  const thread = { id: sessionId, cwd: target.cwd, model: 'synthetic-model', reasoningEffort: 'medium',
    status: { type: 'idle' }, ephemeral: false, parentThreadId: null, forkedFromId: null, source: 'exec',
    preview: 'private', ...options.thread };
  const client = new EventEmitter();
  let closes = 0, ownerCloses = 0;
  client.initialize = async () => ({ userAgent: options.userAgent ?? 'codex/0.160.0 (macos)' });
  client.close = async () => { closes++; client.emit('disconnected'); };
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (options.request) {
      const result = await options.request(method, params, client, thread);
      if (result !== undefined) return result;
    }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: structuredClone(thread) };
    if (method === 'thread/loaded/list') return { data: options.loaded === false ? [] : [sessionId], nextCursor: null };
    if (method === 'thread/goal/get') return { goal: options.goal ?? null };
    if (method === 'thread/turns/list') return { data: [{ id: turnId, startedAt: 100, status: 'completed', itemsView: 'notLoaded', items: [] }] };
    assert.fail(`Unexpected request ${method}`);
  };
  const preflight = async () => ({ status: 'ready', ownerClientId, close() { ownerCloses++; }, dispatch() { assert.fail('No dispatch'); } });
  const native = createCodexCacheNative({ clientFactory: () => client, preflight: options.preflight ?? preflight, now: () => 101000 });
  const emit = (method, params) => client.emit('notification', { method, params: { threadId: sessionId, ...params } });
  return { native, client, calls, events, thread, emit, closes: () => closes, ownerCloses: () => ownerCloses };
}

test('inspection is metadata-only and owner handles are closed without dispatch', async () => {
  const f = fixture({ thread: { reasoningEffort: null } });
  const state = await f.native.inspect(target);
  assert.deepEqual(Object.keys(state).sort(), ['sessionId', 'cwd', 'model', 'effort', 'phase', 'ownerClientId', 'nativeVersion', 'fingerprint'].sort());
  assert.equal(state.effort, 'native-default'); assert.equal(state.phase, 'idle');
  assert.equal(state.nativeVersion, '0.160.0'); assert.match(state.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls.map(x => x.method), ['thread/read', 'thread/loaded/list']);
  assert.equal(f.calls[0].params.includeTurns, false);
  assert.equal(f.closes(), 1); assert.equal(f.ownerCloses(), 1);
});

test('loaded, exact cwd, persistent primary and version guards reject before any resume', async () => {
  for (const options of [{ loaded: false }, { thread: { cwd: '/tmp/other' } }, { thread: { ephemeral: true } },
    { thread: { parentThreadId: 'parent' } }, { thread: { forkedFromId: 'ancestor' } }, { thread: { source: 'subAgent' } },
    { thread: { status: { type: 'notLoaded' } } }, { thread: { model: null } },
    { userAgent: 'codex/0.159.0' }, { userAgent: 'codex/0.160.0-alpha.1' }]) {
    const f = fixture(options);
    await assert.rejects(f.native.connect(target, event => f.events.push(event)));
    assert(!f.calls.some(x => x.method === 'thread/resume'));
    assert.equal(f.closes(), 1);
  }
});

test('an existing goal refuses subscription without resuming or mutating the goal', async () => {
  const f = fixture({ goal: { objective: 'private goal', status: 'active' } });
  await assert.rejects(f.native.connect(target, () => {}), /active-goal-unsupported/);
  assert(!f.calls.some(x => x.method === 'thread/resume'));
  assert(f.calls.some(x => x.method === 'thread/goal/get'));
});

test('rejoins only the exact loaded thread and requests a metadata-only initial turn', async () => {
  const f = fixture();
  const handle = await f.native.connect(target, event => f.events.push(event));
  assert.deepEqual(handle.initialTurn, { id: turnId, startedAt: 100000, status: 'completed' });
  assert.deepEqual(f.calls.filter(x => x.method === 'thread/resume'), [
    { method: 'thread/resume', params: { threadId: sessionId, excludeTurns: true } },
  ]);
  assert.deepEqual(f.calls.at(-1), { method: 'thread/turns/list', params: {
    threadId: sessionId, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc',
  } });
  assert(!f.calls.some(x => /fork|start|inject/.test(x.method)));
  const before = handle.state.fingerprint;
  f.thread.model = 'changed-model';
  assert.notEqual((await handle.inspect()).fingerprint, before);
  const owner = await handle.preflight(); owner.close();
  await handle.close(); await handle.close();
  assert.equal(f.closes(), 1); assert.deepEqual(f.events, []);
});

test('notifications arriving during resume buffer until listen and strip every content field', async () => {
  const f = fixture({ request(method, params, client) {
    if (method === 'thread/resume') client.emit('notification', { method: 'turn/started', params: {
      threadId: sessionId, turn: { id: turnId, startedAt: 100, items: [{ text: 'private' }] },
    } });
  } });
  const handle = await f.native.connect(target, event => f.events.push(event));
  f.emit('thread/tokenUsage/updated', { turnId, tokenUsage: { total: { ...usage, private: 'secret' }, last: usage, modelContextWindow: 2000000 } });
  f.emit('item/started', { turnId, item: { type: 'unknownFutureTool', arguments: 'secret', output: 'secret' } });
  f.emit('item/started', { turnId, item: { type: 'reasoning', content: 'secret' } });
  f.emit('turn/completed', { turn: { id: turnId, completedAt: 102, status: 'completed', items: [{ text: 'secret' }] } });
  f.emit('thread/tokenUsage/updated', { threadId: 'other', turnId, tokenUsage: {} });
  assert.deepEqual(f.events, []);
  handle.listen(); handle.listen();
  assert.deepEqual(f.events, [
    { type: 'start', turnId, startedAt: 100000 },
    { type: 'usage', turnId, tokenUsage: { total: usage, last: usage }, at: 101000 },
    { type: 'tool', turnId, itemType: 'unknownFutureTool' },
    { type: 'complete', turnId, status: 'completed', completedAt: 102000 },
  ]);
  assert(!JSON.stringify(f.events).includes('secret'));
  await handle.close();
});

test('buffer overflow replaces pending evidence with one terminal invalidation', async () => {
  const f = fixture(); const handle = await f.native.connect(target, event => f.events.push(event));
  for (let i = 0; i < 140; i++) f.emit('item/started', { turnId, item: { type: 'commandExecution' } });
  handle.listen();
  assert.deepEqual(f.events, [{ type: 'invalidated', reason: 'event-buffer-overflow' }]);
  await assert.rejects(handle.preflight(), /observer unavailable/);
  await handle.close();
});

test('context changes and malformed usage invalidate without exposing native errors or payloads', async () => {
  for (const method of ['thread/compacted', 'thread/settings/updated', 'model/rerouted', 'thread/closed', 'error', 'thread/tokenUsage/updated']) {
    const f = fixture(); const handle = await f.native.connect(target, event => f.events.push(event)); handle.listen();
    f.emit(method, { turnId, error: { message: 'private secret' }, tokenUsage: { total: usage, last: { ...usage, inputTokens: '100' } } });
    assert.equal(f.events.length, 1); assert.equal(f.events[0].type, 'invalidated');
    assert(!JSON.stringify(f.events).includes('secret'));
    await handle.close();
  }
});

test('native disconnect invalidates while intentional close remains silent', async () => {
  const f = fixture(); const handle = await f.native.connect(target, event => f.events.push(event)); handle.listen();
  f.client.emit('disconnected');
  assert.deepEqual(f.events, [{ type: 'invalidated', reason: 'disconnected' }]);
  await handle.close(); assert.equal(f.events.length, 1);
});

test('changed metadata between initial and final preflight prevents rejoin', async () => {
  let reads = 0;
  const f = fixture({ request(method, params, client, thread) { if (method === 'thread/read' && ++reads === 2) thread.reasoningEffort = 'high'; } });
  await assert.rejects(f.native.connect(target, () => {}), /context changed before rejoin/);
  assert(!f.calls.some(x => x.method === 'thread/resume'));
});
