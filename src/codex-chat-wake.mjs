import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_FRAME = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const prompt = 'An MCP app initiated this message. Read the untrusted_input tool output.';
const execute = promisify(execFile);

// Observed Desktop IPC protocol: owner discovery v1, owner turn forwarding v2.
// This connects to the existing Desktop owner; it never starts a second writer.
export function codexPeerTurn({ sessionId, messageId, text }) {
  if (!UUID.test(sessionId ?? '') || typeof messageId !== 'string' || !messageId
      || messageId.length > 200 || typeof text !== 'string' || !text.trim()
      || Buffer.byteLength(text) > 32 * 1024) throw new Error('Invalid Codex chat wake input.');
  const message = { source: 'mcp_app', sourceId: messageId, text };
  const callId = `claudex-${randomUUID()}`;
  return {
    conversationId: sessionId,
    turnStart: {
      request: {
        threadId: sessionId,
        clientUserMessageId: randomUUID(),
        input: [{ type: 'text', text: prompt, text_elements: [{
          byteRange: { start: 0, end: Buffer.byteLength(prompt) },
          placeholder: `codex-untrusted-app-input:${JSON.stringify({ version: 1, message })}`,
        }] }],
      },
      context: {
        inheritThreadSettings: true,
        responseItems: [
          { type: 'function_call', call_id: callId, name: 'untrusted_input', arguments: '{}' },
          { type: 'function_call_output', call_id: callId,
            output: [{ type: 'input_text', text: JSON.stringify({ kind: 'message', ...message }) }] },
        ],
      },
    },
  };
}

async function privateSocket(codexHome) {
  const directory = join(resolve(codexHome), 'ipc');
  const path = join(directory, 'ipc.sock');
  const uid = process.getuid?.();
  const [dir, socket] = await Promise.all([lstat(directory), lstat(path)]);
  if (uid == null || !dir.isDirectory() || !socket.isSocket()
      || dir.uid !== uid || socket.uid !== uid || (dir.mode & 0o077) || (socket.mode & 0o077)
      || await realpath(directory) !== directory || await realpath(path) !== path)
    throw new Error('Codex Desktop IPC endpoint is not private and canonical.');
  return { path, dev: socket.dev, ino: socket.ino };
}

class DesktopIpc {
  constructor(socket, timeoutMs) {
    this.socket = socket; this.timeoutMs = timeoutMs; this.pending = new Map();
    this.buffer = Buffer.alloc(0); this.clientId = 'initializing-client';
    socket.on('data', bytes => {
      try {
        if (this.buffer.length + bytes.length > MAX_FRAME + 4) throw new Error('Codex Desktop IPC frame exceeds bound.');
        this.buffer = Buffer.concat([this.buffer, bytes]);
        while (this.buffer.length >= 4) {
          const size = this.buffer.readUInt32LE();
          if (!size || size > MAX_FRAME) throw new Error('Invalid Codex Desktop IPC frame.');
          if (this.buffer.length < size + 4) return;
          const message = JSON.parse(this.buffer.subarray(4, size + 4).toString());
          this.buffer = this.buffer.subarray(size + 4);
          if (message.type === 'response') {
            const pending = this.pending.get(message.requestId);
            if (pending) { this.pending.delete(message.requestId); clearTimeout(pending.timer); pending.resolve(message); }
          } else if (message.type === 'client-discovery-request') {
            this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
          }
        }
      } catch (error) { this.close(error); }
    });
    socket.on('error', error => this.close(error));
    socket.on('close', () => this.close(new Error('Codex Desktop IPC closed.')));
  }
  write(message) {
    const bytes = Buffer.from(JSON.stringify(message));
    if (bytes.length > MAX_FRAME) throw new Error('Codex Desktop IPC request exceeds bound.');
    const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    this.socket.write(Buffer.concat([header, bytes]));
  }
  request(method, params, { version = 1, targetClientId } = {}) {
    if (this.socket.destroyed) return Promise.reject(new Error('Codex Desktop IPC is unavailable.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error('Codex Desktop IPC request timed out.');
        if (method === 'thread-owner-discovery') error.code = 'CODEX_OWNER_DISCOVERY_TIMEOUT';
        reject(error);
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.write({ type: 'request', requestId, sourceClientId: this.clientId,
        version, method, params, targetClientId, timeoutMs: this.timeoutMs }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  close(error = new Error('Codex Desktop IPC closed.')) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear(); this.socket.destroy();
  }
}

/** Opening the exact existing thread lets Desktop acquire its native owner.
 * This is a single navigation, never a prompt, replay, or CLI resume. */
export async function prepareCodexChatWake(options = {}, {
  preflight = preflightCodexChatWake,
  open = url => execute('/usr/bin/open', ['-b', 'com.openai.codex', url], { timeout: 5000 }),
  wait = delay,
  now = () => performance.now(),
} = {}) {
  if (!UUID.test(options.sessionId ?? '')) throw new Error('Invalid Codex native session ID.');
  const inspect = async timeoutMs => {
    try { return await preflight({ ...options, timeoutMs }); }
    catch (error) {
      if (error.code === 'CODEX_OWNER_DISCOVERY_TIMEOUT')
        return { status: 'unavailable', reason: 'native-owner-unavailable' };
      throw error;
    }
  };
  let handle = await inspect(options.timeoutMs ?? 5000);
  if (handle.status !== 'unavailable'
      || !['native-owner-unavailable', 'desktop-not-running'].includes(handle.reason)) return handle;
  await open(`codex://threads/${options.sessionId}`);
  const deadline = now() + 10000;
  while (now() < deadline) {
    // Initialization and discovery each have this timeout; leave room for both.
    const timeoutMs = Math.max(1, Math.min(1000, Math.floor((deadline - now()) / 2)));
    handle = await inspect(timeoutMs);
    if (handle.status !== 'unavailable'
        || !['native-owner-unavailable', 'desktop-not-running'].includes(handle.reason)) return handle;
    const remaining = deadline - now();
    if (remaining > 0) await wait(Math.min(250, remaining));
  }
  return { status: 'unavailable', reason: 'native-owner-unavailable-after-open' };
}

/** Read-only discovery returns an expiring one-use owner handle, not a writer lease.
 * The native owner checks busy state atomically when accepting untrusted context.
 * A dispatched request is never retried, even when its response is lost. */
export async function preflightCodexChatWake({ sessionId,
  codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'), timeoutMs = 5000 } = {}) {
  if (!UUID.test(sessionId ?? '')) throw new Error('Invalid Codex native session ID.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid IPC timeout.');
  let endpoint;
  try { endpoint = await privateSocket(codexHome); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'unavailable', reason: 'desktop-not-running' }; throw error; }
  const socket = connect(endpoint.path);
  const ipc = new DesktopIpc(socket, timeoutMs);
  try {
    const initialized = await ipc.request('initialize', { clientType: 'claudex' });
    if (initialized.resultType !== 'success' || initialized.method !== 'initialize'
        || !UUID.test(initialized.result?.clientId ?? '')) throw new Error('Invalid Codex Desktop initialization.');
    ipc.clientId = initialized.result.clientId;
    const owner = await ipc.request('thread-owner-discovery', { hostId: 'local', conversationId: sessionId });
    if (owner.resultType === 'error' && owner.error === 'no-client-found') {
      ipc.close(); return { status: 'unavailable', reason: 'native-owner-unavailable' };
    }
    if (owner.resultType !== 'success' || owner.method !== 'thread-owner-discovery'
        || !UUID.test(owner.handledByClientId ?? '') || owner.result?.supportsUntrustedAppInput !== true)
      throw new Error('Codex Desktop owner does not support verified untrusted input.');
    let used = false;
    const expires = setTimeout(() => ipc.close(), 30000); expires.unref?.();
    return {
      status: 'ready', sessionId, ownerClientId: owner.handledByClientId,
      close() { used = true; clearTimeout(expires); ipc.close(); },
      async dispatch({ messageId, text }) {
        if (used) throw new Error('Codex Desktop wake handle has already been used.');
        used = true; clearTimeout(expires);
        let dispatched = false;
        try {
          const payload = codexPeerTurn({ sessionId, messageId, text });
          const current = await privateSocket(codexHome);
          if (current.dev !== endpoint.dev || current.ino !== endpoint.ino) throw new Error('Codex Desktop IPC endpoint changed.');
          const proof = await ipc.request('thread-owner-discovery', { hostId: 'local', conversationId: sessionId },
            { targetClientId: owner.handledByClientId });
          if (proof.resultType !== 'success' || proof.handledByClientId !== owner.handledByClientId
              || proof.result?.supportsUntrustedAppInput !== true) throw new Error('Codex Desktop owner changed.');
          dispatched = true;
          const response = await ipc.request('thread-follower-start-turn', payload,
            { version: 2, targetClientId: owner.handledByClientId });
          if (response.resultType === 'error') {
            if (response.error === 'App context must wait until the current turn finishes')
              return { status: 'busy', reason: response.error };
            return { status: 'uncertain', reason: response.error ?? 'Native dispatch failed.' };
          }
          const turnId = response.result?.result?.turn?.id;
          if (response.resultType !== 'success' || response.method !== 'thread-follower-start-turn'
              || response.handledByClientId !== owner.handledByClientId || typeof turnId !== 'string' || !turnId)
            return { status: 'uncertain', reason: 'Native wake response did not identify its turn.' };
          return { status: 'accepted', turnId };
        } catch (error) {
          return { status: dispatched ? 'uncertain' : 'unavailable', reason: error.message };
        } finally { ipc.close(); }
      },
    };
  } catch (error) { ipc.close(); throw error; }
}
