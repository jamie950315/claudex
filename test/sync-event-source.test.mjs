import test from 'node:test';
import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SyncEventInbox } from '../src/sync-events.mjs';
import { createSyncEventSource, RECONNECT_ID, CONFIG_ID } from '../src/sync-event-source.mjs';

async function fixture(t, { shared = true, nativeHomes = false, syntheticWatches = false } = {}) {
  // Keep the private Unix socket beneath macOS sockaddr_un's path bound.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cse-')));
  const inbox = await new SyncEventInbox({ root }).initialize();
  if (shared) await mkdir(join(root, 'codex-shared'), { mode: 0o700 });
  const runtime = { onEvent: () => {}, owners: new Map() };
  if (nativeHomes) {
    runtime.codexHome = join(root, 'codex'); runtime.claudeHome = join(root, 'claude');
    await mkdir(runtime.codexHome, { mode: 0o700 }); await mkdir(runtime.claudeHome, { mode: 0o700 });
  }
  const traces = [], listeners = new Map(), startedAt = Date.now();
  const source = await createSyncEventSource({ root, runtime, inbox, settleMs: 10, watchFactory: (path, listener) => {
    traces.push({ at: Date.now() - startedAt, path: path.slice(root.length), operation: 'watch' });
    if (syntheticWatches) {
      const watcher = new EventEmitter(); listeners.set(path, listener);
      watcher.close = () => listeners.delete(path);
      return watcher;
    }
    return watch(path, (type, filename) => {
      traces.push({ at: Date.now() - startedAt, path: path.slice(root.length), type, filename: filename === null ? null : String(filename) });
      listener(type, filename);
    });
  } });
  t.after(async () => { await source.close(); await rm(root, { recursive: true, force: true }); });
  return { root, runtime, source, inbox, traces, emitWatch: (path, filename) => listeners.get(path)?.('change', filename) };
}

test('native completion forwards only bounded identity and disconnection wakes reconciliation', async t => {
  const { runtime, source } = await fixture(t), nativeId = randomUUID();
  await runtime.onEvent({ type: 'codex_notification', event: { method: 'turn/completed', params: { threadId: nativeId,
    turn: { id: 'turn-1', text: 'private transcript' } } } });
  const batch = await source.wait({ timeoutMs: 100 });
  assert.equal(batch.length, 1); assert.equal(batch[0].nativeId, nativeId);
  assert.equal(batch[0].turnId, 'turn-1'); assert.doesNotMatch(JSON.stringify(batch), /private transcript/);
  await source.acknowledge(batch);
  await runtime.onEvent({ type: 'codex_disconnected' });
  assert.equal((await source.wait({ timeoutMs: 100 }))[0].nativeId, RECONNECT_ID);
});

test('owned no-query receipts and unverified Claude results do not wake synchronization', async t => {
  const { runtime, source } = await fixture(t), nativeId = randomUUID();
  const status = { sessionId: nativeId, nativeState: 'idle' };
  runtime.owners.set('logical', { owner: { status: () => status } });
  const emit = event => runtime.onEvent({ type: 'claude_notification', conversationId: 'logical', event });
  await emit({ type: 'owner_append_receipt' });
  await emit({ type: 'native_event', event: { type: 'result', num_turns: 0, duration_api_ms: 0 } });
  status.pending = 'append';
  await emit({ type: 'native_event', event: { type: 'result', num_turns: 1 } });
  assert.deepEqual(await source.wait({ timeoutMs: 30 }), []);
  status.pending = null;
  await emit({ type: 'native_event', event: { type: 'result', session_id: nativeId, num_turns: 1 } });
  assert.equal((await source.wait({ timeoutMs: 100 }))[0].kind, 'completed');
});

test('owner wake revisions remain separate from completion hints and never arm transcripts', async t => {
  const { root, inbox, source } = await fixture(t), nativeId = randomUUID(), path = join(root, 'synthetic.jsonl');
  await writeFile(path, 'Synthetic native bytes.');
  const completion = await inbox.publish({ side: 'claude', nativeId, kind: 'completed' });
  const wake = await inbox.publish({ side: 'claude', nativeId, kind: 'owner-wake', remoteId: 'cse_synthetic' });
  assert.deepEqual(await source.current([completion, wake]), [completion, wake]);
  await source.observe([wake], { records: [{ side: 'claude', nativeId, path, verified: true, status: 'current' }] });
  assert.equal(source.metrics.armedSources, 0);
  await source.acknowledge([wake]);
  assert.deepEqual(await inbox.list(), [completion]);
  await inbox.publish({ side: 'claude', nativeId, kind: 'owner-wake', remoteId: 'cse_synthetic' });
  assert.deepEqual(await source.current([completion, wake]), [completion]);
});

test('only completion-armed trusted transcript changes wake; next turn disarms', async t => {
  const { root, source, traces } = await fixture(t), nativeId = randomUUID(), path = join(root, 'source.jsonl');
  await writeFile(path, 'one');
  const event = { side: 'claude', nativeId, kind: 'completed' };
  const state = { records: [{ side: 'claude', nativeId, path, verified: true, status: 'current' }] };
  await writeFile(path, 'before completion');
  assert.deepEqual(await source.wait({ timeoutMs: 30 }), []);
  await source.observe([event], state);
  const pending = source.wait({ timeoutMs: 1000 });
  await writeFile(join(root, 'unrelated.json'), 'unrelated');
  await writeFile(join(root, 'replacement'), 'last message');
  await rename(join(root, 'replacement'), path);
  const batch = await pending;
  assert.equal(batch.length, 1, JSON.stringify(traces)); assert.equal(batch[0].kind, 'changed');
  await source.acknowledge(batch);
  await source.observe([{ ...event, kind: 'started' }], state);
  // The same rename may deliver a later OS notification (macOS can omit its
  // filename) that published another hint while the source was still armed.
  // Drain only hints already published before disarming; after it nothing may wake.
  const late = await source.wait({ timeoutMs: 1 });
  assert.ok(late.every(item => item.kind === 'changed' && item.nativeId === nativeId), JSON.stringify(late));
  if (late.length) await source.acknowledge(late);
  await writeFile(path, 'token streaming');
  assert.deepEqual(await source.wait({ timeoutMs: 50 }), []);
  assert.equal(source.metrics.armedSources, 0);
});

test('unknown hook identity cannot arm arbitrary input paths and idle status writes stay quiet', async t => {
  const { root, source } = await fixture(t);
  await source.observe([{ side: 'claude', nativeId: randomUUID(), kind: 'completed', path: '/tmp/untrusted' }], { records: [] });
  assert.equal(source.metrics.armedSources, 0);
  await writeFile(join(root, 'watcher-status.json'), '{}');
  await writeFile(join(root, 'codex-shared', 'irrelevant.json'), '{}');
  assert.deepEqual(await source.wait({ timeoutMs: 50 }), []);
});

test('filename-less directory notices only wake completion-armed files whose metadata changed', async t => {
  const { root, source, emitWatch } = await fixture(t, { syntheticWatches: true });
  const first = randomUUID(), second = randomUUID();
  const paths = [join(root, 'first.jsonl'), join(root, 'second.jsonl')];
  await Promise.all(paths.map(path => writeFile(path, 'initial')));
  const state = { records: paths.map((path, index) => ({ side: 'claude', nativeId: [first, second][index],
    path, verified: true, status: 'current' })) };
  await source.observe([first, second].map(nativeId => ({ side: 'claude', nativeId, kind: 'completed' })), state);
  emitWatch(root, null);
  assert.deepEqual(await source.wait({ timeoutMs: 50 }), []);
  assert.equal(source.metrics.fileEvents, 0);
  await writeFile(paths[0], 'completed flush');
  emitWatch(root, null);
  const batch = await source.wait({ timeoutMs: 1000 });
  assert.deepEqual(batch.map(event => event.nativeId), [first]);
  await source.acknowledge(batch);
  emitWatch(root, null);
  assert.deepEqual(await source.wait({ timeoutMs: 50 }), []);
  await rm(paths[0]);
  emitWatch(root, null);
  const removed = await source.wait({ timeoutMs: 1000 });
  assert.deepEqual(removed.map(event => event.nativeId), [first]);
  await source.acknowledge(removed);
  await writeFile(paths[0], 'restored');
  emitWatch(root, null);
  const restored = await source.wait({ timeoutMs: 1000 });
  assert.deepEqual(restored.map(event => event.nativeId), [first]);
});

test('retired or removed transcript records release their completion subscriptions', async t => {
  const { root, source, emitWatch } = await fixture(t, { syntheticWatches: true }), nativeId = randomUUID();
  const path = join(root, 'transcript.jsonl');
  await writeFile(path, 'initial');
  const record = { side: 'claude', nativeId, path, verified: true, status: 'current' };
  await source.observe([{ side: 'claude', nativeId, kind: 'completed' }], { records: [record] });
  assert.equal(source.metrics.armedSources, 1);
  await source.observe([], { records: [{ ...record, status: 'retired' }] });
  assert.equal(source.metrics.armedSources, 0);
  await writeFile(path, 'old snapshot changed');
  emitWatch(root, 'transcript.jsonl');
  assert.deepEqual(await source.wait({ timeoutMs: 50 }), []);
  await source.observe([{ side: 'claude', nativeId, kind: 'completed' }], { records: [record] });
  await source.observe([], { records: [] });
  assert.equal(source.metrics.armedSources, 0);
});

test('closing while a completion is being observed cannot create a late subscription', async t => {
  const { root, source } = await fixture(t, { syntheticWatches: true }), nativeId = randomUUID();
  const path = join(root, 'transcript.jsonl');
  await writeFile(path, 'initial');
  const state = { records: [{ side: 'claude', nativeId, path, verified: true, status: 'current' }] };
  await Promise.all([source.observe([{ side: 'claude', nativeId, kind: 'completed' }], state), source.close()]);
  assert.equal(source.metrics.armedSources, 0);
});

test('closing restores previous callback and aborts a sleeping wait', async t => {
  const { runtime, source } = await fixture(t);
  const pending = source.wait();
  await source.close();
  assert.deepEqual(await pending, []);
  assert.equal(source.metrics.armedSources, 0);
  assert.equal(typeof runtime.onEvent, 'function');
});

test('superseded source eligibility uses exact case-normalized identity and absent parents defer to bridge guards', async t => {
  // Eligibility is a deterministic contract; the separate rename test exercises real OS delivery.
  const { root, source, traces, emitWatch } = await fixture(t, { syntheticWatches: true }), nativeId = randomUUID();
  const event = { side: 'claude', nativeId: nativeId.toUpperCase(), kind: 'completed' };
  const record = { side: 'claude', nativeId, path: join(root, 'missing', 'source.jsonl'), verified: true, status: 'original' };
  await source.observe([event], { records: [record] });
  assert.equal(source.metrics.armedSources, 0);
  record.path = join(root, 'source.jsonl');
  for (const status of ['original', 'dependency-anchor', 'previous']) {
    record.status = status;
    await source.observe([event], { records: [record] });
    assert.equal(source.metrics.armedSources, 1);
    await writeFile(record.path, status);
    emitWatch(root, 'source.jsonl');
    const batch = await source.wait({ timeoutMs: 1000 });
    assert.equal(batch.length, 1, `Expected late write for ${status}: ${JSON.stringify(source.metrics)} ${JSON.stringify(traces)}`);
    assert.equal(batch[0].nativeId, nativeId);
    await source.acknowledge(batch);
    await source.observe([{ ...event, kind: 'started' }], { records: [record] });
  }
});

test('failed Codex turns wake as interrupted and entry-level Claude maintenance stays quiet', async t => {
  const { runtime, source } = await fixture(t), nativeId = randomUUID();
  for (const status of ['failed', 'interrupted']) {
    await runtime.onEvent({ type: 'codex_notification', event: { method: 'turn/completed', params: {
      threadId: nativeId, turn: { id: status, status } } } });
    const batch = await source.wait({ timeoutMs: 100 });
    assert.equal(batch[0].kind, 'interrupted');
    await source.acknowledge(batch);
  }
  runtime.owners.set('maintenance', { maintenanceOnly: true, owner: { status: () => ({ sessionId: nativeId }) } });
  await runtime.onEvent({ type: 'claude_notification', conversationId: 'maintenance', event: {
    type: 'native_event', event: { type: 'result', num_turns: 1 } } });
  assert.deepEqual(await source.wait({ timeoutMs: 30 }), []);
});

test('a late private backend directory attaches without polling and replacement reattaches', async t => {
  const { root, source, traces } = await fixture(t, { shared: false });
  await writeFile(join(root, 'watcher-status.json'), '{}');
  assert.deepEqual(await source.wait({ timeoutMs: 40 }), []);
  const shared = join(root, 'codex-shared');
  await mkdir(shared, { mode: 0o700 });
  let batch = await source.wait({ timeoutMs: 1000 });
  assert.equal(batch[0].nativeId, RECONNECT_ID);
  await source.acknowledge(batch);
  await writeFile(join(shared, 'owner.json'), '{}');
  batch = await source.wait({ timeoutMs: 1000 });
  assert.equal(batch.length, 1, JSON.stringify(traces));
  assert.equal(batch[0].kind, 'reconnect');
  await source.acknowledge(batch);
  await rename(shared, join(root, 'old-backend'));
  await mkdir(shared, { mode: 0o700 });
  batch = await source.wait({ timeoutMs: 1000 });
  assert.equal(batch[0].kind, 'reconnect');
});

test('an unsafe newly created backend directory fails the waiter explicitly', async t => {
  // Directory validation is the contract here; macOS can drop a notification for a
  // just-registered watcher, and the reconnect rename test exercises real OS delivery.
  const { root, source, traces, emitWatch } = await fixture(t, { shared: false, syntheticWatches: true });
  const staging = join(root, 'unsafe');
  await mkdir(staging); await chmod(staging, 0o755);
  await rename(staging, join(root, 'codex-shared'));
  emitWatch(root, 'codex-shared');
  await assert.rejects(source.wait({ timeoutMs: 1000 }), /Unsafe native synchronization connection directory/, JSON.stringify(traces));
});

test('native turn start durably disarms and queued changed hints cannot rearm streaming', async t => {
  const { root, runtime, source } = await fixture(t), nativeId = randomUUID(), path = join(root, 'stream.jsonl');
  const event = { side: 'codex', nativeId, kind: 'completed' };
  const state = { records: [{ side: 'codex', nativeId, path, verified: true, status: 'current' }] };
  await writeFile(path, 'initial');
  await source.observe([event], state);
  await runtime.onEvent({ type: 'codex_notification', event: { method: 'turn/started', params: { threadId: nativeId } } });
  const batch = await source.wait({ timeoutMs: 1000 });
  assert.equal(batch[0].kind, 'started');
  await source.acknowledge(batch);
  await source.observe([{ ...event, kind: 'changed' }], state);
  assert.equal(source.metrics.armedSources, 0);
  await writeFile(path, 'streaming tokens');
  assert.deepEqual(await source.wait({ timeoutMs: 40 }), []);
  await runtime.onEvent({ type: 'codex_notification', event: { method: 'turn/completed', params: { threadId: nativeId } } });
  const completed = await source.wait({ timeoutMs: 1000 });
  await source.observe(completed, state);
  assert.equal(source.metrics.armedSources, 1);
});

test('current filters stale completed receipts after draining newer native start publication', async t => {
  const { root, runtime, source, inbox } = await fixture(t), nativeId = randomUUID(), path = join(root, 'source.jsonl');
  await writeFile(path, 'before next turn');
  const state = { records: [{ side: 'codex', nativeId, path, verified: true, status: 'current' }] };
  const prior = await inbox.publish({ side: 'codex', nativeId, kind: 'completed' });
  await runtime.onEvent({ type: 'codex_notification', event: { method: 'turn/started', params: { threadId: nativeId } } });
  assert.deepEqual(await source.current([{ ...prior, retryAttempt: 3 }]), []);
  await source.observe([prior], state);
  assert.equal(source.metrics.armedSources, 0);
  const started = (await inbox.list())[0];
  await inbox.acknowledge([started]);
  assert.deepEqual(await source.current([{ ...started, retryAttempt: 2 }]), [{ ...started, retryAttempt: 2 }]);
  assert.deepEqual(await source.current([prior]), []);
  const synthetic = { side: 'codex', nativeId: RECONNECT_ID, kind: 'reconnect' };
  assert.deepEqual(await source.current([synthetic]), [synthetic]);
});

test('a native start arriving after receipt validation prevents a stale completion from arming', async t => {
  const { root, runtime, source, inbox } = await fixture(t, { syntheticWatches: true }), nativeId = randomUUID();
  const path = join(root, 'source.jsonl');
  await writeFile(path, 'initial');
  const completion = await inbox.publish({ side: 'codex', nativeId, kind: 'completed' });
  const originalRead = inbox.read.bind(inbox);
  let firstRead = true, started;
  inbox.read = async () => {
    const state = await originalRead();
    if (firstRead) {
      firstRead = false;
      Object.defineProperty(state.entries[`codex:${nativeId}`], 'revision', { get() {
        started = runtime.onEvent({ type: 'codex_notification', event: {
          method: 'turn/started', params: { threadId: nativeId },
        } });
        return completion.revision;
      } });
    }
    return state;
  };
  await source.observe([completion], { records: [{ side: 'codex', nativeId, path, verified: true, status: 'current' }] });
  await started;
  assert.equal(source.metrics.armedSources, 0);
  assert.equal((await inbox.list())[0].kind, 'started');
});

test('filename-less root notices attach a newly created native backend', async t => {
  const { root, source, emitWatch } = await fixture(t, { shared: false, syntheticWatches: true });
  await mkdir(join(root, 'codex-shared'), { mode: 0o700 });
  emitWatch(root, null);
  const batch = await source.wait({ timeoutMs: 100 });
  assert.equal(batch.length, 1);
  assert.equal(batch[0].kind, 'reconnect');
});

test('filename-less backend and configuration notices detect exact changed metadata', async t => {
  const { root, runtime, source, emitWatch } = await fixture(t, { nativeHomes: true, syntheticWatches: true });
  const shared = join(root, 'codex-shared');
  for (const [parent, name, kind] of [[shared, 'owner.json', 'reconnect'],
    [runtime.codexHome, 'config.toml', 'configuration'], [runtime.claudeHome, 'settings.json', 'configuration']]) {
    emitWatch(parent, null);
    assert.deepEqual(await source.wait({ timeoutMs: 30 }), []);
    await writeFile(join(parent, name), 'private metadata contents');
    emitWatch(parent, null);
    const batch = await source.wait({ timeoutMs: 100 });
    assert.equal(batch.length, 1);
    assert.equal(batch[0].kind, kind);
    assert.doesNotMatch(JSON.stringify(batch), /private metadata/);
    await source.acknowledge(batch);
    emitWatch(parent, null);
    assert.deepEqual(await source.wait({ timeoutMs: 30 }), []);
    await rm(join(parent, name));
    emitWatch(parent, null);
    const removed = await source.wait({ timeoutMs: 100 });
    assert.equal(removed[0]?.kind, kind);
    await source.acknowledge(removed);
    await writeFile(join(parent, name), 'restored metadata contents');
    emitWatch(parent, null);
    const restored = await source.wait({ timeoutMs: 100 });
    assert.equal(restored[0]?.kind, kind);
    await source.acknowledge(restored);
  }
});

test('native configuration changes emit metadata-only wakes without watching histories', async t => {
  const { runtime, source, traces } = await fixture(t, { nativeHomes: true });
  await writeFile(join(runtime.codexHome, 'unrelated.jsonl'), 'native history');
  await writeFile(join(runtime.claudeHome, 'session.jsonl'), 'native history');
  assert.deepEqual(await source.wait({ timeoutMs: 40 }), []);
  for (const [home, filename] of [[runtime.codexHome, 'hooks.json'], [runtime.codexHome, 'config.toml'], [runtime.claudeHome, 'settings.json']]) {
    await writeFile(join(home, filename), 'private settings');
    const batch = await source.wait({ timeoutMs: 1000 });
    assert.equal(batch.length, 1, `${filename}: ${JSON.stringify(traces)}`);
    assert.equal(batch[0].kind, 'configuration'); assert.equal(batch[0].nativeId, CONFIG_ID);
    assert.doesNotMatch(JSON.stringify(batch), /private settings|native history/);
    await source.acknowledge(batch);
  }
});

test('blocked Claude owner errors wake inspection without persisting diagnostics or querying', async t => {
  const { runtime, source } = await fixture(t), nativeId = randomUUID();
  runtime.owners.set('blocked', { maintenanceOnly: true, owner: { status: () => ({
    sessionId: nativeId, blocked: 'private diagnostic', pending: 'append', maintenanceOnly: true,
  }) } });
  await runtime.onEvent({ type: 'claude_notification', conversationId: 'blocked', event: {
    type: 'owner_error', message: 'private diagnostic', transcript: 'private history',
  } });
  const batch = await source.wait({ timeoutMs: 1000 });
  assert.equal(batch[0].nativeId, nativeId); assert.equal(batch[0].kind, 'interrupted');
  assert.doesNotMatch(JSON.stringify(batch), /private/);
  await source.acknowledge(batch);
  await runtime.onEvent({ type: 'claude_notification', conversationId: 'blocked', event: { type: 'owner_append_receipt' } });
  assert.deepEqual(await source.wait({ timeoutMs: 40 }), []);
});
