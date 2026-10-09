import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { runDesktopWatch } from '../src/desktop-watch.mjs';

const refusal = 'Frontend cache discovery or maintenance refused; no native work was restarted';
const skipped = { state: 'skipped', reason: refusal };
const ready = { state: 'ready', adapters: { folders: { status: 'matched', activation: 'load-not-verified' } } };

async function idleWatcher(t, { initial = skipped, mapError = null, deferred = null } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-renderer-status-')));
  const controller = new AbortController();
  const statuses = [];
  const calls = { status: 0, sync: 0, discover: 0, folders: 0, handoffs: 0, collect: 0, writes: 0 };
  let clock = 1000, update, enteredWait, heartbeat, activeWrites = 0, overlappingWrites = false;
  const waiting = new Promise(resolve => { enteredWait = resolve; });
  const state = { version: 2, pending: null, conversations: {}, records: [] };
  const work = runDesktopWatch({ root, signal: controller.signal,
    config: { rendererAdapters: { enabled: true }, folderProjection: { enabled: true },
      desktopLocalHandoff: { enabled: true } }, now: () => clock,
    heartbeatSleep: (ms, { signal }) => new Promise((resolve, reject) => {
      assert.equal(ms, 30_000, 'exercise the normal idle status heartbeat');
      const abort = () => reject(Object.assign(new Error('Heartbeat cancelled.'), { name: 'AbortError' }));
      signal.addEventListener('abort', abort, { once: true });
      heartbeat = () => { signal.removeEventListener('abort', abort); resolve(); };
    }),
    bridge: {
      async status() { calls.status++; return structuredClone(state); },
      async sync() { calls.sync++; throw new Error('No synthetic history should be synchronized.'); },
      async collect() { calls.collect++; },
    },
    runtime: { async codex() { return {}; }, async ownedNativeIds() { return new Set(); } },
    discover: async () => { calls.discover++; return []; },
    publishFolders: async () => {
      calls.folders++;
      if (mapError) throw new Error(mapError);
      return { entries: 3, deferred, unavailableCount: 1, unavailable: [{ reason: 'directory_missing' }] };
    },
    createHandoffPublisher: () => ({ async publish() {
      calls.handoffs++; return { actions: 0, anchors: 3, deferred: null };
    } }),
    startRendererMaintenance: async ({ onStatus }) => {
      update = onStatus; onStatus(structuredClone(initial));
      return { async close() {} };
    },
    events: { metrics: {}, async observe() {}, async acknowledge() {},
      async wait({ signal }) {
        enteredWait();
        return new Promise(resolve => {
          if (signal.aborted) return resolve([]);
          signal.addEventListener('abort', () => resolve([]), { once: true });
        });
      } },
    writeStatus: async (_path, value) => {
      if (++activeWrites > 1) overlappingWrites = true;
      await Promise.resolve();
      calls.writes++; statuses.push(structuredClone(value)); activeWrites--;
    },
  });
  t.after(async () => {
    controller.abort();
    try { await work; assert.equal(overlappingWrites, false); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  await waiting;
  const nativeCalls = () => Object.fromEntries(Object.entries(calls).filter(([key]) => key !== 'writes'));
  const before = nativeCalls();
  return { statuses, calls, latest: () => statuses.filter(value => value.running).at(-1),
    async change(value) {
      const writes = calls.writes;
      update(structuredClone(value));
      assert.equal(calls.writes, writes, 'renderer callback must not introduce a concurrent status writer');
      clock += 30_000;
      heartbeat();
      await setImmediate();
      assert.ok(calls.writes > writes, 'normal idle heartbeat publishes updated renderer state');
      assert.deepEqual(nativeCalls(), before, 'resource changes must not republish maps or read native history/state');
    } };
}

test('idle renderer recovery clears only the resource overlay and retains the map publication timestamp', async t => {
  const f = await idleWatcher(t);
  const before = f.latest();
  assert.equal(before.folderProjection.state, 'error');
  assert.equal(before.folderProjection.error, refusal);
  await f.change(ready);
  const after = f.latest();
  assert.equal(after.folderProjection.state, 'ready');
  assert.equal(after.folderProjection.error, undefined);
  assert.equal(after.folderProjection.entries, 3);
  assert.equal(after.folderProjection.unavailableCount, 1);
  assert.equal(after.folderProjection.updatedAt, before.folderProjection.updatedAt);
  assert.deepEqual(after.folderProjection.resource, ready.adapters.folders);
  assert.deepEqual(after.localHandoff, before.localHandoff);
});

test('idle renderer refusal immediately changes the next heartbeat without native events', async t => {
  const f = await idleWatcher(t, { initial: ready });
  const before = f.latest();
  assert.equal(before.folderProjection.state, 'ready');
  await f.change(skipped);
  assert.equal(f.latest().folderProjection.state, 'error');
  assert.equal(f.latest().folderProjection.error, refusal);
  assert.equal(f.latest().folderProjection.updatedAt, before.folderProjection.updatedAt);
  assert.deepEqual(f.latest().localHandoff, before.localHandoff);
});

test('renderer recovery cannot erase a map error even when its text matches the resource refusal', async t => {
  const f = await idleWatcher(t, { mapError: refusal });
  const before = f.latest().folderProjection;
  await f.change(ready);
  assert.deepEqual(f.latest().folderProjection, before);
  assert.equal(f.latest().folderProjection.state, 'error');
  assert.equal(f.latest().rendererAdapters.state, 'ready');
});

test('renderer recovery restores a deferred map rather than claiming mapping completion', async t => {
  const f = await idleWatcher(t, { deferred: 'pending_transaction' });
  const before = f.latest().folderProjection;
  await f.change(ready);
  assert.equal(f.latest().folderProjection.state, 'deferred');
  assert.equal(f.latest().folderProjection.deferred, 'pending_transaction');
  assert.equal(f.latest().folderProjection.updatedAt, before.updatedAt);
});

test('a folder-specific refusal remains visible while other renderer adapters are ready', async t => {
  const f = await idleWatcher(t, { initial: ready });
  await f.change({ state: 'degraded', adapters: { folders: { status: 'skipped', reason: 'Unsupported folder structure' },
    chatWake: { status: 'matched' } } });
  assert.equal(f.latest().folderProjection.state, 'error');
  assert.equal(f.latest().folderProjection.error, 'Unsupported folder structure');
  await f.change(ready);
  assert.equal(f.latest().folderProjection.state, 'ready');
});

test('the single transient recheck waits without hiding map errors or claiming a deferred map ready', async t => {
  for (const options of [{}, { mapError: 'Exact map conflict' }, { deferred: 'pending_transaction' }]) {
    const f = await idleWatcher(t, { initial: ready, ...options }), before = f.latest().folderProjection;
    await f.change({ state: 'checking', adapters: { folders: { status: 'skipped', reason: 'Cache changed' } } });
    assert.equal(f.latest().folderProjection.state, options.mapError ? 'error' : options.deferred ? 'deferred' : 'waiting');
    assert.equal(f.latest().folderProjection.error, options.mapError ?? undefined);
    assert.equal(f.latest().folderProjection.updatedAt, before.updatedAt);
    await f.change(ready);
    assert.equal(f.latest().folderProjection.state, options.mapError ? 'error' : options.deferred ? 'deferred' : 'ready');
  }
});
