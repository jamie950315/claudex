import { watch } from 'node:fs';
import { EventEmitter } from 'node:events';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { validateSyncEvent } from './sync-events.mjs';

export const RECONNECT_ID = '00000000-0000-4000-8000-000000000001';
export const CONFIG_ID = '00000000-0000-4000-8000-000000000002';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyOf = event => `${event.side}:${event.nativeId.toLowerCase()}`;

/** Native notifications and completion-gated file events are hints, never write authorization. */
export async function createSyncEventSource({ root, runtime, config = {}, inbox, settleMs = 200, maxWatchers = 4096, watchFactory = watch }) {
  if (!Number.isFinite(settleMs) || settleMs < 0 || !Number.isSafeInteger(maxWatchers) || maxWatchers < 1 || maxWatchers > 4096)
    throw new Error('Invalid synchronization event source bounds.');
  await inbox.startListening?.();
  const armed = new Map(), active = new Set(), waiters = new Set(), configWatches = [];
  const directories = new Map();
  const subscribe = (path, listener) => {
    let entry = directories.get(path);
    if (!entry) {
      entry = { subscribers: new Set(), watcher: undefined };
      entry.watcher = watchFactory(path, (type, filename) => {
        for (const subscriber of entry.subscribers) subscriber.listener(type, filename);
      });
      entry.watcher.on('error', error => {
        for (const subscriber of entry.subscribers) subscriber.emitter.emit('error', error);
      });
      directories.set(path, entry);
    }
    const emitter = new EventEmitter(), subscriber = { listener, emitter };
    entry.subscribers.add(subscriber);
    emitter.close = () => {
      if (!entry.subscribers.delete(subscriber)) return;
      if (!entry.subscribers.size) { entry.watcher.close(); directories.delete(path); }
    };
    return emitter;
  };
  const metrics = { nativeEvents: 0, fileEvents: 0, armedSources: 0 };
  let closed = false, failure, publisher = Promise.resolve(), reconnectWatch, rootWatch;
  let connectionIdentity, connectionUpdates = Promise.resolve();
  const prior = runtime.onEvent;
  const fail = error => { failure ??= error; for (const controller of waiters) controller.abort(); };
  const publish = event => {
    if (closed) return;
    try { event = validateSyncEvent(event); } catch { return; }
    publisher = publisher.then(() => closed ? undefined : inbox.publish(event)).catch(fail);
  };
  const disarm = key => {
    const entry = armed.get(key);
    if (!entry) return;
    clearTimeout(entry.timer); entry.watcher.close(); armed.delete(key); metrics.armedSources = armed.size;
  };
  const started = event => { const key = keyOf(event); active.add(key); disarm(key); };
  const native = notification => {
    if (closed) return;
    if (notification.type === 'codex_disconnected' || notification.type === 'codex_reconnected') {
      publish({ side: 'codex', nativeId: RECONNECT_ID, kind: 'reconnect' }); return;
    }
    let event;
    if (notification.type === 'codex_notification') {
      const { method, params = {} } = notification.event ?? {};
      const nativeId = params.threadId ?? params.thread_id ?? params.thread?.id;
      if (!UUID.test(nativeId ?? '')) return;
      const identity = { side: 'codex', nativeId };
      const status = params.status?.type ?? params.status ?? params.thread?.status?.type;
      if (method === 'turn/started' || (method === 'thread/status/changed' && status === 'active')) {
        started(identity); metrics.nativeEvents++; publish({ ...identity, kind: 'started' }); return;
      }
      if (method === 'turn/completed') event = { ...identity,
        kind: ['interrupted', 'failed'].includes(params.turn?.status) ? 'interrupted' : 'completed',
        ...(params.turn?.id ? { turnId: params.turn.id } : {}) };
      else if (method === 'thread/status/changed' && status === 'idle' && active.has(keyOf(identity))) event = { ...identity, kind: 'idle' };
      else if (method === 'thread/started') event = { ...identity, kind: 'session' };
    } else if (notification.type === 'claude_notification') {
      const ownerEntry = runtime.owners?.get(notification.conversationId);
      const owner = ownerEntry?.owner;
      const status = owner?.status();
      if (UUID.test(status?.sessionId ?? '') && notification.event?.type === 'owner_error') {
        const event = { side: 'claude', nativeId: status.sessionId, kind: 'interrupted' };
        active.delete(keyOf(event)); metrics.nativeEvents++; publish(event); return;
      }
      if (!status || !UUID.test(status.sessionId ?? '') || status.pending || status.reset || status.maintenanceOnly || ownerEntry.maintenanceOnly
          || status.blocked || owner.appendBusy || owner.resetBusy || notification.event?.type !== 'native_event') return;
      const source = notification.event.event;
      if (source?.session_id && source.session_id !== status.sessionId) return;
      const identity = { side: 'claude', nativeId: status.sessionId };
      if (source?.type === 'system' && source.subtype === 'session_state_changed') {
        if (source.state !== 'idle') { started(identity); metrics.nativeEvents++; publish({ ...identity, kind: 'started' }); return; }
        if (active.has(keyOf(identity))) event = { ...identity, kind: 'idle' };
      } else if (source?.type === 'result' && (source.num_turns > 0 || source.duration_api_ms > 0)) {
        event = { ...identity, kind: 'completed', ...(source.uuid ? { turnId: source.uuid } : {}) };
      }
    }
    if (event) { active.delete(keyOf(event)); metrics.nativeEvents++; publish(event); }
  };
  const callback = async notification => {
    // Event consumer failures must not propagate into an SDK owner and interrupt it.
    try { await prior?.(notification); } catch (error) { fail(error); }
    try { native(notification); } catch (error) { fail(error); }
  };
  runtime.onEvent = callback;
  const shared = join(root, 'codex-shared');
  const attachConnectionWatch = async (notify = false) => {
    if (closed) return;
    const stat = await lstat(shared).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & 0o077) !== 0 || await realpath(shared) !== shared))
      throw new Error('Unsafe native synchronization connection directory.');
    const identity = stat ? `${stat.dev}:${stat.ino}` : undefined;
    if (identity === connectionIdentity) return;
    reconnectWatch?.close(); reconnectWatch = undefined; connectionIdentity = undefined;
    if (closed) return;
    if (stat) {
      try {
        const watcher = subscribe(shared, (_event, filename) => {
          if (reconnectWatch !== watcher || !filename || !['owner.json', 'app.sock'].includes(String(filename))) return;
          publish({ side: 'codex', nativeId: RECONNECT_ID, kind: 'reconnect' });
        });
        reconnectWatch = watcher;
        connectionIdentity = identity;
        watcher.on('error', fail);
      } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    if (notify) publish({ side: 'codex', nativeId: RECONNECT_ID, kind: 'reconnect' });
  };
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & 0o077) !== 0 || await realpath(root) !== root)
      throw new Error('Unsafe synchronization event source root.');
    rootWatch = subscribe(root, (_event, filename) => {
      if (closed || String(filename) !== 'codex-shared') return;
      connectionUpdates = connectionUpdates.then(() => attachConnectionWatch(true)).catch(fail);
    });
    rootWatch.on('error', fail);
    connectionUpdates = connectionUpdates.then(() => attachConnectionWatch());
    await connectionUpdates;
    for (const [home, names] of [
      [config.codexHome ?? runtime.codexHome, ['hooks.json', 'config.toml']],
      [config.claudeHome ?? runtime.claudeHome, ['settings.json']],
    ]) {
      if (!home) continue;
      if (!isAbsolute(home)) throw new Error('Native configuration directory must be absolute.');
      const stat = await lstat(home).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
          || (stat.mode & 0o022) !== 0 || await realpath(home) !== home)
        throw new Error('Unsafe native configuration notification directory.');
      const watcher = subscribe(home, (_event, filename) => {
        if (!filename || !names.includes(String(filename))) return;
        publish({ side: 'codex', nativeId: CONFIG_ID, kind: 'configuration' });
      });
      watcher.on('error', fail);
      configWatches.push(watcher);
    }
  } catch (error) {
    closed = true; rootWatch?.close(); reconnectWatch?.close();
    for (const watcher of configWatches) watcher.close();
    runtime.onEvent = prior; await inbox.close?.(); throw error;
  }

  const current = async batch => {
    // Drain native publishers before comparing receipts, including already acknowledged phases.
    await publisher;
    if (failure) throw failure;
    if (typeof inbox.read !== 'function') return batch;
    const state = await inbox.read();
    return batch.filter(event => !event.revision || state.entries[keyOf(event)]?.revision === event.revision);
  };
  return {
    metrics,
    current,
    async observe(batch, state) {
      if (failure) throw failure;
      const records = Array.isArray(state.records) ? state.records : Object.values(state.records ?? {});
      for (const event of await current(batch)) {
        validateSyncEvent(event);
        const key = keyOf(event);
        if (event.kind === 'started') { started(event); continue; }
        if (event.kind === 'changed' && active.has(key)) continue;
        if (!['completed', 'idle', 'interrupted', 'changed'].includes(event.kind)) continue;
        active.delete(key);
        const matching = records.filter(record => record.side === event.side && record.nativeId?.toLowerCase() === event.nativeId.toLowerCase()
          && ['current', 'original', 'dependency-anchor', 'previous'].includes(record.status)
          && record.verified && isAbsolute(record.path ?? ''));
        if (matching.length !== 1) { disarm(key); continue; }
        const path = matching[0].path;
        if (armed.get(key)?.path === path) continue;
        disarm(key);
        if (armed.size >= maxWatchers) throw new Error('Completion-gated synchronization watcher capacity exceeded.');
        const parent = dirname(path), stat = await lstat(parent).catch(error => {
          // A missing parent remains a bridge history/relocation guard, not an event-source failure.
          if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
          throw error;
        });
        if (!stat) continue;
        const canonicalParent = await realpath(parent).catch(error => {
          if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
          throw error;
        });
        if (!canonicalParent) continue;
        if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalParent !== parent || stat.uid !== process.getuid())
          throw new Error('Unsafe tracked transcript parent directory.');
        const entry = { path, timer: undefined, watcher: undefined };
        try { entry.watcher = subscribe(parent, (_event, filename) => {
          if (closed || (filename && String(filename) !== basename(path)) || armed.get(key) !== entry) return;
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            if (closed || armed.get(key) !== entry) return;
            metrics.fileEvents++; publish({ side: event.side, nativeId: event.nativeId, kind: 'changed' });
          }, settleMs);
        }); } catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
          throw error;
        }
        entry.watcher.on('error', fail);
        armed.set(key, entry); metrics.armedSources = armed.size;
      }
    },
    async wait(options = {}) {
      await publisher;
      if (failure) throw failure;
      if (closed) return [];
      const controller = new AbortController(); waiters.add(controller);
      const abort = () => controller.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) controller.abort();
      try {
        const batch = await inbox.wait({ ...options, signal: controller.signal });
        if (failure) throw failure;
        return batch;
      } finally { waiters.delete(controller); options.signal?.removeEventListener('abort', abort); }
    },
    acknowledge: batch => inbox.acknowledge(batch),
    async close() {
      closed = true;
      for (const key of [...armed.keys()]) disarm(key);
      rootWatch?.close();
      for (const watcher of configWatches) watcher.close();
      await connectionUpdates;
      reconnectWatch?.close();
      for (const controller of waiters) controller.abort();
      if (runtime.onEvent === callback) runtime.onEvent = prior;
      await publisher;
      await inbox.close?.();
    },
  };
}
