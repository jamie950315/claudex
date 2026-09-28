import net from 'node:net';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Validate direct sockets and the pinned native CLI's custom-listener alias. */
export async function inspectCodexSocket(socketPath) {
  try { return await inspectSocket(socketPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // The native endpoint can disappear while the App replaces its backend.
    // This is transport unavailability, not a fatal history/storage failure.
    // Keep errno for callers, but never authorize a connection without a fresh
    // complete permission, alias and identity verification on the next pass.
    throw Object.assign(new Error('Shared Codex transport unavailable: native socket is not present.', { cause: error }), { code: 'ENOENT' });
  }
}

async function inspectSocket(socketPath) {
  if (!isAbsolute(socketPath)) throw new Error('The Codex socket path must be absolute');
  const [entry, directory] = await Promise.all([lstat(socketPath), lstat(dirname(socketPath))]);
  const uid = process.getuid?.();
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700
      || (uid !== undefined && (entry.uid !== uid || directory.uid !== uid))) {
    throw new Error('The Codex socket must be owner-only in a private directory');
  }
  let targetPath = socketPath;
  if (entry.isSymbolicLink()) {
    targetPath = await readlink(socketPath);
    const expectedDirectory = join(await realpath('/tmp'), `codex-daemon-${uid}`);
    if (!isAbsolute(targetPath) || dirname(targetPath) !== expectedDirectory || !/^[a-f0-9]{64}$/.test(basename(targetPath))) throw new Error('Unexpected native Codex socket alias');
    const targetDirectory = await lstat(expectedDirectory);
    if (!targetDirectory.isDirectory() || targetDirectory.isSymbolicLink() || targetDirectory.uid !== uid || (targetDirectory.mode & 0o777) !== 0o700) throw new Error('The native Codex socket directory is not private');
  }
  const socket = entry.isSymbolicLink() ? await lstat(targetPath) : entry;
  if (!socket.isSocket() || socket.isSymbolicLink() || (socket.mode & 0o777) !== 0o600 || (uid !== undefined && socket.uid !== uid)) throw new Error('The Codex socket must be owner-only in a private directory');
  return { socketPath: targetPath, socketStat: socket, listenerStat: entry };
}

/** Connect to the documented WebSocket transport, never the private app IPC. */
export async function connectCodexSocket(socketPath, { timeoutMs = 30000, maxPayload = MAX_FRAME_BYTES } = {}) {
  const endpoint = await inspectCodexSocket(socketPath);
  const ws = new WebSocket('ws://localhost/rpc', {
    createConnection: () => net.createConnection({ path: endpoint.socketPath }),
    handshakeTimeout: timeoutMs,
    maxPayload,
    perMessageDeflate: false,
  });
  await new Promise((resolve, reject) => {
    const failed = () => { cleanup(); ws.terminate(); reject(new Error('Could not connect to the shared Codex transport')); };
    const opened = () => { cleanup(); resolve(); };
    const cleanup = () => { ws.off('error', failed); ws.off('close', failed); ws.off('open', opened); };
    ws.once('error', failed);
    ws.once('close', failed);
    ws.once('open', opened);
  });
  return ws;
}

/** A connection, not an owner: close() never stops the shared native process. */
export class CodexWebSocketClient extends EventEmitter {
  constructor({ socketPath, timeoutMs = 30000, maxPending = 128 } = {}) {
    super();
    this.options = { socketPath, timeoutMs, maxPending };
    this.pending = new Map();
    this.nextId = 1;
    this.initializing = false;
    this.closed = false;
  }

  async initialize() {
    if (this.ws || this.initializing || this.closed) throw new Error('Codex client is already initialized or closed');
    this.initializing = true;
    try {
      this.ws = await connectCodexSocket(this.options.socketPath, this.options);
      if (this.closed) { this.ws.terminate(); throw new Error('Codex client closed'); }
      this.ws.on('error', () => this.rejectPending(new Error('Shared Codex transport failed; completion is unknown, do not retry writes automatically')));
      this.ws.on('close', () => {
        this.closed = true;
        this.rejectPending(new Error('Shared Codex transport closed; completion is unknown, do not retry writes automatically'));
        this.emit('disconnected');
      });
      this.ws.on('message', (data, binary) => this.receive(data, binary));
      const result = await this.request('initialize', {
        clientInfo: { name: 'claudex', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      await this.send({ method: 'initialized', params: {} });
      return result;
    } catch (error) {
      await this.close();
      throw error;
    } finally { this.initializing = false; }
  }

  receive(data, binary) {
    let message;
    try {
      if (binary) throw new Error();
      message = JSON.parse(data.toString('utf8'));
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
    } catch {
      this.rejectPending(new Error('Invalid JSON from shared Codex transport'));
      this.ws.terminate();
      return;
    }
    if (message.id !== undefined && message.method) {
      void this.send({ id: message.id, error: { code: -32601, message: 'Interactive requests are not supported by the history bridge' } })
        .catch(() => this.rejectPending(new Error('Shared Codex transport failed')));
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message);
        error.code = message.error.code;
        pending.reject(error);
      } else pending.resolve(message.result);
    } else this.emit('notification', message);
  }

  send(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.closed) return Promise.reject(new Error('Shared Codex transport is not connected'));
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) return Promise.reject(new Error('Codex message exceeds the transport size limit'));
    return new Promise((resolve, reject) => this.ws.send(text, { binary: false }, error => error ? reject(new Error('Codex send failed; completion is unknown, do not retry writes automatically')) : resolve()));
  }

  request(method, params = {}) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Shared Codex transport is not connected'));
    if (this.pending.size >= this.options.maxPending) return Promise.reject(new Error('Too many pending Codex requests'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}; completion is unknown, do not retry writes automatically`));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.send({ id, method, params }).catch(error => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  createThread(params = {}) { return this.request('thread/start', params); }
  injectItems(threadId, items) { return this.request('thread/inject_items', { threadId, items }); }
  readThread(threadId) { return this.request('thread/read', { threadId, includeTurns: true }); }
  resumeThread(threadId, params = {}) { return this.request('thread/resume', { ...params, threadId }); }

  async close() {
    this.closed = true;
    this.rejectPending(new Error('Codex client closed'));
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => ws.terminate(), 1000);
      ws.once('close', () => { clearTimeout(timer); resolve(); });
      ws.close();
    });
  }
}
