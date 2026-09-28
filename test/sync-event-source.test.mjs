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
  const { root, source, traces } = await fixture(t, { shared: false });
  const staging = join(root, 'unsafe');
  await mkdir(staging); await chmod(staging, 0o755);
  await rename(staging, join(root, 'codex-shared'));
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
