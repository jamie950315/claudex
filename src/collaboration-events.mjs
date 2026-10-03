import { createHash } from 'node:crypto';

// This bounded ledger is part of the broker's durable task transaction, not a
// second task authority. Readers never acknowledge results or change revisions.
export const WORK_EVENT_LIMITS = Object.freeze({ events: 256, bytes: 512 * 1024, seen: 2048, page: 64, pageBytes: 192 * 1024, textBytes: 8192 });
const kinds = new Set(['assistant-message', 'tool-start', 'tool-end', 'report', 'blocker', 'instruction', 'control', 'termination']);
const sources = new Set(['native:codex', 'native:claude', 'worker-self-report', 'worker-self-reported', 'controller-self-report', 'controller-self-reported', 'broker']);
const publicKinds = new Set(['assistant-message', 'tool-start', 'tool-end']);
const fields = {
  'assistant-message': ['text'], 'tool-start': ['toolKind', 'toolName', 'status'],
  'tool-end': ['toolKind', 'toolName', 'status', 'exitCode'],
  report: ['reportId', 'phase', 'summary', 'nextStep', 'outcome'],
  blocker: ['blockerId', 'status', 'question', 'impact', 'requestedAction'],
  instruction: ['instructionId', 'status', 'summary'], control: ['status', 'summary'], termination: ['status'],
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => createHash('sha256').update(value).digest('hex');
const size = value => Buffer.byteLength(JSON.stringify(value));
const fail = message => { throw Object.assign(new Error(message), { code: 'CLAUDEX_WORK_EVENTS_INVALID' }); };
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:/+-]{1,256}$/.test(value);

// Defense in depth only. The primary protection is projecting allowlisted public
// fields, never passing raw native prompts, reasoning or tool payloads here.
function publicText(value) {
  return value.replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[redacted credential]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1[redacted credential]');
}

function projectEvent(value) {
  if (!object(value) || !kinds.has(value.kind) || !sources.has(value.source) || !integer(value.generation)) return null;
  const result = { generation: value.generation, kind: value.kind, source: value.source };
  if (id(value.nativeId)) result.nativeId = value.nativeId;
  if (['message', 'item', 'tool', 'invocation', 'structured'].includes(value.granularity)) result.granularity = value.granularity;
  for (const field of fields[value.kind]) {
    const candidate = value[field];
    if (field === 'exitCode') { if (Number.isSafeInteger(candidate)) result.exitCode = candidate; continue; }
    if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) continue;
    if (Buffer.byteLength(candidate) > WORK_EVENT_LIMITS.textBytes) {
      result.omitted = { reason: 'field-size-limit', field, bytes: Buffer.byteLength(candidate) };
    } else result[field] = publicText(candidate);
  }
  // Imported records must retain an explicit omission marker after restart.
  if (object(value.omitted) && value.omitted.reason === 'field-size-limit' && fields[value.kind].includes(value.omitted.field)
    && integer(value.omitted.bytes) && value.omitted.bytes > WORK_EVENT_LIMITS.textBytes)
    result.omitted = { reason: value.omitted.reason, field: value.omitted.field, bytes: value.omitted.bytes };
  return result;
}

export function initializeWorkEvents(task, policy = task.observability) {
  if (task.workEvents) return task.workEvents;
  task.workEvents = { version: 1, public: policy?.timeline === 'public', nextSequence: 1,
    events: [], seen: [], bytes: 2, dropped: 0, paused: false };
  return task.workEvents;
}

export function validateWorkEvents(task) {
  const state = task.workEvents;
  if (state === undefined) return;
  if (!object(state) || state.version !== 1 || typeof state.public !== 'boolean' || typeof state.paused !== 'boolean'
    || !integer(state.nextSequence) || state.nextSequence < 1 || !integer(state.dropped)
    || !Array.isArray(state.events) || state.events.length > WORK_EVENT_LIMITS.events
    || !Array.isArray(state.seen) || state.seen.length > WORK_EVENT_LIMITS.seen
    || state.seen.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key))
    || new Set(state.seen).size !== state.seen.length || !integer(state.bytes)) fail('Invalid work event ledger.');
  let previous = 0;
  for (const event of state.events) {
    const projected = projectEvent(event);
    if (!projected || event.taskId !== task.id || !integer(event.sequence) || event.sequence <= previous
      || event.sequence >= state.nextSequence || !integer(event.at)
      || event.generation > task.generation || Object.keys(event).some(key => !['taskId', 'sequence', 'at', ...Object.keys(projected)].includes(key))
      || Object.entries(projected).some(([key, value]) => JSON.stringify(event[key]) !== JSON.stringify(value)))
      fail('Invalid persisted work event.');
    previous = event.sequence;
  }
  if (state.bytes !== size(state.events) || state.bytes > WORK_EVENT_LIMITS.bytes) fail('Invalid work event size.');
}

export function appendWorkEvent(task, value, { now = Date.now } = {}) {
  const event = projectEvent(value);
  if (!event || event.generation !== task.generation) return false;
  const state = task.workEvents;
  if (!state || publicKinds.has(event.kind) && !state.public) return false;
  if (state.paused) return false;
  const key = digest(JSON.stringify([event.generation, event.source, event.kind,
    event.nativeId ?? value.eventId ?? event]));
  if (state.seen.includes(key)) return false;
  if (state.seen.length >= WORK_EVENT_LIMITS.seen) { state.paused = true; return true; }
  state.seen.push(key);
  const at = integer(value.at) ? value.at : now();
  if (!integer(at)) fail('Invalid work event time.');
  state.events.push({ ...event, taskId: task.id, sequence: state.nextSequence++, at });
  while (state.events.length > WORK_EVENT_LIMITS.events || size(state.events) > WORK_EVENT_LIMITS.bytes) {
    state.events.shift(); state.dropped++;
  }
  state.bytes = size(state.events);
  return true;
}

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export function queryWorkEvents(task, { generation, cursor, limit = 32, recent = false } = {}) {
  if (!integer(generation) || generation > task.generation) fail('Work events require an exact existing generation.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORK_EVENT_LIMITS.page || typeof recent !== 'boolean') fail('Invalid work event page options.');
  let after = 0;
  if (cursor !== undefined && cursor !== null) {
    if (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor) || recent) fail('Invalid work event cursor.');
    let parsed; try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { fail('Invalid work event cursor.'); }
    if (!object(parsed) || parsed.version !== 1 || parsed.taskId !== task.id || parsed.generation !== generation
      || !integer(parsed.after) || Object.keys(parsed).length !== 4) fail('Work event cursor belongs to another task or generation.');
    after = parsed.after;
  }
  const state = task.workEvents;
  if (state && after >= state.nextSequence) fail('Work event cursor is ahead of the ledger.');
  const candidates = (state?.events ?? []).filter(event => event.generation === generation && event.sequence > after);
  const events = recent ? candidates.slice(-limit) : candidates.slice(0, limit);
  // Budget the escaped MCP text too; limit is an upper bound, never a reason to
  // return an oversized response or silently truncate an individual event.
  while (events.length > 1 && size(JSON.stringify(events)) > WORK_EVENT_LIMITS.pageBytes) {
    if (recent) events.shift(); else events.pop();
  }
  const last = events.at(-1)?.sequence ?? after;
  return { taskId: task.id, generation, events: structuredClone(events),
    cursor: encode({ version: 1, taskId: task.id, generation, after: last }),
    hasMore: !recent && candidates.length > events.length,
    collection: { public: state ? state.public ? 'enabled' : 'off' : 'not-collected',
      status: !state ? 'not-collected' : state.paused ? 'paused-capacity' : 'collecting', limits: WORK_EVENT_LIMITS },
    gap: state?.dropped ? { dropped: state.dropped, beforeSequence: state.events[0]?.sequence ?? state.nextSequence,
      affectsCursor: after < (state.events[0]?.sequence ?? state.nextSequence) - 1 } : null };
}

/** Native stream projection only; no transcript scan and no synthetic token stream. */
export function projectNativeWorkEvents(provider, event, at = Date.now(), { sessionId } = {}) {
  if (!event || event.parent_tool_use_id != null || event.isSidechain === true || event.is_sidechain === true) return [];
  const source = `native:${provider}`, out = [];
  const add = (kind, nativeId, data, granularity) => {
    if (!id(nativeId)) return;
    const projected = projectEvent({ ...data, generation: 0, kind, source, nativeId, granularity });
    if (projected) { delete projected.generation; out.push({ ...projected, at }); }
  };
  if (provider === 'codex') {
    const item = event.item;
    if (event.type === 'item.completed' && item?.type === 'agent_message')
      add('assistant-message', item.id, { text: item.text }, 'message');
    const toolKind = { command_execution: 'command', mcp_tool_call: 'mcp', file_change: 'file-change', web_search: 'web-search' }[item?.type];
    if (toolKind && ['item.started', 'item.completed'].includes(event.type)) add(event.type === 'item.started' ? 'tool-start' : 'tool-end',
      item.id, { toolKind, ...(Number.isSafeInteger(item.exit_code) ? { exitCode: item.exit_code } : {}),
        status: ['in_progress', 'completed', 'failed'].includes(item.status) ? item.status : undefined }, 'item');
  } else if (provider === 'claude') {
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const [index, block] of content.entries()) {
      if (event.type === 'assistant' && block?.type === 'text')
        add('assistant-message', id(event.uuid ?? event.message?.id) ? `${event.uuid ?? event.message.id}:${index}` : null, { text: block.text }, 'message');
      if (event.type === 'assistant' && block?.type === 'tool_use') add('tool-start', block.id,
        { toolKind: 'native-tool', toolName: id(block.name) ? block.name : undefined }, 'tool');
      if (event.type === 'user' && block?.type === 'tool_result') add('tool-end', block.tool_use_id,
        { toolKind: 'native-tool', status: typeof block.is_error === 'boolean' ? block.is_error ? 'failed' : 'completed' : 'returned' }, 'tool');
    }
  }
  const terminal = provider === 'codex' && ['turn.completed', 'turn.failed'].includes(event.type)
    ? event.type === 'turn.completed' ? 'success' : 'failed'
    : provider === 'claude' && event.type === 'result' && typeof event.is_error === 'boolean'
      ? event.is_error ? 'failed' : 'success' : null;
  if (terminal && id(sessionId)) add('termination', `${sessionId}:completion:${terminal}`, { status: `native-reported-${terminal}` }, 'invocation');
  return out;
}
