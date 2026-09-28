import net from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const MAX_FRAME = 1024 * 1024;
const MAX_CONNECTIONS = 64;
const SOCKET_LIFETIME_MS = 65000;
const METHODS = new Set(['start', 'send', 'handoff', 'status', 'wait', 'cancel', 'list', 'resolve', 'models']);
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
  name: `claudex_${name}`, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});
const str = { type: 'string', minLength: 1 };
const model = { type: ['string', 'null'], minLength: 1, maxLength: 200, pattern: '^\\S(?:[^\\u0000-\\u001f\\u007f-\\u009f]*\\S)?$' };
const integer = { type: 'integer', minimum: 0 };
const view = { type: 'string', enum: ['full', 'summary'] };
const toolDefinitions = [
  tool('start', 'Run real model work with Codex or Claude. Starts a child of the current managed worker, otherwise a root task. Supply the goal and relevant context explicitly. Use a stable unique requestId. If deferredUntilParentExit is true, end your native turn immediately with exactly CLAUDEX_YIELD: no more tools or summary; the child runs after you exit and you resume with its result. Otherwise use status/wait for results. Omitted model uses the receiving provider default reported by claudex_list, never the parent model; explicit null uses the native CLI default. Omitted permission inherits the parent or broker policy; claudex_list reports its default. Explicit read-only never elevates. For whole-work handoff from an external chat, delegate the remaining work and stop your own work.', { provider: { type: 'string', enum: ['codex', 'claude'] }, cwd: str, prompt: str, permission: { type: 'string', enum: ['read-only', 'workspace-write'] }, model, requestId: str }, ['provider', 'cwd', 'prompt', 'requestId']),
  tool('send', 'Deliver a message at the next task boundary.', { taskId: str, message: str, requestId: str }, ['taskId', 'message', 'requestId']),
  tool('handoff', 'Transfer this same task to the other provider. Optional model overrides the receiving provider default reported by claudex_list; omission uses that default, not the outgoing model. Explicit null uses the native CLI default. Read status for the current revision first. Include all progress, remaining work and constraints in the message. After acknowledgement end your native turn immediately with exactly CLAUDEX_HANDOFF: no further tools or summary, and do not wait on yourself. Transfer occurs only after successful native completion and process exit. Finish active children first.', { taskId: str, provider: { type: 'string', enum: ['codex', 'claude'] }, model, message: str, requestId: str, revision: integer }, ['taskId', 'provider', 'message', 'requestId', 'revision']),
  tool('status', 'Read task status without starting a model. resultFinal identifies a completed answer; legacy result may be historical or a yield boundary. Optional view=summary omits message history; full is the default.', { taskId: str, view }, ['taskId']),
  tool('wait', 'Wait up to 30 seconds for a task revision without starting a model. Prefer view=summary with afterRevision to avoid repeated history; changed/timedOut/terminal/resultFinal describe the response. Unseen terminal child outcomes are still delivered and acknowledged. Use view=full for complete history.', { taskId: str, view, afterRevision: integer, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 } }, ['taskId']),
  tool('cancel', 'Request cancellation. Check cancelAccepted, cancelPending and terminal: acceptance is not proof of process exit. Wait for a terminal outcome; an unsafe shutdown may remain uncertain. Completed, failed or cancelled tasks are no-ops; uncertain tasks require operator inspection and reject cancellation.', { taskId: str, requestId: str }, ['taskId', 'requestId']),
  tool('list', 'List visible tasks.', {}, []),
];
const byName = new Map(toolDefinitions.map(entry => [entry.name, entry]));

function validateTool(name, args) {
  const definition = byName.get(name);
  if (!definition || !object(args)) fail('Unknown tool or invalid arguments');
  const schema = definition.inputSchema;
  if (schema.required.some(key => !Object.hasOwn(args, key)) || Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) fail('Invalid tool arguments');
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (field.type === 'string' && (typeof value !== 'string' || value.length < (field.minLength ?? 0) || (field.enum && !field.enum.includes(value)))) fail(`Invalid ${key}`);
    if (key === 'model' && value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > 200 || value !== value.trim() || !value.trim() || /[\u0000-\u001f\u007f-\u009f]/u.test(value))) fail('Invalid model');
    if (field.type === 'integer' && (!Number.isInteger(value) || value < field.minimum || (field.maximum !== undefined && value > field.maximum))) fail(`Invalid ${key}`);
  }
  if (name === 'claudex_start' && !isAbsolute(args.cwd)) fail('cwd must be absolute');
  return name.slice('claudex_'.length);
}

/** Minimal newline JSON-RPC MCP facade. It emits protocol data only on output. */
export async function runCollaborationMcp({ root, peer, token, input = process.stdin, output = process.stdout }) {
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
        result = { protocolVersion: VERSIONS.has(version) ? version : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'claudex', version: '0.2.0' } };
      } else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools: toolDefinitions };
      else if (request.method === 'tools/call') {
        const { name, arguments: args = {} } = request.params ?? {};
        try {
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
