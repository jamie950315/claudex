import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

/** A bounded JSON-RPC client. No method starts inference implicitly. */
export class CodexClient extends EventEmitter {
  constructor({ binary = 'codex', codexHome, cwd, mode = 'standalone', socketPath, timeoutMs = 30000, env = {} } = {}) {
    super();
    if (!['standalone', 'proxy'].includes(mode)) throw new Error('Unknown Codex transport mode');
    this.options = { binary, codexHome, cwd, mode, socketPath, timeoutMs, env };
    this.pending = new Map();
    this.nextId = 1;
  }

  async initialize() {
    if (this.child) throw new Error('Codex client is already initialized');
    const { binary, codexHome, cwd, mode, socketPath } = this.options;
    this.child = spawn(binary, ['app-server', ...(mode === 'proxy' ? ['proxy', ...(socketPath ? ['--sock', socketPath] : [])] : ['--stdio'])], {
      cwd, env: { ...process.env, ...this.options.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', () => {}); // Never forward private diagnostics by default.
    this.child.on('error', error => this.rejectPending(error));
    this.child.on('exit', (code, signal) => this.rejectPending(new Error(`Codex transport exited (${code ?? signal})`)));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.rejectPending(new Error('Invalid JSON from Codex transport')); return; }
      if (message.id !== undefined && message.method) {
        this.child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Interactive requests are not supported by the history bridge' } })}\n`);
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
    });
    const result = await this.request('initialize', {
      clientInfo: { name: 'claudex', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    return result;
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  request(method, params = {}) {
    if (!this.child || this.child.exitCode !== null || this.child.killed) return Promise.reject(new Error('Codex transport is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}; completion is unknown, do not retry writes automatically`));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }

  createThread(params = {}) { return this.request('thread/start', params); }
  injectItems(threadId, items) { return this.request('thread/inject_items', { threadId, items }); }
  readThread(threadId) { return this.request('thread/read', { threadId, includeTurns: true }); }
  resumeThread(threadId, params = {}) { return this.request('thread/resume', { ...params, threadId }); }

  async close() {
    if (!this.child) return;
    const child = this.child;
    this.rejectPending(new Error('Codex client closed'));
    this.lines?.close();
    if (child.exitCode === null && !child.killed) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    this.child = undefined;
  }
}
