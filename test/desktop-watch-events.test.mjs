import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runDesktopWatch } from '../src/desktop-watch.mjs';
import { SyncEventInbox } from '../src/sync-events.mjs';
import { createSyncEventSource } from '../src/sync-event-source.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cwe-')));
  const state = { version: 2, pending: null, conversations: {}, records: [] };
  const calls = { sync: [], discover: 0, track: [], recover: 0, collect: 0, codex: 0,
    observe: [], acknowledge: [], wait: [], status: [] };
  let clock = 0;
  const runtime = { async codex() { calls.codex++; return { async request(_method, { threadId }) {
    return { thread: { id: threadId, source: 'vscode', status: { type: 'idle' } } };
  } }; }, async ownedNativeIds() { return new Set(); } };
  const bridge = { async status() { return structuredClone(state); },
    async sync(id) { calls.sync.push(id); return { changed: true, incompleteTail: false }; },
    async recover() { calls.recover++; state.pending = null; },
    async collect() { calls.collect++; },
    async track(source) { calls.track.push(source.id); add(source.side, source.id, source.id); } };
  const add = (side = 'claude', nativeId = randomUUID(), id = randomUUID()) => {
    state.conversations[id] = { id, title: 'Synthetic event conversation' };
    const record = { id: randomUUID(), conversationId: id, nativeId, side, verified: true,
      status: 'current', managed: false, kind: 'original' };
    state.records.push(record);
    return { id, nativeId, record, event: kind => ({ side, nativeId, kind, revision: randomUUID(), at: 1 }) };
  };
  const eventQueue = batches => ({ metrics: {}, async observe(batch) { calls.observe.push(structuredClone(batch)); },
    async acknowledge(batch) { calls.acknowledge.push(structuredClone(batch)); },
    async wait(options) {
      calls.wait.push({ timeoutMs: options.timeoutMs });
      if (batches.length) {
        const batch = batches.shift();
        return typeof batch === 'function' ? await batch(options) : batch;
      }
      if (options.timeoutMs !== undefined) { clock += options.timeoutMs; return []; }
      throw new Error('Unexpected unbounded event wait in fixture.');
    } });
  const run = options => runDesktopWatch({ root, bridge, runtime,
    config: { codexHome: join(root, 'codex'), claudeHome: join(root, 'claude'), since: 0 },
    discover: async () => { calls.discover++; return []; }, now: () => clock,
    writeStatus: async (_path, value) => { calls.status.push(structuredClone(value)); },
    sleep: async () => { throw new Error('Event-driven synchronization must not invoke polling sleep.'); }, ...options });
  return { root, state, calls, runtime, bridge, add, eventQueue, run };
}

test('completion events run the startup sweep once, then only synchronize their target', async () => {
  const f = await fixture(), first = f.add(), second = f.add('codex'), third = f.add();
  const batch = [second.event('completed')];
  await f.run({ events: f.eventQueue([batch, [first.event('completed')]]), maxPasses: 3 });
  assert.deepEqual(f.calls.sync, [first.id, second.id, third.id, second.id, first.id]);
  assert.equal(f.calls.discover, 1);
  assert.equal(f.calls.collect, 0);
  assert.deepEqual(f.calls.acknowledge, [batch]);
  assert.ok(f.calls.status.some(status => status.scheduler === 'completion-events'));
});

test('known managed session registration and started events do not trigger synchronization or discovery', async () => {
  const f = await fixture(), pair = f.add('claude');
  pair.record.managed = true; pair.record.kind = 'owner';
  const session = [pair.event('session')], started = [pair.event('started')];
  await f.run({ events: f.eventQueue([session, started]), maxPasses: 3 });
  assert.deepEqual(f.calls.sync, [pair.id]);
  assert.equal(f.calls.discover, 1);
  assert.deepEqual(f.calls.acknowledge, [session]);
  assert.ok(f.calls.observe.some(batch => batch[0]?.kind === 'started'));
});

test('an event for a retained original identity selects its existing logical conversation', async () => {
  const f = await fixture(), pair = f.add('codex');
  const old = { ...pair.record, id: randomUUID(), nativeId: randomUUID(), status: 'original' };
  f.state.records.push(old);
  await f.run({ events: f.eventQueue([[{ side: old.side, nativeId: old.nativeId, kind: 'completed' }]]), maxPasses: 2 });
  assert.deepEqual(f.calls.sync, [pair.id, pair.id]);
  assert.equal(f.calls.discover, 1);
  assert.deepEqual(f.calls.track, []);
});

test('resuming a known original reconciles only that conversation for missed offline completion', async () => {
  const f = await fixture(), pair = f.add('codex'), other = f.add('claude');
  await f.run({ events: f.eventQueue([[pair.event('session')]]), maxPasses: 2 });
  assert.deepEqual(f.calls.sync, [pair.id, other.id, pair.id]);
  assert.equal(f.calls.discover, 1);
});

test('early completion no-change retries are bounded and remain scoped to the changed conversation', async () => {
  const f = await fixture(), first = f.add(), second = f.add();
  f.bridge.sync = async id => { f.calls.sync.push(id); return { changed: false, incompleteTail: false }; };
  await f.run({ events: f.eventQueue([[first.event('completed')]]), maxPasses: 5 });
  assert.deepEqual(f.calls.sync, [first.id, second.id, first.id, first.id, first.id, first.id]);
  assert.equal(f.calls.discover, 1);
  assert.deepEqual(f.calls.wait.map(call => call.timeoutMs), [undefined, 250, 1000, 3000]);
});

test('a new turn start cancels the prior completion retry without scheduling another history read', async () => {
  const f = await fixture(), pair = f.add(), stop = new AbortController();
  f.bridge.sync = async id => { f.calls.sync.push(id); return { changed: false }; };
  await f.run({ signal: stop.signal, events: f.eventQueue([[pair.event('completed')], [pair.event('started')], options => {
    assert.equal(options.timeoutMs, undefined);
    stop.abort(); return [];
  }]) });
  assert.deepEqual(f.calls.sync, [pair.id, pair.id]);
  assert.equal(f.calls.discover, 1);
});

test('pending recovery precedes an event target without another discovery, enrollment or input replay', async () => {
  const f = await fixture(), first = f.add(), second = f.add();
  const order = [];
  f.bridge.recover = async () => { order.push('recover'); f.calls.recover++; f.state.pending = null; };
  f.bridge.sync = async id => {
    assert.equal(f.state.pending, null);
    f.calls.sync.push(id); order.push(`sync:${id}`); return { changed: true };
  };
  await f.run({ maxPasses: 2, events: f.eventQueue([() => {
    order.length = 0;
    f.state.pending = { operationId: randomUUID(), phase: 'applied' };
    return [second.event('completed')];
  }]) });
  assert.deepEqual(order, ['recover', `sync:${second.id}`]);
  assert.deepEqual(f.calls.sync, [first.id, second.id, second.id]);
  assert.equal(f.calls.discover, 1);
  assert.deepEqual(f.calls.track, []);
});

test('idle event source sleeps until cancellation without repeated native or discovery calls', async () => {
  const f = await fixture(), pair = f.add();
  const inbox = await new SyncEventInbox({ root: f.root }).initialize();
  const events = await createSyncEventSource({ root: f.root, runtime: f.runtime, inbox });
  const stop = new AbortController(), originalWait = events.wait;
  let idleTimer;
  events.wait = async options => {
    idleTimer = setTimeout(() => stop.abort(), 180);
    return originalWait(options);
  };
  try { await f.run({ events, signal: stop.signal }); }
  finally { clearTimeout(idleTimer); await events.close(); }
  assert.deepEqual(f.calls.sync, [pair.id]);
  assert.equal(f.calls.discover, 1);
  assert.equal(f.calls.codex, 1);
  assert.equal(f.calls.collect, 0);
  assert.deepEqual(await inbox.list(), []);
});

test('a newer real inbox revision arriving during sync survives acknowledgement of the old event', async () => {
  const f = await fixture(), pair = f.add();
  const inbox = await new SyncEventInbox({ root: f.root }).initialize();
  const first = await inbox.publish({ side: 'claude', nativeId: pair.nativeId, kind: 'completed', turnId: 'first' });
  let newer;
  f.bridge.sync = async id => {
    f.calls.sync.push(id);
    if (f.calls.sync.length === 2) newer = await inbox.publish({ side: 'claude', nativeId: pair.nativeId,
      kind: 'completed', turnId: 'second' });
    return { changed: true };
  };
  const batches = [];
  const events = { metrics: {}, observe: async () => {}, acknowledge: batch => inbox.acknowledge(batch),
    async wait(options) { const batch = await inbox.wait(options); batches.push(batch); return batch; } };
  await f.run({ events, maxPasses: 3 });
  assert.deepEqual(f.calls.sync, [pair.id, pair.id, pair.id]);
  assert.equal(batches[0][0].revision, first.revision);
  assert.equal(batches[1][0].revision, newer.revision);
  assert.notEqual(first.revision, newer.revision);
  assert.equal((await inbox.list())[0].revision, newer.revision);
});

test('new-source completion before the first complete turn is published gets a bounded enrollment retry', async () => {
  const f = await fixture(), existing = f.add(), sourceId = randomUUID();
  let hookReceived = false, attempts = 0;
  f.bridge.track = async source => {
    f.calls.track.push(source.id); attempts++;
    if (attempts === 1) throw new Error('Wait for a complete assistant turn or verified synchronized checkpoint.');
    f.add(source.side, source.id, source.id);
  };
  await f.run({ maxPasses: 3,
    discover: async () => { f.calls.discover++; return hookReceived && !f.state.conversations[sourceId]
      ? [{ side: 'claude', id: sourceId, path: '/synthetic/source.jsonl' }] : []; },
    events: f.eventQueue([() => { hookReceived = true; return [{ side: 'claude', nativeId: sourceId, kind: 'completed' }]; }]) });
  assert.deepEqual(f.calls.track, [sourceId, sourceId]);
  assert.deepEqual(f.calls.sync, [existing.id, sourceId]);
  assert.equal(f.calls.wait[1].timeoutMs, 250);
});
