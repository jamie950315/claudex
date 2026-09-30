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

function presentationOptions(f, { failHandoff, failFolders } = {}) {
  const presentation = { handoffs: [], folders: 0, maintenance: 0, order: [] };
  const options = {
    config: { codexHome: join(f.root, 'codex'), claudeHome: join(f.root, 'claude'), since: 0,
      desktopLocalHandoff: { enabled: true }, folderProjection: { enabled: true } },
    createHandoffPublisher: () => ({ async publish(state, scope) {
      presentation.handoffs.push(structuredClone(scope)); presentation.order.push('handoff');
      if (failHandoff?.(scope, presentation)) throw new Error('Synthetic handoff publication failed.');
      return { changed: true, actions: scope.conversationIds?.length === 0 ? 0 : 1,
        anchors: Object.keys(state.conversations).length, deferred: null };
    } }),
    publishFolders: async () => {
      presentation.folders++; presentation.order.push('folders');
      if (failFolders?.(presentation)) throw new Error('Synthetic folder publication failed.');
      return { entries: Object.keys(f.state.conversations).length, deferred: null };
    },
    maintainFolders: async () => { presentation.maintenance++; return { ready: true }; },
  };
  return { options, presentation };
}

const configurationEvent = () => ({ side: 'codex', nativeId: '00000000-0000-4000-8000-000000000002',
  kind: 'configuration', revision: randomUUID(), at: 1 });

test('unsupported sources remain visible across configuration and unrelated targeted discovery', async () => {
  const f = await fixture(), pair = f.add();
  const unsupportedId = randomUUID(), unrelatedId = randomUUID();
  const unsupported = { side: 'codex', id: unsupportedId, path: '/synthetic/unsupported.jsonl' };
  const unrelated = { side: 'claude', id: unrelatedId, path: `/synthetic/${unrelatedId}.jsonl` };
  const track = f.bridge.track;
  f.bridge.track = async source => {
    if (source.id === unsupportedId) throw new Error('Native Codex history export: an assistant message precedes the turn user input.');
    return track(source);
  };
  await f.run({ discover: async options => {
    f.calls.discover++;
    return options.onlyKeys ? [unrelated] : [unsupported];
  }, events: f.eventQueue([[configurationEvent()], [pair.event('completed')],
    [{ side: 'claude', nativeId: unrelatedId, kind: 'session' }]]), maxPasses: 4 });
  assert.equal(f.calls.discover, 2);
  const statuses = f.calls.status.filter(status => status.running && status.initialSweepCompletedAt !== null);
  assert.ok(statuses.length > 3);
  for (const status of statuses) {
    assert.equal(status.blockedSourceCount, 1);
    assert.equal(status.blockedSources[0].nativeId, unsupportedId);
    assert.match(status.blockedSources[0].reason, /assistant message precedes/);
  }
  assert.ok(f.state.conversations[unrelatedId]);
  assert.equal(f.state.conversations[unsupportedId], undefined);
});

test('exact source reinspection clears its diagnostic after successful enrollment', async () => {
  const f = await fixture(), nativeId = randomUUID();
  const source = { side: 'codex', id: nativeId, path: '/synthetic/unsupported.jsonl' };
  let supported = false;
  const track = f.bridge.track;
  f.bridge.track = async candidate => {
    if (!supported) throw new Error('Native Codex history export: an assistant message precedes the turn user input.');
    return track(candidate);
  };
  await f.run({ discover: async () => [source], events: f.eventQueue([[configurationEvent()], () => {
    supported = true;
    return [{ side: 'codex', nativeId, kind: 'session' }];
  }]), maxPasses: 3 });
  const statuses = f.calls.status.filter(status => status.running);
  assert.ok(statuses.some(status => status.blockedSourceCount === 1));
  assert.equal(statuses.at(-1).blockedSourceCount, 0);
  assert.deepEqual(statuses.at(-1).blockedSources, []);
  assert.ok(f.state.conversations[nativeId]);
});

test('unchanged configuration events refresh hooks without repeating presentation publication', async () => {
  const f = await fixture(), pair = f.add(), { options, presentation } = presentationOptions(f);
  let hooks = 0, clock = 0;
  f.runtime.synchronizationHooks = async () => ({ ready: true, inspections: ++hooks });
  await f.run({ ...options, now: () => clock, events: f.eventQueue(Array.from({ length: 8 }, () => () => {
    clock += 20_000; return [configurationEvent()];
  })), maxPasses: 9 });
  assert.equal(hooks, 9);
  assert.equal(f.calls.codex, 9);
  assert.deepEqual(f.calls.sync, [pair.id]);
  assert.equal(f.calls.discover, 1);
  assert.deepEqual(presentation.handoffs, [{}, {}, {}, { conversationIds: [] }]);
  assert.equal(presentation.folders, 4);
  assert.equal(presentation.maintenance, 1);
  const final = f.calls.status.filter(status => status.running).at(-1);
  assert.equal(final.localHandoff.actions, 0);
  assert.equal(final.localHandoff.updatedAt, 20_000);
  assert.equal(final.folderProjection.updatedAt, 20_000);
  assert.equal(final.updatedAt, 160_000);
});

test('configuration hook readiness changes remain visible while empty presentation stays unchanged', async () => {
  const f = await fixture(), { options, presentation } = presentationOptions(f);
  f.add();
  let checks = 0;
  f.runtime.synchronizationHooks = async () => ++checks < 3 ? { ready: true } : { ready: false, reason: 'Review native hooks.' };
  await f.run({ ...options, events: f.eventQueue([[configurationEvent()], [configurationEvent()]]), maxPasses: 3 });
  assert.equal(checks, 3);
  assert.equal(presentation.handoffs.length, 4);
  const final = f.calls.status.filter(status => status.running).at(-1);
  assert.equal(final.synchronization, 'blocked');
  assert.equal(final.blocked.scope, 'hooks');
  assert.equal(final.blocked.reason, 'Review native hooks.');
});

test('a ledger change invalidates configuration-only presentation reuse', async () => {
  const f = await fixture(), pair = f.add(), { options, presentation } = presentationOptions(f);
  await f.run({ ...options, events: f.eventQueue([[configurationEvent()], () => {
    f.state.conversations[pair.id].title = 'Changed synthetic title'; return [configurationEvent()];
  }, [configurationEvent()]]), maxPasses: 4 });
  assert.equal(presentation.handoffs.length, 5);
  assert.equal(presentation.folders, 5);
  assert.deepEqual(f.calls.sync, [pair.id]);
});

test('pending recovery runs before configuration presentation and forces publication even when the ledger returns unchanged', async () => {
  const f = await fixture(), pair = f.add(), { options, presentation } = presentationOptions(f);
  f.bridge.recover = async () => {
    presentation.order.push('recover'); f.calls.recover++; f.state.pending = null;
  };
  await f.run({ ...options, events: f.eventQueue([[configurationEvent()], () => {
    presentation.order.length = 0;
    f.state.pending = { operationId: randomUUID(), phase: 'applied', record: { conversationId: pair.id } };
    return [configurationEvent()];
  }]), maxPasses: 3 });
  assert.deepEqual(presentation.order, ['recover', 'handoff', 'folders']);
  assert.equal(presentation.handoffs.length, 5);
  assert.equal(presentation.folders, 5);
  assert.equal(f.calls.recover, 1);
});

for (const publisher of ['handoff', 'folders']) test(`a failed ${publisher} publisher is retried on configuration before reuse`, async () => {
  const f = await fixture(), { options, presentation } = presentationOptions(f, {
    failHandoff: publisher === 'handoff' ? (_scope, p) => p.handoffs.length === 4 : undefined,
    failFolders: publisher === 'folders' ? p => p.folders === 4 : undefined,
  });
  f.add();
  await f.run({ ...options, events: f.eventQueue(Array.from({ length: 3 }, () => [configurationEvent()])), maxPasses: 4 });
  assert.equal(presentation.handoffs.length, 5);
  assert.equal(presentation.folders, 5);
  const field = publisher === 'handoff' ? 'localHandoff' : 'folderProjection';
  assert.ok(f.calls.status.some(status => status[field]?.state === 'error'));
  assert.equal(f.calls.status.filter(status => status.running).at(-1)[field].state, 'ready');
});

test('native lifecycle, completion and reconnect keep normal publication and empty-scope revocation', async () => {
  const f = await fixture(), pair = f.add(), { options, presentation } = presentationOptions(f);
  await f.run({ ...options, events: f.eventQueue([[configurationEvent()], [pair.event('started')],
    [configurationEvent()], [pair.event('completed')], [configurationEvent()],
    [{ side: 'codex', nativeId: '00000000-0000-4000-8000-000000000001', kind: 'reconnect' }]]), maxPasses: 7 });
  assert.deepEqual(presentation.handoffs, [{}, {}, {}, { conversationIds: [] }, { conversationIds: [] },
    { conversationIds: [pair.id] }, { conversationIds: [] }, {}, {}]);
  assert.equal(presentation.folders, 9);
  assert.deepEqual(f.calls.sync, [pair.id, pair.id, pair.id]);
  assert.equal(f.calls.discover, 2);
});

test('transport failure during a configuration pass remains visible and prevents presentation reuse', async () => {
  const f = await fixture(), { options, presentation } = presentationOptions(f);
  f.add();
  const original = f.runtime.codex;
  f.runtime.codex = async () => {
    if (f.calls.codex === 2) { f.calls.codex++; throw new Error('Shared Codex transport is not connected.'); }
    return original();
  };
  await f.run({ ...options, events: f.eventQueue([[configurationEvent()], [configurationEvent()]]), maxPasses: 3 });
  assert.equal(presentation.handoffs.length, 5);
  assert.equal(presentation.folders, 5);
  const final = f.calls.status.filter(status => status.running).at(-1);
  assert.equal(final.synchronization, 'waiting');
  assert.match(final.waiting, /Shared Codex transport/);
});

test('pending history failure during a configuration pass keeps its evidence and visible hold', async () => {
  const f = await fixture(), pair = f.add(), { options, presentation } = presentationOptions(f);
  f.bridge.recover = async () => {
    f.calls.recover++;
    throw Object.assign(new Error('Saved synthetic history is unavailable.'), {
      code: 'CLAUDEX_TRACKED_HISTORY_UNAVAILABLE', conversationId: pair.id,
      side: 'claude', nativeId: pair.nativeId, savedPath: '/synthetic/unavailable.jsonl',
    });
  };
  await f.run({ ...options, events: f.eventQueue([[configurationEvent()], () => {
    f.state.pending = { operationId: randomUUID(), phase: 'applied', record: { conversationId: pair.id } };
    return [configurationEvent()];
  }]), maxPasses: 3 });
  assert.equal(f.calls.recover, 1);
  assert.equal(f.state.pending.phase, 'applied');
  assert.equal(presentation.handoffs.length, 5);
  const final = f.calls.status.filter(status => status.running).at(-1);
  assert.equal(final.synchronization, 'blocked');
  assert.equal(final.blocked.scope, 'pending');
  assert.equal(final.blocked.conversationId, pair.id);
  assert.match(final.blocked.reason, /Saved synthetic history/);
});

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

test('cancellation during idle status publication reaches the subsequent event wait', async () => {
  const f = await fixture(), stop = new AbortController();
  f.add();
  await f.run({ signal: stop.signal,
    writeStatus: async (_path, value) => {
      f.calls.status.push(structuredClone(value));
      if (value.awaitingEvents) stop.abort();
    },
    events: f.eventQueue([options => {
      assert.equal(options.signal.aborted, true, 'An abort received before waiter registration must remain visible.');
      return [];
    }]),
  });
  assert.equal(f.calls.wait.length, 1);
  assert.equal(f.calls.status.at(-1).running, false);
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

test('Claude path-only discovery binds the hook identity before enrollment', async () => {
  const f = await fixture(), existing = f.add(), nativeId = randomUUID(), unrelated = randomUUID();
  let received = false;
  f.bridge.track = async source => {
    assert.equal(source.nativeId, nativeId);
    f.calls.track.push(source.nativeId);
    f.add(source.side, source.nativeId, source.nativeId);
  };
  await f.run({ maxPasses: 2,
    discover: async () => { f.calls.discover++; return received ? [
      { side: 'claude', path: `/synthetic/projects/${unrelated}.jsonl` },
      { side: 'claude', path: `/synthetic/projects/${nativeId}.jsonl` },
    ] : []; },
    events: f.eventQueue([() => { received = true; return [{ side: 'claude', nativeId, kind: 'completed' }]; }]) });
  assert.deepEqual(f.calls.track, [nativeId]);
  assert.deepEqual(f.calls.sync, [existing.id, nativeId]);
});
