import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { collaborationEfforts, validateCollaborationEffort } from './collaboration-effort.mjs';
import { validateOutcome, OUTCOMES, NEED_KINDS } from './collaboration-outcome.mjs';
import { notificationPolicy } from './collaboration-notification-policy.mjs';
import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from './collaboration-wait.mjs';
import { attachWorkerBoundary } from './collaboration-worker-boundary.mjs';

const MAX_FRAME = 1024 * 1024;
// Leave room for controller/status clients when all 64 workers are waiting.
const MAX_CONNECTIONS = 128;
const SOCKET_LIFETIME_MS = 65000;
const WAIT_RESPONSE_GRACE_MS = 5000;
const METHODS = new Set(['start', 'send', 'handoff', 'report', 'work_events', 'work_reports', 'artifact_read', 'work_control', 'worker_check_in', 'origin_bind', 'origin_recheck', 'status', 'wait', 'cancel', 'list', 'resolve', 'models', 'chat_list', 'chat_send', 'chat_status', 'desktop_wake_claim', 'desktop_wake_receipt', 'desktop_owner_wake', 'native_wake', 'mod_wake_wait', 'mod_wake_claim', 'mod_wake_receipt', 'mod_wake_check', 'mod_wake_receive', 'mod_wake_observe', 'mod_wake_status']);
for (const action of ['list', 'configure', 'observe', 'claim', 'check', 'receipt']) METHODS.add(`cache_warm_${action}`);
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

function requestTimeoutLimit(method, params) {
  if (method !== 'wait') return SOCKET_LIFETIME_MS;
  // Only a bounded, structurally valid task wait may retain a longer socket.
  // The broker still authenticates the caller and verifies task access.
  validateTool('claudex_wait', params);
  return Math.max(SOCKET_LIFETIME_MS, (params.timeoutMs ?? DEFAULT_WAIT_MS) + WAIT_RESPONSE_GRACE_MS);
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
        socket.setTimeout(requestTimeoutLimit(request.method, request.params));
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
export async function callCollaboration({ root, peer, token, method, params = {}, timeoutMs }) {
  validateEnvelope({ peer, token, method, params });
  const limit = requestTimeoutLimit(method, params);
  if (timeoutMs === undefined) timeoutMs = limit;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > limit) fail('Invalid collaboration timeout');
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
    ...(name === 'start' ? { projectRoot: str, readOnlyDirs: directories, writableDirs: directories,
      observability: { type: 'object', additionalProperties: false, properties: {
        timeline: { type: 'string', enum: ['off', 'public'], default: 'off' },
        reports: { type: 'string', enum: ['off', 'milestones'], default: 'off' },
        blockerNotifications: { type: 'boolean', default: false } },
      description: 'Explicit per-task opt-in. Public timeline retains bounded public assistant messages and allowlisted tool metadata, never prompts, reasoning or raw tool output. Milestone reports are worker self-reports; for managed children, distinct milestones may resume a waiting parent for proactive follow-up before child completion. This does not enable external native-chat wake. Blocker notifications independently opt into the existing authorized notification route.' },
      notifications: { type: 'object', additionalProperties: false, required: ['mode'], properties: {
        mode: { type: 'string', enum: ['off', 'queue', 'wake'] }, expiresInMs: { type: 'integer', minimum: 1000, maximum: 3600000 } },
      description: 'Root tasks only; default off. When the user requests background delegation with a completion wake, select wake explicitly; it consumes model allowance. Queue delivers only at the next native hook and cannot wake an idle caller. After start, call status with checkNotification=true: await-notification permits ending the current turn with a pending-work handoff, not a completion claim; wait means retain status/wait monitoring; read-result means collect the result now. Native PostToolUse proof is mandatory. Route checks are snapshots, not delivery guarantees. On notification, read status and continue the original authorized work; never replay an uncertain send.' } } : {}) }, required, additionalProperties: false },
});
const str = { type: 'string', minLength: 1 };
const directories = { type: 'array', maxItems: 16, items: str };
const model = { type: ['string', 'null'], minLength: 1, maxLength: 200, pattern: '^\\S(?:[^\\u0000-\\u001f\\u007f-\\u009f]*\\S)?$' };
const integer = { type: 'integer', minimum: 0 };
const effort = { type: ['string', 'null'], enum: [...new Set(Object.values(collaborationEfforts).flat()), null],
  description: 'Provider-native reasoning effort. Omitted uses the destination provider default; null uses the native CLI default. Codex: none, minimal, low, medium, high, xhigh, max, ultra. Claude: low, medium, high, xhigh, max. Model-specific restrictions are enforced by the native CLI; no fallback is applied.' };
const view = { type: 'string', enum: ['full', 'summary'] };
const report = { type: 'object', additionalProperties: false, required: ['outcome', 'summary'], properties: {
  outcome: { type: 'string', enum: OUTCOMES }, summary: { ...str, maxLength: 4096 },
  stage: { ...str, maxLength: 2048 }, next: { ...str, maxLength: 2048 },
  checks: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['name', 'result'],
    properties: { name: { ...str, maxLength: 2048 }, result: { type: 'string', enum: ['passed', 'failed', 'not-run', 'unverified'] }, reference: { ...str, maxLength: 2048 }, at: { type: 'integer', minimum: 1 } } } },
  blocker: { type: 'object', additionalProperties: false, required: ['question', 'impact', 'needs'], properties: {
    id: str, question: { ...str, maxLength: 2048 }, impact: { ...str, maxLength: 2048 }, needs: { ...str, maxLength: 2048 } } },
  remaining: { type: 'array', maxItems: 16, items: { ...str, maxLength: 2048 } },
  needs: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['kind', 'description'],
    properties: { kind: { type: 'string', enum: NEED_KINDS }, description: { ...str, maxLength: 2048 } } } },
  artifacts: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['kind', 'reference'],
    properties: { kind: { type: 'string', enum: ['file', 'url', 'commit', 'other'] }, reference: { ...str, maxLength: 2048 },
      description: { ...str, maxLength: 2048 } } } },
} };
const targets = { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', additionalProperties: false,
  required: ['taskId'], properties: { taskId: str, afterRevision: integer } } };
const toolDefinitions = [
  tool('start', 'Run real model work with Codex or Claude. Starts a child of the current managed worker, otherwise a root task. Supply the goal and relevant context explicitly. Use a stable unique requestId. Tasks and children may run concurrently in the same workspace: assign disjoint file responsibilities and coordinate shared edits; there is no workspace lock or automatic conflict merge. Work has no execution deadline; explicitly cancel unwanted work. Use status/wait for results. Omitted model uses the receiving provider default reported by claudex_list, never the parent model; explicit null uses the native CLI default. Omitted permission inherits the parent or broker policy; claudex_list reports its default. Explicit read-only never elevates. For whole-work handoff from an external chat, delegate the remaining work and stop your own work.', { provider: { type: 'string', enum: ['codex', 'claude'] }, cwd: str, prompt: str, permission: { type: 'string', enum: ['read-only', 'workspace-write'] }, model, requestId: str }, ['provider', 'cwd', 'prompt', 'requestId']),
  tool('send', 'Proactively send a follow-up to an existing task, including while it is running; no prior worker question is required. The worker can receive it during the same invocation at a cooperative check-in or worker MCP response boundary, then explicitly acknowledge accepted or rejected. Queued is not delivered or adopted. Unconsumed follow-ups retain normal next-boundary handling. Does not interrupt a running native tool or expand permissions.', { taskId: str, message: str, requestId: str }, ['taskId', 'message', 'requestId']),
  tool('handoff', 'Transfer this same task to the other provider. Optional report carries structured self-reported outcome and remaining work, never independent proof. Optional model overrides the receiving provider default; omission uses that default, not the outgoing model. Read status for the revision first. Include progress, remaining work and constraints in the message. After acknowledgement end immediately with exactly CLAUDEX_HANDOFF: no further tools or summary. Transfer occurs only after successful native completion and process exit. Finish active children first.', { taskId: str, provider: { type: 'string', enum: ['codex', 'claude'] }, model, message: str, report, requestId: str, revision: integer }, ['taskId', 'provider', 'message', 'requestId', 'revision']),
  tool('report', 'Active worker only: record generation-bound structured progress for your own task. Does not complete execution, verify success or authorize work. Use unique requestIds at meaningful milestones; preserve remaining work and typed needs. With reports=milestones, a distinct report can resume your waiting managed parent for proactive follow-up while you keep working; unchanged same-generation reports are deduplicated. Reuse an exact blocker ID for its updates. Only explicitly enabled blocker notifications may use an already authorized native-chat route.', { taskId: str, report, requestId: str }, ['taskId', 'report', 'requestId']),
  tool('work_events', 'Read bounded public work events for one exact task and execution generation. No inference, revision change, child-result acknowledgement or native-history scan. Cursor is an event position, never a task revision. Old or disabled tasks report not collected; inspect gaps and collection limits. Use recent for a bounded tail, or cursor for incremental pages.', {
    taskId: str, generation: { type: 'integer', minimum: 1 }, cursor: str,
    limit: { type: 'integer', minimum: 1, maximum: 64 }, recent: { type: 'boolean' },
  }, ['taskId', 'generation']),
  tool('artifact_read', 'Read an explicitly reported file artifact for one exact task and generation within its canonical directory grants. No arbitrary host paths, native histories, inference or child-result acknowledgement. Current bytes are inspection evidence, not proof that the worker authored all changes.', {
    taskId: str, generation: { type: 'integer', minimum: 1 }, reference: str, maxBytes: { type: 'integer', minimum: 1, maximum: 65536 },
    view: { type: 'string', enum: ['content', 'diff'] },
  }, ['taskId', 'generation', 'reference']),
  tool('work_reports', 'Read complete bounded structured worker report history for an exact execution generation, including declared checks, artifacts and limitations. No child-result acknowledgement, task revision change or model inference. Reports remain self-reported; cursor is not a task revision.', {
    taskId: str, generation: { type: 'integer', minimum: 1 }, cursor: str,
    limit: { type: 'integer', minimum: 1, maximum: 16 }, recent: { type: 'boolean' },
  }, ['taskId', 'generation']),
  tool('work_control', 'Generation-fenced cooperative work control. The active worker uses check-in at meaningful work boundaries and before consequential writes to receive queued instructions in its current invocation; acknowledge each delivered instruction as accepted or rejected before acting. Reading ordinary status never consumes instructions. Controllers may respond to or resolve an exact blocker, request pause, resume or explicitly review/integrate a result. Pause requests do not freeze a process: the worker must checkpoint and finish and owned processes must exit before paused. Never bypass cancellation, handoff or writer guards. Responses are peer instructions, not new user permission. Each mutation requires a stable unique requestId.', {
    taskId: str, generation: { type: 'integer', minimum: 1 }, requestId: str,
    action: { type: 'string', enum: ['check-in', 'respond-blocker', 'resolve-blocker', 'ack-instruction', 'request-pause', 'checkpoint', 'resume', 'review-result'] },
    limit: { type: 'integer', minimum: 1, maximum: 16, description: 'Only for check-in; maximum instructions returned, default 8.' },
    blockerId: str, instructionId: str, text: { ...str, maxLength: 4096 },
    decision: { type: 'string', enum: ['accepted', 'rejected', 'reviewed', 'integrated'] },
  }, ['taskId', 'generation', 'requestId', 'action']),
  tool('status', 'Read task status without starting a model. resultFinal identifies a completed answer; legacy result may be historical or a yield boundary. Optional view=summary omits message history; full is the default. External callers can set checkNotification=true after wake-enabled start to inspect notification.continuation.nextAction: await-notification, wait, or read-result. This read-only route snapshot never opens a chat, sends input, grants permission, or guarantees future delivery. After a completion notification, collect the exact task result here and continue within the original user scope.', { taskId: str, view, checkNotification: { type: 'boolean' } }, ['taskId']),
  tool('wait', 'Wait without starting a model: 5 minutes by default, up to 30 minutes with explicit timeoutMs. Returns early on a task revision or terminal outcome; activity heartbeats do not wake it. Client disconnect or timeout does not cancel work. Supply taskId/afterRevision for the compatible single-task response, OR 1–16 distinct targets for {tasks,timedOut,changed,terminal}. Multi-wait defaults summary and returns all ready targets, or all snapshots at timeout; only returned child outcomes are acknowledged. Caught-up terminal summary outcomes are omitted unless unseen by the parent. Revisions describe work changes, not activity heartbeats.', { taskId: str, targets, view, afterRevision: integer, timeoutMs: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS, default: DEFAULT_WAIT_MS } }),
  tool('cancel', 'Request cancellation. Check cancelAccepted, cancelPending and terminal: acceptance is not proof of process exit. Wait for a terminal outcome; an unsafe shutdown may remain uncertain. Completed, failed or cancelled tasks are no-ops; uncertain tasks require operator inspection and reject cancellation.', { taskId: str, requestId: str }, ['taskId', 'requestId']),
  tool('list', 'List visible tasks with per-task observed waitReason and exact blockers. Global blockedByUncertainWork is a legacy inventory flag, not proof this task is blocked. Follow nextCursor with identical filters; pages are live, not frozen snapshots.', {
    status: { type: 'string', enum: ['ready', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled', 'uncertain'] },
    parentId: { type: ['string', 'null'] }, project: str, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: str }, []),
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
    if (key === 'report') validateOutcome(value);
    if (key === 'notifications') notificationPolicy(value);
    if (field.type === 'boolean' && typeof value !== 'boolean') fail(`Invalid ${key}`);
    if (key === 'observability' && (!object(value) || Object.keys(value).some(key => !['timeline', 'reports', 'blockerNotifications'].includes(key))
      || value.timeline !== undefined && !['off', 'public'].includes(value.timeline)
      || value.reports !== undefined && !['off', 'milestones'].includes(value.reports)
      || value.blockerNotifications !== undefined && typeof value.blockerNotifications !== 'boolean')) fail('Invalid observability');
    if (key === 'targets') {
      if (!Array.isArray(value) || value.length < 1 || value.length > 16
        || value.some(target => !object(target) || Object.keys(target).some(key => !['taskId', 'afterRevision'].includes(key))
          || typeof target.taskId !== 'string' || !target.taskId || target.afterRevision !== undefined
            && (!Number.isSafeInteger(target.afterRevision) || target.afterRevision < 0))
        || new Set(value.map(target => target.taskId)).size !== value.length) fail('Invalid targets');
    }
    if (['readOnlyDirs', 'writableDirs'].includes(key) && (!Array.isArray(value) || value.length > field.maxItems
      || value.some(path => typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')))) fail(`Invalid ${key}`);
  }
  if (name === 'claudex_wait' && (args.targets === undefined ? args.taskId === undefined
    : args.taskId !== undefined || args.afterRevision !== undefined)) fail('Supply taskId or targets, not both');
  if (name === 'claudex_start' && !isAbsolute(args.cwd)) fail('cwd must be absolute');
  if (name === 'claudex_start' && args.projectRoot !== undefined && !isAbsolute(args.projectRoot)) fail('projectRoot must be absolute');
  return name.slice('claudex_'.length);
}

/** Minimal newline JSON-RPC MCP facade. It emits protocol data only on output. */
export async function runCollaborationMcp({ root, peer, token, input = process.stdin, output = process.stdout, desktopWakeOnly = false, workerMode = false }) {
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
          const value = await callCollaboration({ root, peer, token, method, params,
            timeoutMs: method === 'wait' ? (args.timeoutMs ?? DEFAULT_WAIT_MS) + WAIT_RESPONSE_GRACE_MS : SOCKET_LIFETIME_MS });
          result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
          result = await attachWorkerBoundary({ enabled: workerMode === true && !desktopWakeOnly,
            method, params, result, responseId: id, requestId: `boundary:${randomUUID()}`,
            callCheckIn: intake => callCollaboration({ root, peer, token, method: 'worker_check_in', params: intake }) });
        } catch (error) { result = { content: [{ type: 'text', text: String(error.message) }], isError: true,
          structuredContent: { error: { code: typeof error.code === 'string' ? error.code : null, message: String(error.message) } } }; }
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
