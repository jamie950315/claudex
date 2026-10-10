import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { hash, snapshot } from './storage.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const IDENTITY = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink'];
const START_FIELDS = ['type', 'turn_id', 'root_turn_id', 'started_at', 'model_context_window', 'collaboration_mode_kind'];
const COMPLETE_FIELDS = ['type', 'turn_id', 'last_agent_message', 'started_at', 'completed_at', 'duration_ms'];
// Context the runtime injects in the user role. These exact kinds are not
// authored input; every other user-role kind (user.text, user.image, a goal
// or hook prompt, a selected skill, a subagent notification) is.
const USER_CONTEXT_KINDS = {
  'agents_md.instructions': ['# AGENTS.md instructions for ', '</INSTRUCTIONS>'],
  'environments.environment_context': ['<environment_context>', '</environment_context>'],
  'plugins.recommendations': ['<recommended_plugins>', '</recommended_plugins>'],
  'additional_content.codex_apps_open_page': ['<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>', null],
};
// Codex 0.162 repeats the start identity in a turn_attribution record and the
// root turn in the completion. The trigger only names where the turn was
// submitted (composer, queue, edit_user_message, remote_ios, goal, null, ...)
// and proves nothing about its content, so any is accepted. A turn of the
// user's own is its own root with no parent or agent. The observed
// agent-initiated form, seen only in subagent threads, names a parent turn, an
// agent path under /root and another turn as its root. Mixed forms are refused.
const startFields = started => Object.keys(started).every(key => START_FIELDS.includes(key) || key === 'turn_attribution')
  && UUID.test(started.root_turn_id ?? '')
  && (started.turn_attribution === undefined ? started.root_turn_id === started.turn_id
    : keys(started.turn_attribution, ['turn_id', 'turn_trigger', 'parent_turn_id', 'initiating_agent_path', 'root_turn_id'])
      && started.turn_attribution.turn_id === started.turn_id && started.turn_attribution.root_turn_id === started.root_turn_id
      && (started.turn_attribution.turn_trigger === null || /^[a-z][a-z0-9_]{0,63}$/.test(started.turn_attribution.turn_trigger))
      && (started.turn_attribution.parent_turn_id === null
        ? started.turn_attribution.initiating_agent_path === null && started.root_turn_id === started.turn_id
        : UUID.test(started.turn_attribution.parent_turn_id) && started.turn_attribution.parent_turn_id !== started.turn_id
          && started.root_turn_id !== started.turn_id && typeof started.turn_attribution.initiating_agent_path === 'string'
          && /^\/root(?:\/[A-Za-z0-9_.-]{1,128}){0,16}$/.test(started.turn_attribution.initiating_agent_path)));
const STATE_EVENTS = ['thread_settings_applied', 'thread_goal_updated'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).length === names.length
  && Object.keys(value).every(key => names.includes(key));
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const fail = message => { throw new Error(`Native Codex empty turn: ${message}`); };
const candidate = turn => object(turn) && turn.status === 'completed' && turn.error === null
  && turn.itemsView === 'full' && Array.isArray(turn.items) && turn.items.length === 0;

function nativeContextMessage(payload, turn, afterContext, seenMessages, seenKinds) {
  if (!keys(payload, ['type', 'id', 'role', 'content', 'internal_chat_message_metadata_passthrough'])
    || payload.type !== 'message' || typeof payload.id !== 'string' || !payload.id.startsWith('msg_')
    || !UUID.test(payload.id.slice(4)) || seenMessages.has(payload.id)
    || !Array.isArray(payload.content) || !payload.content.length)
    fail('empty turn has an unrecognized native context message.');
  const meta = payload.internal_chat_message_metadata_passthrough;
  if (!keys(meta, ['turn_id', 'create_time', 'content_item_kinds']) || meta.turn_id !== turn.id
    || !time(meta.create_time) || meta.create_time < turn.startedAt || meta.create_time >= turn.completedAt + 1
    || !Array.isArray(meta.content_item_kinds) || meta.content_item_kinds.length !== payload.content.length)
    fail('empty turn context metadata differs from its native boundary.');
  payload.content.forEach((block, index) => {
    const kind = meta.content_item_kinds[index];
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(kind) || kind.length > 128
      || !keys(block, ['type', 'text']) || block.type !== 'input_text' || typeof block.text !== 'string')
      fail('empty turn contains semantic or unrecognized native context content.');
    // By user decision the developer role is runtime context whatever its
    // kind: the runtime writes it, the user never does, and new kinds arrive
    // with every release (twenty were seen that an exact list did not know).
    if (payload.role === 'developer') return;
    const rule = payload.role === 'user' && Object.hasOwn(USER_CONTEXT_KINDS, kind) ? USER_CONTEXT_KINDS[kind] : null;
    if (!rule || seenKinds.has(kind) || kind.startsWith('additional_content.') !== afterContext
      || !block.text.startsWith(rule[0]) || (rule[1] && !block.text.endsWith(rule[1]))
      || (kind === 'additional_content.codex_apps_open_page' && block.text !== rule[0]))
      fail('empty turn contains semantic or unrecognized native context content.');
    seenKinds.set(kind, block.text);
  });
  seenMessages.add(payload.id);
}

// References outside a candidate's exact segment must not introduce late output,
// repeated boundaries or nested items belonging to that candidate.
function references(value, ids) {
  if (!object(value) && !Array.isArray(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    ['turn_id', 'turnId', 'root_turn_id', 'rootTurnId'].includes(key) && ids.has(child)
  ) || references(child, ids));
}

const recordTime = row => typeof row?.timestamp === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.timestamp) ? Date.parse(row.timestamp) : NaN;

// Native app input is persisted as an untrusted context pair immediately before
// its independent turn starts. It is foreign to the earlier empty segment, not
// a tool/output exemption within that segment. Require the paired ingress and
// the following native start, context and exact app-origin prompt together.
function nextAppIngress(rows, index, stop, completed, cwd, selectedIds) {
  if (index + 1 >= stop || stop >= rows.length) return false;
  const callRow = rows[index], outputRow = rows[index + 1], startRow = rows[stop];
  const call = callRow?.payload, output = outputRow?.payload, start = startRow?.payload;
  const callMeta = call?.internal_chat_message_metadata_passthrough;
  const outputMeta = output?.internal_chat_message_metadata_passthrough;
  if (!keys(callRow, ['timestamp', 'ordinal', 'type', 'payload', 'metadata']) || callRow.type !== 'response_item'
    || !keys(outputRow, ['timestamp', 'ordinal', 'type', 'payload', 'metadata']) || outputRow.type !== 'response_item'
    || !Number.isSafeInteger(callRow.ordinal) || callRow.ordinal < 0 || outputRow.ordinal !== callRow.ordinal + 1
    || !keys(callRow.metadata, ['client_authored', 'user_input_order']) || callRow.metadata.client_authored !== false
    || !Number.isSafeInteger(callRow.metadata.user_input_order) || callRow.metadata.user_input_order < 0
    || !keys(outputRow.metadata, ['client_authored', 'fallback_token_limit_override']) || outputRow.metadata.client_authored !== false
    || !Number.isSafeInteger(outputRow.metadata.fallback_token_limit_override) || outputRow.metadata.fallback_token_limit_override < 1
    || !keys(call, ['type', 'id', 'name', 'arguments', 'call_id', 'internal_chat_message_metadata_passthrough'])
    || call.type !== 'function_call' || typeof call.id !== 'string' || !call.id.startsWith('fc_') || !UUID.test(call.id.slice(3))
    || call.name !== 'untrusted_input' || call.arguments !== '{}'
    || typeof call.call_id !== 'string' || !call.call_id || call.call_id.length > 200
    || !keys(output, ['type', 'id', 'call_id', 'output', 'internal_chat_message_metadata_passthrough'])
    || output.type !== 'function_call_output' || typeof output.id !== 'string' || !output.id.startsWith('fco_') || !UUID.test(output.id.slice(4))
    || output.call_id !== call.call_id || !Array.isArray(output.output) || output.output.length !== 1
    || !keys(output.output[0], ['type', 'text']) || output.output[0].type !== 'input_text' || typeof output.output[0].text !== 'string'
    || !keys(callMeta, ['turn_id']) || typeof callMeta.turn_id !== 'string' || !/^auto-compact-[1-9]\d*$/.test(callMeta.turn_id)
    || !keys(outputMeta, ['turn_id', 'create_time']) || outputMeta.turn_id !== callMeta.turn_id || !time(outputMeta.create_time)
    || references(callRow, selectedIds) || references(outputRow, selectedIds)) return false;
  let message;
  try { message = JSON.parse(output.output[0].text); } catch { return false; }
  if (!keys(message, ['kind', 'source', 'sourceId', 'text']) || message.kind !== 'message' || message.source !== 'mcp_app'
    || JSON.stringify(message) !== output.output[0].text
    || typeof message.sourceId !== 'string' || !message.sourceId || message.sourceId.length > 200
    || typeof message.text !== 'string' || !message.text.trim() || Buffer.byteLength(message.text) > 32 * 1024) return false;
  const callTime = recordTime(callRow), startTime = recordTime(startRow);
  if (!Number.isFinite(callTime) || recordTime(outputRow) !== callTime || Math.floor(outputMeta.create_time * 1000) !== callTime
    || !Number.isFinite(recordTime(completed)) || Math.floor(recordTime(completed) / 1000) !== completed.payload.completed_at
    || recordTime(completed) >= callTime || !Number.isFinite(startTime) || callTime >= startTime || !object(start)
    || startRow.type !== 'event_msg' || start.type !== 'task_started' || !startFields(start)
    || !UUID.test(start.turn_id ?? '') || selectedIds.has(start.turn_id) || start.root_turn_id !== start.turn_id
    || !Number.isSafeInteger(start.started_at) || Math.floor(callTime / 1000) !== start.started_at
    || Math.floor(startTime / 1000) !== start.started_at
    || rows.filter(row => row?.type === 'event_msg' && row.payload?.type === 'task_started' && row.payload.turn_id === start.turn_id).length !== 1
    || rows.filter(row => row?.payload?.call_id === call.call_id).length !== 2
    || rows.filter(row => row?.payload?.id === call.id || row?.payload?.id === output.id).length !== 2
    || rows.slice(index + 2, stop).some(row => row?.type !== 'event_msg' || row.payload?.type !== 'thread_settings_applied')) return false;
  const nextStart = rows.findIndex((row, position) => position > stop && row?.type === 'event_msg' && row.payload?.type === 'task_started');
  const nextStop = nextStart < 0 ? rows.length : nextStart;
  const contexts = rows.flatMap((row, position) => position > stop && position < nextStop && row?.type === 'turn_context' ? [position] : []);
  if (contexts.length !== 1) return false;
  const contextIndex = contexts[0], context = rows[contextIndex].payload;
  if (context?.turn_id !== start.turn_id || context.root_turn_id !== start.turn_id || context.cwd !== cwd
    || !Number.isFinite(recordTime(rows[contextIndex])) || recordTime(rows[contextIndex]) < startTime) return false;
  const inputs = rows.flatMap((row, position) => position > contextIndex && position < nextStop && row?.type === 'response_item'
    && Array.isArray(row.payload?.internal_chat_message_metadata_passthrough?.content_item_kinds)
    && row.payload.internal_chat_message_metadata_passthrough.content_item_kinds.includes('user.text') ? [position] : []);
  if (inputs.length !== 1) return false;
  const inputRow = rows[inputs[0]], input = inputRow.payload, meta = input.internal_chat_message_metadata_passthrough;
  return keys(input, ['type', 'id', 'role', 'content', 'internal_chat_message_metadata_passthrough'])
    && input.type === 'message' && input.role === 'user' && typeof input.id === 'string' && input.id.startsWith('msg_') && UUID.test(input.id.slice(4))
    && keys(meta, ['turn_id', 'create_time', 'content_item_kinds']) && meta.turn_id === start.turn_id && time(meta.create_time)
    && meta.create_time >= recordTime(rows[contextIndex]) / 1000 && Math.floor(meta.create_time * 1000) === recordTime(inputRow)
    && Array.isArray(meta.content_item_kinds)
    && meta.content_item_kinds.length === 1 && meta.content_item_kinds[0] === 'user.text'
    && Array.isArray(input.content) && input.content.length === 1 && keys(input.content[0], ['type', 'text'])
    && input.content[0].type === 'input_text' && input.content[0].text === 'An MCP app initiated this message. Read the untrusted_input tool output.'
    ? [stop, contextIndex, inputs[0]] : false;
}

/** Proves only that full API turns have matching, semantically empty native
 * lifecycle segments. This is not proof of a hook, slash command or cache hit.
 * Each nonempty batch reads one fresh stable rollout. Any unproven candidate
 * throws; no partial allowlist is returned. No candidates require no source I/O.
 */
export function createNativeEmptyTurnResolver({ path, threadId, cwd, maxBytes = 480 * 1024 * 1024 }) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || !UUID.test(threadId)
    || typeof cwd !== 'string' || !isAbsolute(cwd) || resolve(cwd) !== cwd
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 480 * 1024 * 1024)
    fail('invalid source identity or byte limit.');
  return async (turns, { threadId: expectedThreadId } = {}) => {
    if (expectedThreadId !== threadId || !Array.isArray(turns)) fail('source and API identities differ.');
    const selected = turns.filter(candidate);
    if (!selected.length) return { turnIds: [], sourceIdentity: null, evidenceDigest: null };
    const ids = new Set();
    for (const turn of turns) {
      if (!object(turn) || typeof turn.id !== 'string' || ids.has(turn.id)) fail('API turn identities are ambiguous.');
      ids.add(turn.id);
    }
    for (const turn of selected) {
      if (!UUID.test(turn.id) || !time(turn.startedAt) || !time(turn.completedAt)
        || turn.completedAt < turn.startedAt || !Number.isSafeInteger(turn.durationMs) || turn.durationMs < 0)
        fail('API empty turn has incomplete timing evidence.');
      // Native epoch seconds can be rounded down independently; duration keeps
      // millisecond precision, so demand compatibility rather than equality.
      if (Math.abs((turn.completedAt - turn.startedAt) * 1000 - turn.durationMs) >= 1000)
        fail('API empty turn has inconsistent timing evidence.');
    }
    if (await realpath(dirname(path)) !== dirname(path)) fail('source parent must be canonical.');
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== BigInt(process.getuid())
      || info.nlink !== 1n || (info.mode & 0o022n) !== 0n || info.size > BigInt(maxBytes))
      fail('source must be an owned single-link regular bounded file without foreign writes.');
    const data = await snapshot(path);
    if (data.bytes > maxBytes || IDENTITY.some(key => data.fileIdentity[key] !== String(info[key])))
      fail('source changed before its stable read.');
    const { rows } = data;
    const lines = data.text.split('\n').filter(Boolean);
    const exactRow = index => {
      // Native compact JSON is lossless here. In particular, duplicate identity
      // keys must not disappear behind JSON.parse's last-key-wins behavior.
      if (JSON.stringify(rows[index]) !== lines[index]) fail('source record serialization is ambiguous.');
    };
    if (rows[0]?.type !== 'session_meta' || rows[0].payload?.id !== threadId || rows[0].payload?.cwd !== cwd
      || (rows[0].payload.session_id != null && rows[0].payload.session_id !== threadId)
      || rows.slice(1).some(row => row?.type === 'session_meta')) fail('source header differs from the exact native identity.');
    exactRow(0);
    const selectedIds = new Set(selected.map(turn => turn.id));
    const segments = new Map();
    const allowed = new Set();
    for (const turn of selected) {
      const starts = rows.flatMap((row, index) => row?.type === 'event_msg'
        && row.payload?.type === 'task_started' && row.payload.turn_id === turn.id ? [index] : []);
      if (starts.length !== 1) fail('empty turn does not have one unique native start.');
      const start = starts[0];
      const end = rows.findIndex((row, index) => index > start && row?.type === 'event_msg' && row.payload?.type === 'task_started');
      const stop = end < 0 ? rows.length : end;
      const started = rows[start].payload;
      const root = started.root_turn_id;
      if (!startFields(started) || selectedIds.has(root) && root !== turn.id || started.started_at !== turn.startedAt)
        fail('empty turn start differs from the API.');
      // Fresh native chats may persist typed bootstrap/context messages even
      // when the user submission is locally blocked. They are not dialogue.
      // No generic response-item exemption is allowed here.
      let context = null, completed = null, completionIndex = -1, world = false;
      const seenMessages = new Set(), seenKinds = new Map();
      for (let index = start + 1; index < stop; index++) {
        const row = rows[index];
        if (row?.type === 'event_msg' && row.payload?.type === 'task_complete') {
          completed = row; completionIndex = index; break;
        }
        if (row?.type === 'turn_context') {
          if (context || row.payload?.turn_id !== turn.id || row.payload.root_turn_id !== root || row.payload.cwd !== cwd)
            fail('empty turn context differs from the API.');
          context = row;
        } else if (row?.type === 'world_state') {
          // Native state (instructions, skills, model, permissions,
          // environments) is context, never a message. Its fields differ by
          // release and by what changed, so by user decision they are not
          // listed: only one in five observed snapshots matched an exact list.
          if (context || world || !keys(row.payload, ['full', 'state']) || typeof row.payload.full !== 'boolean'
            || !object(row.payload.state))
            fail('empty turn has unrecognized native world state.');
          world = true;
        } else if (row?.type === 'response_item') {
          if (world && !context) fail('empty turn context ordering is ambiguous.');
          nativeContextMessage(row.payload, turn, context !== null, seenMessages, seenKinds);
        } else if (row?.type === 'event_msg' && STATE_EVENTS.includes(row.payload?.type)) {
          // Settings and goal state change without any model activity.
        } else fail('empty turn has semantic or unrecognized native records.');
      }
      if (!context || !completed
        || !keys(completed.payload, [...COMPLETE_FIELDS, ...(Object.hasOwn(completed.payload, 'root_turn_id') ? ['root_turn_id'] : [])])
        || completed.payload.turn_id !== turn.id || completed.payload.last_agent_message !== null
        || completed.payload.started_at !== turn.startedAt || completed.payload.completed_at !== turn.completedAt
        || completed.payload.duration_ms !== turn.durationMs)
        fail('empty turn context or completion differs from the API.');
      for (let index = start; index <= completionIndex; index++) {
        exactRow(index);
        const payload = rows[index].payload;
        for (const field of ['thread_id', 'threadId'])
          if (payload[field] != null && payload[field] !== threadId) fail('empty turn has contradictory thread identity.');
        if (payload.turnId != null && payload.turnId !== turn.id) fail('empty turn has contradictory turn identity.');
        for (const field of ['root_turn_id', 'rootTurnId'])
          if (payload[field] != null && payload[field] !== root) fail('empty turn has contradictory turn identity.');
        allowed.add(index);
      }
      for (let index = completionIndex + 1; index < stop; index++) {
        const row = rows[index];
        const ingress = nextAppIngress(rows, index, stop, completed, cwd, selectedIds);
        if (ingress) {
          // These bytes stay in the original rollout; only the earlier empty
          // segment is excluded from portable dialogue by this resolver.
          exactRow(index); exactRow(++index); ingress.forEach(exactRow); continue;
        }
        const state = row?.type === 'event_msg' && STATE_EVENTS.includes(row.payload?.type)
          || row?.type === 'world_state' && keys(row.payload, ['full', 'state']) && object(row.payload.state);
        if (!state || [row.payload.thread_id, row.payload.threadId].some(id => id != null && id !== threadId)
          || references(row, selectedIds))
          fail('empty turn has semantic or ambiguous trailing records.');
        exactRow(index);
      }
      segments.set(turn.id, lines.slice(start, completionIndex + 1));
    }
    for (let index = 1; index < rows.length; index++)
      if (!allowed.has(index) && references(rows[index], selectedIds)) fail('empty turn has duplicate or late same-turn records.');
    return {
      turnIds: selected.map(turn => turn.id),
      sourceIdentity: Object.fromEntries(['dev', 'ino', 'uid', 'mode', 'nlink'].map(key => [key, data.fileIdentity[key]])),
      evidenceDigest: hash(JSON.stringify([lines[0], ...selected.map(turn => [turn.id, ...segments.get(turn.id)])])),
    };
  };
}
