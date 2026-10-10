import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { hash, snapshot } from './storage.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const IDENTITY = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink'];
const START_FIELDS = ['type', 'turn_id', 'root_turn_id', 'started_at', 'model_context_window', 'collaboration_mode_kind'];
const COMPLETE_FIELDS = ['type', 'turn_id', 'last_agent_message', 'started_at', 'completed_at', 'duration_ms'];
const WORLD_FIELDS = ['agents_md', 'apps_instructions', 'collaboration_mode', 'context_window_guidance', 'environments',
  'environments_instructions', 'git_attribution', 'host_skills', 'managed_developer_instructions', 'model',
  'multi_agent_mode', 'multi_agent_usage_hint', 'permissions', 'persistent_mode', 'plugins_instructions', 'realtime', 'skills'];
const CONTEXT_KINDS = {
  'generic.developer_instructions': ['developer', '<app-context>', null],
  'memories.instructions': ['developer', '## Memory\n', null],
  'host_skills.instructions': ['developer', '<skills_instructions>', '</skills_instructions>'],
  'permissions.instructions': ['developer', '<permissions instructions>', '</permissions instructions>'],
  'collaboration_mode.instructions': ['developer', '<collaboration_mode>', '</collaboration_mode>'],
  'plugins.recommendations': ['developer', '<recommended_plugins>', '</recommended_plugins>'],
  'multi_agent.role_instructions': ['developer', '<multi_agent_role>', '</multi_agent_role>'],
  'multi_agent.mode_instructions': ['developer', '<multi_agent_mode>', '</multi_agent_mode>'],
  'additional_content.codex_apps_client_time_context': ['developer', '<codex_apps_client_time_context>', '</codex_apps_client_time_context>'],
  'additional_content.codex_apps_open_page_instructions': ['developer', '<codex_apps_open_page_instructions>', '</codex_apps_open_page_instructions>'],
  'agents_md.instructions': ['user', '# AGENTS.md instructions for ', '</INSTRUCTIONS>'],
  'environments.environment_context': ['user', '<environment_context>', '</environment_context>'],
  'additional_content.codex_apps_open_page': ['user', '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>', null],
};
// Codex 0.162 repeats the start identity in a turn_attribution record and the
// root turn in the completion. The trigger names where the user submitted it:
// the Desktop composer or, as observed, the iOS remote. Any other trigger and
// every agent-initiated start stay refused.
const USER_TRIGGERS = ['composer', 'remote_ios'];
const startFields = started => Object.keys(started).every(key => START_FIELDS.includes(key) || key === 'turn_attribution')
  && (started.turn_attribution === undefined
    || keys(started.turn_attribution, ['turn_id', 'turn_trigger', 'parent_turn_id', 'initiating_agent_path', 'root_turn_id'])
      && started.turn_attribution.turn_id === started.turn_id && started.turn_attribution.root_turn_id === started.root_turn_id
      && USER_TRIGGERS.includes(started.turn_attribution.turn_trigger) && started.turn_attribution.parent_turn_id === null
      && started.turn_attribution.initiating_agent_path === null);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).length === names.length
  && Object.keys(value).every(key => names.includes(key));
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const fail = message => { throw new Error(`Native Codex empty turn: ${message}`); };
const candidate = turn => object(turn) && turn.status === 'completed' && turn.error === null
  && turn.itemsView === 'full' && Array.isArray(turn.items) && turn.items.length === 0;

function resumeContextDelta(state, cwd, seenKinds) {
  if (!keys(state, ['agents_md', 'environments', 'permissions'])) return false;
  const agents = state.agents_md, environments = state.environments, permissions = state.permissions;
  if (!keys(agents, ['directory', 'text']) || agents.directory !== cwd
    || typeof agents.text !== 'string' || !agents.text.length
    || !keys(environments, ['environments', 'filesystem']) || !keys(environments.environments, ['local'])
    || !keys(environments.environments.local, ['cwd', 'status', 'shell'])
    || environments.environments.local.cwd !== cwd || environments.environments.local.status !== 'available'
    || typeof environments.environments.local.shell !== 'string' || !environments.environments.local.shell.trim()
    || typeof environments.filesystem !== 'string' || !environments.filesystem.startsWith('<filesystem>')
    || !environments.filesystem.endsWith('</filesystem>')
    || !keys(permissions, ['instructions']) || typeof permissions.instructions !== 'string'
    || !/^[a-f0-9]{40}$/.test(permissions.instructions)) return false;
  return seenKinds.get('agents_md.instructions') === `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>\nThese AGENTS.md instructions replace all previously provided AGENTS.md instructions.\n\n${agents.text}\n</INSTRUCTIONS>`
    && seenKinds.has('permissions.instructions')
    && seenKinds.get('environments.environment_context')?.includes(environments.filesystem) === true;
}

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
    const rule = typeof kind === 'string' && Object.hasOwn(CONTEXT_KINDS, kind) ? CONTEXT_KINDS[kind] : null;
    if (!rule || rule[0] !== payload.role || seenKinds.has(kind)
      || kind.startsWith('additional_content.') !== afterContext
      || !keys(block, ['type', 'text']) || block.type !== 'input_text' || typeof block.text !== 'string'
      || !block.text.startsWith(rule[1]) || (rule[2] && !block.text.endsWith(rule[2]))
      || (kind === 'additional_content.codex_apps_open_page' && block.text !== rule[1]))
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
      if (!startFields(started)
        || started.root_turn_id !== turn.id || started.started_at !== turn.startedAt)
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
          if (context || row.payload?.turn_id !== turn.id || row.payload.root_turn_id !== turn.id || row.payload.cwd !== cwd)
            fail('empty turn context differs from the API.');
          context = row;
        } else if (row?.type === 'world_state') {
          const full = row.payload?.full === true && keys(row.payload.state, WORLD_FIELDS);
          // A loaded Desktop chat can refresh just its native environments
          // before the next prompt is blocked. This observed delta is context,
          // not a user/model message; unknown delta fields remain refused.
          const environmentDelta = row.payload?.full === false && keys(row.payload.state, ['environments']);
          // Desktop resume may replace project instructions, permissions and
          // its local environment together. Match the observed nested schema
          // and the preceding typed context rather than accepting arbitrary deltas.
          const resumeDelta = row.payload?.full === false && resumeContextDelta(row.payload.state, cwd, seenKinds);
          if (context || world || !keys(row.payload, ['full', 'state']) || !full && !environmentDelta && !resumeDelta)
            fail('empty turn has unrecognized native world state.');
          world = true;
        } else if (row?.type === 'response_item') {
          if (world && !context) fail('empty turn context ordering is ambiguous.');
          nativeContextMessage(row.payload, turn, context !== null, seenMessages, seenKinds);
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
        for (const field of ['turnId', 'root_turn_id', 'rootTurnId'])
          if (payload[field] != null && payload[field] !== turn.id) fail('empty turn has contradictory turn identity.');
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
        if (row?.type !== 'event_msg' || row.payload?.type !== 'thread_settings_applied'
          || row.payload.thread_id !== threadId || references(row, selectedIds))
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
