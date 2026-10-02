import net from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { collaborationEfforts, validateCollaborationEffort } from './collaboration-effort.mjs';

const MAX_FRAME = 1024 * 1024;
// Leave room for controller/status clients when all 64 workers are waiting.
const MAX_CONNECTIONS = 128;
const SOCKET_LIFETIME_MS = 65000;
const METHODS = new Set(['start', 'send', 'handoff', 'status', 'wait', 'cancel', 'list', 'resolve', 'models', 'chat_list', 'chat_send', 'chat_status', 'desktop_wake_claim', 'desktop_wake_receipt', 'desktop_owner_wake', 'native_wake', 'mod_wake_wait', 'mod_wake_claim', 'mod_wake_receipt', 'mod_wake_check']);
const VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const socketPath = root => join(root, 'rpc.sock');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };

async function privateRoot(root) {
  if (!isAbsolute(root)) fail('Collaboration root must be absolute');
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
    fail('Collaboration root must be an owner-private directory');
  }
  return stat;
}

async function privateSocket(root) {
  await privateRoot(root);
  const stat = await lstat(socketPath(root));
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    fail('Collaboration socket must be owner-private and cannot be a symlink');
  }
  return stat;
}

function encode(value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_FRAME) fail('Collaboration frame exceeds 1 MiB');
  return bytes;
}

function decode(bytes) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (!object(value)) fail('Collaboration frame must be a JSON object');
  return value;
}

function validateEnvelope(value) {
  if (!['codex', 'claude'].includes(value.peer) || !METHODS.has(value.method)
      || (value.token !== undefined && typeof value.token !== 'string')
      || (value.params !== undefined && !object(value.params))) fail('Invalid collaboration request');
  return { peer: value.peer, token: value.token, method: value.method, params: value.params ?? {} };
}

/** One request per connection; the owner supplies the authoritative dispatcher. */
export async function serveCollaborationSocket({ root, dispatch }) {
  await privateRoot(root);
  if (typeof dispatch !== 'function') fail('Collaboration dispatcher is required');
  const path = socketPath(root);
  // Even an apparently stale socket belongs to its owner. Reclamation is external.
  try { await lstat(path); fail('Collaboration socket already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const connections = new Set();
  const server = net.createServer(socket => {
    if (connections.size >= MAX_CONNECTIONS) { socket.destroy(); return; }
    connections.add(socket);
    socket.on('error', () => socket.destroy());
    socket.setTimeout(SOCKET_LIFETIME_MS, () => socket.destroy());
    socket.once('close', () => connections.delete(socket));
    let data = Buffer.alloc(0);
    let handled = false;
    socket.on('data', async chunk => {
      if (handled) { socket.destroy(); return; }
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_FRAME) { socket.destroy(); return; }
      const newline = data.indexOf(10);
      if (newline < 0) return;
      handled = true;
      if (newline !== data.length - 1) { socket.destroy(); return; }
      try {
        const request = validateEnvelope(decode(data.subarray(0, newline)));
        if (request.method === 'wait' || request.method === 'mod_wake_wait') {
          const controller = new AbortController();
          // Internal connection lifetime only; never read cancellation from the
          // wire or forward it to inference-capable protocol operations.
          Object.defineProperty(request, 'signal', { value: controller.signal });
          socket.once('close', () => controller.abort());
        }
        const result = await dispatch(request);
        socket.end(encode({ ok: true, result: result ?? null }));
      } catch (error) {
        try { socket.end(encode({ ok: false, error: { message: String(error?.message ?? error), code: error?.code ?? null } })); }
        catch { socket.destroy(); }
      }
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.off('error', reject); resolve(); });
    });
    await chmod(path, 0o600);
    const identity = await privateSocket(root);
    let closed = false;
    return { close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of connections) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      const current = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current?.isSocket() && current.dev === identity.dev && current.ino === identity.ino) await unlink(path);
    } };
  } catch (error) {
    server.close();
    throw error;
  }
}

/** No retry: a failed connection can have an unknown dispatch outcome. */
export async function callCollaboration({ root, peer, token, method, params = {}, timeoutMs = SOCKET_LIFETIME_MS }) {
  validateEnvelope({ peer, token, method, params });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SOCKET_LIFETIME_MS) fail('Invalid collaboration timeout');
  await privateSocket(root);
  const request = encode({ peer, token, method, params });
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath(root) });
    let settled = false;
    let bytes = Buffer.alloc(0);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('Collaboration request timed out; completion is unknown')));
    socket.once('connect', () => socket.write(request));
    socket.once('error', error => finish(error));
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > MAX_FRAME) { finish(new Error('Collaboration response exceeds 1 MiB')); return; }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      if (newline !== bytes.length - 1) { finish(new Error('Invalid collaboration response framing')); return; }
      try {
        const response = decode(bytes.subarray(0, newline));
        if (response.ok === true && Object.hasOwn(response, 'result') && !Object.hasOwn(response, 'error')) finish(null, response.result);
        else if (response.ok === false && object(response.error) && typeof response.error.message === 'string') {
          const error = new Error(response.error.message);
          if (response.error.code !== null && response.error.code !== undefined) error.code = response.error.code;
          finish(error);
        } else fail('Invalid collaboration response');
      } catch (error) { finish(error); }
    });
    socket.once('end', () => finish(new Error('Collaboration connection closed without a response; completion is unknown')));
  });
}

const tool = (name, description, properties, required = []) => ({
  name: `claudex_${name}`, description: description + (name === 'start'
    ? ' The default workspace is the enclosing Git checkout root, or cwd for non-Git folders. Optional projectRoot explicitly contains cwd; readOnlyDirs grant reference access and writableDirs grant additional writes. Supply only user-authorized directories. Children inherit or narrow parent access; they cannot expand it. Handoffs preserve directory grants.' : ''),
  inputSchema: { type: 'object', properties: { ...properties,
    ...(['start', 'handoff'].includes(name) ? { effort } : {}),
    ...(name === 'start' ? { projectRoot: str, readOnlyDirs: directories, writableDirs: directories } : {}) }, required, additionalProperties: false },
});
const str = { type: 'string', minLength: 1 };
const directories = { type: 'array', maxItems: 16, items: str };
const model = { type: ['string', 'null'], minLength: 1, maxLength: 200, pattern: '^\\S(?:[^\\u0000-\\u001f\\u007f-\\u009f]*\\S)?$' };
const integer = { type: 'integer', minimum: 0 };
const effort = { type: ['string', 'null'], enum: [...new Set(Object.values(collaborationEfforts).flat()), null],
  description: 'Provider-native reasoning effort. Omitted uses the destination provider default; null uses the native CLI default. Codex: none, minimal, low, medium, high, xhigh, max, ultra. Claude: low, medium, high, xhigh, max. Model-specific restrictions are enforced by the native CLI; no fallback is applied.' };
const view = { type: 'string', enum: ['full', 'summary'] };
const toolDefinitions = [
  tool('start', 'Run real model work with Codex or Claude. Starts a child of the current managed worker, otherwise a root task. Supply the goal and relevant context explicitly. Use a stable unique requestId. Tasks and children may run concurrently in the same workspace: assign disjoint file responsibilities and coordinate shared edits; there is no workspace lock or automatic conflict merge. Work has no execution deadline; explicitly cancel unwanted work. Use status/wait for results. Omitted model uses the receiving provider default reported by claudex_list, never the parent model; explicit null uses the native CLI default. Omitted permission inherits the parent or broker policy; claudex_list reports its default. Explicit read-only never elevates. For whole-work handoff from an external chat, delegate the remaining work and stop your own work.', { provider: { type: 'string', enum: ['codex', 'claude'] }, cwd: str, prompt: str, permission: { type: 'string', enum: ['read-only', 'workspace-write'] }, model, requestId: str }, ['provider', 'cwd', 'prompt', 'requestId']),
  tool('send', 'Deliver a message at the next task boundary.', { taskId: str, message: str, requestId: str }, ['taskId', 'message', 'requestId']),
  tool('handoff', 'Transfer this same task to the other provider. Optional model overrides the receiving provider default reported by claudex_list; omission uses that default, not the outgoing model. Explicit null uses the native CLI default. Read status for the current revision first. Include all progress, remaining work and constraints in the message. After acknowledgement end your native turn immediately with exactly CLAUDEX_HANDOFF: no further tools or summary, and do not wait on yourself. Transfer occurs only after successful native completion and process exit. Finish active children first.', { taskId: str, provider: { type: 'string', enum: ['codex', 'claude'] }, model, message: str, requestId: str, revision: integer }, ['taskId', 'provider', 'message', 'requestId', 'revision']),
  tool('status', 'Read task status without starting a model. resultFinal identifies a completed answer; legacy result may be historical or a yield boundary. Optional view=summary omits message history; full is the default.', { taskId: str, view }, ['taskId']),
  tool('wait', 'Wait up to 30 seconds for a task revision without starting a model. Prefer view=summary with afterRevision to avoid repeated history; changed/timedOut/terminal/resultFinal describe the response. Unseen terminal child outcomes are still delivered and acknowledged. Use view=full for complete history.', { taskId: str, view, afterRevision: integer, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 } }, ['taskId']),
  tool('cancel', 'Request cancellation. Check cancelAccepted, cancelPending and terminal: acceptance is not proof of process exit. Wait for a terminal outcome; an unsafe shutdown may remain uncertain. Completed, failed or cancelled tasks are no-ops; uncertain tasks require operator inspection and reject cancellation.', { taskId: str, requestId: str }, ['taskId', 'requestId']),
  tool('list', 'List visible tasks.', {}, []),
  tool('chat_list', 'Find hook-registered native chats by title. Optional query searches native title metadata only, provider filters codex/claude, match selects exact or contains (default). Results include title, titleMatch, source and errors, sessionId and cwd; follow nextCursor. Titles are not unique IDs: if multiple or partial matches exist, ask the user to choose, never silently pick the newest. Do not send from errored title metadata. Pass the chosen sessionId and verbatim expectedTitle to chat_send. Does not scan conversation text or register unknown chats.', { limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: str,
    query: str, provider: { type: 'string', enum: ['codex', 'claude'] }, match: { type: 'string', enum: ['exact', 'contains'] } }, []),
  tool('chat_send', 'Send an explicitly user-authorized peer message. Controller only. Supply title for automatic unique exact-title lookup, optionally with provider; duplicates return needs-selection without sending. Alternatively use provider/sessionId and expectedTitle from chat_list. Codex wakes the original Desktop chat through its native owner. Claude wakes through the installed Desktop bridge when idle with no draft or pending permission. Wake consumes native model allowance; busy chats defer to hooks. Set wake=false for queue-only delivery. Ended chats accept queued messages waiting for native resumption. Never creates a replacement chat or a second writer. Does not grant permissions or interrupt work. Check chat_status: waiting-for-resume is not delivery, offered is not acknowledged; an uncertain wake is never retried.', {
    title: { ...str, description: 'Exact recipient title; unique matches send directly, duplicates require selection. Mutually exclusive with sessionId/expectedTitle.' },
    provider: { type: 'string', enum: ['codex', 'claude'] }, sessionId: str, expectedTitle: { ...str, description: 'Verbatim title from the chosen search result; rechecked before enqueueing to catch renames or unavailable metadata.' }, message: { type: 'string', minLength: 1, maxLength: 1500 },
    wake: { type: 'boolean', description: 'Defaults true: permit native Desktop wake and model inference. Claude requires the loaded Desktop bridge; false queues for the next native hook only.' },
    requestId: str, expiresInMs: { type: 'integer', minimum: 1000, maximum: 3600000 },
  }, ['message', 'requestId']),
  tool('chat_status', 'Read a native-chat coordination message receipt. Offered means hook output prepared, not proven read; acknowledged means the exact recipient emitted its acknowledgement marker, not that requested actions succeeded. No resend or inference.', { messageId: str }, ['messageId']),
];
const desktopWakeTools = [
  tool('desktop_owner_wake', 'Publish an identity-only activation hint for an exact current Claudex Remote Control owner. No message input, synchronization or inference request.', {
    remoteId: { type: 'string', minLength: 5, maxLength: 204, pattern: '^cse_[A-Za-z0-9_-]{1,200}$' },
  }, ['remoteId']),
  tool('desktop_wake_claim', 'Claim one exact pending Claude Desktop peer message. Native renderer bridge only; no arbitrary work execution.', {
    messageId: str, sessionId: str,
  }, ['messageId', 'sessionId']),
  tool('desktop_wake_receipt', 'Record a claimed native dispatch outcome. Acceptance is not recipient acknowledgement. Never replay uncertain dispatch.', {
    messageId: str, sessionId: str, claimId: str, status: { type: 'string', enum: ['accepted', 'uncertain'] }, detail: str,
  }, ['messageId', 'sessionId', 'claimId', 'status', 'detail']),
];
const byName = new Map([...toolDefinitions, ...desktopWakeTools].map(entry => [entry.name, entry]));

function validateTool(name, args) {
  const definition = byName.get(name);
  if (!definition || !object(args)) fail('Unknown tool or invalid arguments');
  const schema = definition.inputSchema;
  if (schema.required.some(key => !Object.hasOwn(args, key)) || Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) fail('Invalid tool arguments');
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (key === 'effort') validateCollaborationEffort(args.provider, value);
    if (field.type === 'string' && (typeof value !== 'string' || value.length < (field.minLength ?? 0) || (field.enum && !field.enum.includes(value)))) fail(`Invalid ${key}`);
    if (name === 'claudex_desktop_owner_wake' && (value.length > field.maxLength || !new RegExp(field.pattern).test(value))) fail(`Invalid ${key}`);
    if (key === 'model' && value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > 200 || value !== value.trim() || !value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value))) fail('Invalid model');
    if (field.type === 'integer' && (!Number.isInteger(value) || value < field.minimum || (field.maximum !== undefined && value > field.maximum))) fail(`Invalid ${key}`);
    if (field.type === 'array' && (!Array.isArray(value) || value.length > field.maxItems
      || value.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')))) fail(`Invalid ${key}`);
  }
  if (name === 'claudex_start' && !isAbsolute(args.cwd)) fail('cwd must be absolute');
  if (name === 'claudex_start' && args.projectRoot !== undefined && !isAbsolute(args.projectRoot)) fail('projectRoot must be absolute');
  return name.slice('claudex_'.length);
}

/** Minimal newline JSON-RPC MCP facade. It emits protocol data only on output. */
export async function runCollaborationMcp({ root, peer, token, input = process.stdin, output = process.stdout, desktopWakeOnly = false }) {
  if (!['codex', 'claude'].includes(peer)) fail('Invalid MCP peer');
  let active = 0;
  let buffer = Buffer.alloc(0);
  let chain = Promise.resolve();
  const send = value => { output.write(encode(value)); };
  const respond = async request => {
    if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return;
    const id = request.id;
    const hasId = Object.hasOwn(request, 'id');
    if (!hasId) return; // initialized and other notifications
    try {
      let result;
      if (request.method === 'initialize') {
        const version = request.params?.protocolVersion;
        result = { protocolVersion: VERSIONS.has(version) ? version : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'claudex', version: '1.0.3' } };
      } else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools: desktopWakeOnly ? desktopWakeTools : toolDefinitions };
      else if (request.method === 'tools/call') {
        const { name, arguments: args = {} } = request.params ?? {};
        try {
          if (!(desktopWakeOnly ? desktopWakeTools : toolDefinitions).some(tool => tool.name === name)) throw new Error('Unknown tool for this endpoint.');
          const method = validateTool(name, args);
          const params = args;
          const value = await callCollaboration({ root, peer, token, method, params, timeoutMs: method === 'wait' ? Math.min(SOCKET_LIFETIME_MS, (args.timeoutMs ?? 30000) + 5000) : SOCKET_LIFETIME_MS });
          result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
        } catch (error) { result = { content: [{ type: 'text', text: String(error.message) }], isError: true }; }
      } else { send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return; }
      send({ jsonrpc: '2.0', id, result });
    } catch (error) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error.message) } }); }
  };
  await new Promise((resolve, reject) => {
    input.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(10)) >= 0) {
        if (newline + 1 > MAX_FRAME) { reject(new Error('MCP frame exceeds 1 MiB')); input.destroy?.(); return; }
        const frame = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        let request;
        try { request = decode(frame); }
        catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
        if (active >= 16) { if (Object.hasOwn(request, 'id')) send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'Too many concurrent MCP requests' } }); continue; }
        active++;
        const operation = respond(request).finally(() => { active--; });
        chain = Promise.allSettled([chain, operation]).then(() => {});
      }
      if (buffer.length > MAX_FRAME) { reject(new Error('MCP frame exceeds 1 MiB')); input.destroy?.(); }
    });
    input.once('error', reject);
    input.once('end', resolve);
  });
  await chain;
}
