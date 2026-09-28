import { constants, watch } from 'node:fs';
import { mkdir, lstat, realpath, open, rename, unlink, chmod } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { withLock } from './storage.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(['completed', 'idle', 'interrupted', 'session', 'changed', 'reconnect', 'started', 'configuration']);
const MAX_KEYS = 4096;
const MAX_BYTES = 4 * 1024 * 1024;
const owned = stat => stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
const keyFor = event => `${event.side}:${event.nativeId}`;
const localQueues = new Map();
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; } };
const sameIdentity = (stat, identity) => stat.dev === identity.dev && stat.ino === identity.ino;
const lockContention = error => error.code === 'ENOENT' || /^(Another bridge operation holds the lock|Lock is not a private owned regular file|Lock identity changed|Lock state changed during owner publication|Lock changed during stale recovery|Malformed lock owner|Another stale-lock recovery)/.test(error.message);

async function retryableCurrentLock(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (!before.isFile() || !owned(before) || (before.mode & 0o777) !== 0o600 || before.nlink > 1 || before.size > 1024) return false;
    if (before.nlink === 0 || (before.size === 0 && Date.now() - before.mtimeMs <= 1000)) return undefined;
    const bytes = Buffer.alloc(1025);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024) return false;
    let owner;
    try { owner = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')); } catch { return false; }
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner.started !== 'string' || !Number.isFinite(Date.parse(owner.started))) return false;
    const after = await file.stat(), named = await lstat(path);
    if (!named.isFile() || named.isSymbolicLink() || !owned(named) || (named.mode & 0o777) !== 0o600 || named.nlink !== 1) return false;
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(field => before[field] !== after[field] || before[field] !== named[field])) return undefined;
    try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
  } catch (error) {
    if (error.code !== 'ENOENT') return false;
    try { await lstat(path); return undefined; } catch (current) { return current.code === 'ENOENT'; }
  } finally { await file?.close(); }
}

export function validateSyncEvent(value) {
  if (!value || !['codex', 'claude'].includes(value.side) || !UUID.test(value.nativeId) || !KINDS.has(value.kind))
    throw new Error('Invalid synchronization event identity or kind.');
  if (value.turnId !== undefined && (typeof value.turnId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.turnId)))
    throw new Error('Invalid synchronization event turn identity.');
  return { side: value.side, nativeId: value.nativeId.toLowerCase(), kind: value.kind,
    ...(value.turnId === undefined ? {} : { turnId: value.turnId }) };
}

/** Untrusted wake hints only. Native history and ownership still authorize synchronization. */
export class SyncEventInbox {
  constructor({ root }) {
    if (typeof root !== 'string' || !root.startsWith('/')) throw new Error('A private absolute root is required.');
    this.root = resolve(root);
    this.directory = join(this.root, 'sync-events');
    this.path = join(this.directory, 'inbox.json');
    this.lock = join(this.directory, 'inbox.lock');
    this.socketPath = join(this.directory, 'wake.sock');
    this.listenerPath = join(this.directory, 'listener.json');
    this.generation = 0;
    this.waiters = new Set();
    this.closed = false;
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const path of [this.root, this.directory]) {
      await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || await realpath(path) !== path)
        throw new Error('Synchronization event directory must be canonical, private and owned.');
    }
    await this.read();
    return this;
  }

  async read() {
    let file;
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, entries: {} }; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || !owned(stat) || (stat.mode & 0o777) !== 0o600 || stat.nlink > 1 || stat.size > MAX_BYTES)
        throw new Error('Unsafe synchronization event inbox.');
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const result = await file.read(bytes, size, bytes.length - size, null);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > MAX_BYTES) throw new Error('Synchronization event inbox exceeds its bound.');
      const after = await file.stat();
      if (!after.isFile() || !owned(after) || (after.mode & 0o777) !== 0o600 || after.nlink > 1
          || ['dev', 'ino', 'size', 'mtimeMs'].some(field => stat[field] !== after[field])
          || (after.nlink === 1 && stat.ctimeMs !== after.ctimeMs))
        throw new Error('Synchronization event inbox changed while being read.');
      // Atomic replacement may leave this descriptor unlinked. A stable old snapshot
      // remains safe because acknowledgements compare exact revisions under the lock.
      const named = await lstat(this.path);
      if (!named.isFile() || named.isSymbolicLink() || !owned(named) || (named.mode & 0o777) !== 0o600
          || named.nlink !== 1 || named.size > MAX_BYTES) throw new Error('Unsafe synchronization event inbox.');
      const state = JSON.parse(bytes.subarray(0, size).toString('utf8'));
      if (state.version !== 1 || !state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)
          || Object.keys(state.entries).length > MAX_KEYS) throw new Error('Malformed synchronization event inbox.');
      for (const [key, entry] of Object.entries(state.entries)) {
        const event = validateSyncEvent(entry);
        if (key !== keyFor(event) || !UUID.test(entry.revision) || typeof entry.pending !== 'boolean'
            || !Number.isSafeInteger(entry.at)) throw new Error('Malformed synchronization event receipt.');
      }
      return state;
    } finally { await file.close(); }
  }

  async write(state) {
    const contents = JSON.stringify(state);
    if (Buffer.byteLength(contents) > MAX_BYTES) throw new Error('Synchronization event inbox exceeds its bound.');
    // Only an unpublished owned scratch file can be removed while holding the inbox lock.
    const temporary = join(this.directory, 'inbox.next');
    try {
      const previous = await lstat(temporary);
      if (!previous.isFile() || !owned(previous) || (previous.mode & 0o777) !== 0o600
          || previous.nlink !== 1 || previous.size > MAX_BYTES) throw new Error('Unsafe synchronization event scratch file.');
      await unlink(temporary);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    try {
      await rename(temporary, this.path);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async serialized(fn) {
    const previous = localQueues.get(this.lock) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const deadline = Date.now() + 5000;
      for (;;) {
        let entered = false;
        try { return await withLock(this.lock, () => { entered = true; return fn(); }, { recoverDead: true }); }
        catch (error) {
          if (entered || !lockContention(error) || Date.now() >= deadline) throw error;
          // Let a concurrent publisher finish its bounded lock publication, then
          // recheck only the exact lock. Never reclaim or retry unsafe evidence.
          let retryable;
          do {
            await delay(20);
            retryable = await retryableCurrentLock(this.lock);
          } while (retryable === undefined && Date.now() < deadline);
          if (retryable !== true) throw error;
        }
      }
    });
    localQueues.set(this.lock, operation);
    try { return await operation; }
    finally { if (localQueues.get(this.lock) === operation) localQueues.delete(this.lock); }
  }

  async publish(value) {
    const event = validateSyncEvent(value);
    const result = await this.serialized(async () => {
      const state = await this.read();
      const key = keyFor(event), prior = state.entries[key];
      // A late filesystem flush from the prior turn cannot rearm synchronization
      // after the next user turn started, including after its hint was consumed.
      if (event.kind === 'changed' && prior?.kind === 'started') return prior;
      if (!prior && Object.keys(state.entries).length >= MAX_KEYS) {
        const consumed = Object.entries(state.entries).filter(([, entry]) => !entry.pending).sort((a, b) => a[1].at - b[1].at);
        if (!consumed.length) throw new Error('Synchronization event inbox is full; existing events were preserved.');
        delete state.entries[consumed[0][0]];
      }
      const next = { ...event, revision: randomUUID(), pending: true, at: Date.now() };
      state.entries[key] = next;
      await this.write(state);
      return next;
    });
    if (result.pending) await this.wakeConsumer();
    return result;
  }

  async wakeConsumer() {
    try {
      const stat = await lstat(this.socketPath);
      if (!stat.isSocket() || !owned(stat) || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1)
        throw new Error('Unsafe synchronization wake socket.');
    } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let finished = false;
      const finish = error => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.destroy();
        if (error && !['ENOENT', 'ECONNREFUSED'].includes(error.code)) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('Synchronization wake delivery timed out; its durable event was preserved.')), 300);
      socket.on('error', finish);
      socket.on('connect', () => socket.end('w'));
      // Acknowledgement is sent on accept, after the consumer has incremented its generation.
      socket.once('data', () => finish());
      socket.once('end', () => finish());
    });
  }

  notifyWaiters() {
    this.generation++;
    for (const resolve of this.waiters) resolve();
  }

  async readListener() {
    let file;
    try { file = await open(this.listenerPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const before = await file.stat();
      if (!before.isFile() || !owned(before) || (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size > 1024)
        throw new Error('Unsafe synchronization listener owner.');
      const bytes = Buffer.alloc(1025), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 1024) throw new Error('Synchronization listener owner exceeds its bound.');
      const owner = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      const after = await file.stat(), named = await lstat(this.listenerPath);
      if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(field => before[field] !== after[field] || before[field] !== named[field])
          || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !UUID.test(owner.revision)
          || !Number.isSafeInteger(owner.socket?.dev) || !Number.isSafeInteger(owner.socket?.ino))
        throw new Error('Malformed synchronization listener owner.');
      return { ...owner, file: { dev: named.dev, ino: named.ino } };
    } finally { await file.close(); }
  }

  async startListening() {
    if (this.server) return this;
    if (this.starting) return this.starting;
    if (this.closed) throw new Error('Synchronization inbox listener is closed.');
    this.starting = this.serialized(async () => {
      const prior = await this.readListener();
      let existing;
      try { existing = await lstat(this.socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (prior) {
        if (isAlive(prior.pid)) throw new Error('Another synchronization event consumer is active.');
        if (existing && (!existing.isSocket() || !owned(existing) || (existing.mode & 0o777) !== 0o600
            || existing.nlink !== 1 || !sameIdentity(existing, prior.socket)))
          throw new Error('Synchronization listener socket changed; prior evidence was preserved.');
        if (existing) await unlink(this.socketPath);
        if (!sameIdentity(await lstat(this.listenerPath), prior.file)) throw new Error('Synchronization listener owner changed.');
        await unlink(this.listenerPath);
      } else if (existing) throw new Error('Synchronization wake socket has no verified owner; it was preserved.');
      const server = createServer(socket => {
        this.notifyWaiters();
        socket.on('error', () => {});
        socket.setTimeout(300, () => socket.destroy());
        socket.resume();
        socket.end('ok');
      });
      server.maxConnections = 32;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.socketPath, () => { server.removeListener('error', reject); resolve(); }); });
      await chmod(this.socketPath, 0o600);
      const stat = await lstat(this.socketPath);
      this.listenerOwner = { pid: process.pid, revision: randomUUID(), socket: { dev: stat.dev, ino: stat.ino } };
      const file = await open(this.listenerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify(this.listenerOwner)); await file.sync(); } finally { await file.close(); }
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      this.server = server;
      server.on('error', error => { this.listenerFailure = error; this.notifyWaiters(); });
      server.unref();
      this.fileWatcher = watch(this.directory, (_event, filename) => { if (!filename || String(filename) === 'inbox.json') this.notifyWaiters(); });
      this.fileWatcher.on('error', error => { this.listenerFailure = error; this.notifyWaiters(); });
      this.fileWatcher.unref();
      return this;
    });
    try { return await this.starting; } finally { this.starting = undefined; }
  }

  async close() {
    if (this.starting) await this.starting;
    this.closed = true;
    this.notifyWaiters();
    this.fileWatcher?.close();
    if (!this.server) return;
    const server = this.server;
    server.ref();
    await this.serialized(async () => {
      const owner = await this.readListener();
      const socket = await lstat(this.socketPath);
      if (owner?.pid !== process.pid || owner.revision !== this.listenerOwner.revision || !sameIdentity(socket, this.listenerOwner.socket)
          || !socket.isSocket() || !owned(socket) || (socket.mode & 0o777) !== 0o600 || socket.nlink !== 1)
        throw new Error('Synchronization listener ownership changed; teardown was refused.');
      // Node removes its bound socket when the server closes; verify our exact inode first.
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (!sameIdentity(await lstat(this.listenerPath), owner.file)) throw new Error('Synchronization listener owner changed.');
      await unlink(this.listenerPath);
      this.server = undefined;
    });
  }

  async list() { return Object.values((await this.read()).entries).filter(entry => entry.pending); }

  async acknowledge(batch) {
    return this.serialized(async () => {
      const state = await this.read();
      let changed = false;
      for (const value of batch) {
        const event = validateSyncEvent(value), entry = state.entries[keyFor(event)];
        if (entry?.revision === value.revision && entry.pending) { entry.pending = false; changed = true; }
      }
      if (changed) await this.write(state);
    });
  }

  async wait({ signal, timeoutMs } = {}) {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) throw new Error('Invalid event wait timeout.');
    if (signal?.aborted) return [];
    await this.startListening();
    let wake, expired = false;
    const notify = () => wake?.();
    this.waiters.add(notify);
    this.server.ref();
    const abort = notify;
    signal?.addEventListener('abort', abort, { once: true });
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => { expired = true; notify(); }, timeoutMs);
    try {
      for (;;) {
        const generation = this.generation;
        if (this.listenerFailure) throw this.listenerFailure;
        if (signal?.aborted || this.closed) return [];
        const batch = await this.list();
        if (batch.length) return batch;
        if (expired) return [];
        if (generation === this.generation && !signal?.aborted && !this.closed) await new Promise(resolve => { wake = resolve; });
        wake = undefined;
      }
    } finally {
      clearTimeout(timer);
      this.waiters.delete(notify);
      if (!this.waiters.size) this.server?.unref();
      signal?.removeEventListener('abort', abort);
    }
  }
}
