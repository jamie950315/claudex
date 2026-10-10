import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { hash, snapshot } from './storage.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const IDENTITY = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink'];
// By user decision this proof names what shows that a turn did something and
// accepts everything else. The API already reports the turn as completed with
// no items; the rollout is read to catch activity the API did not report, not
// to recognize every record a release may add. Unknown records, fields,
// context kinds, state and triggers are context, never a reason to refuse.
const ACTIVITY_ROWS = ['token_usage_record', 'compacted', 'inter_agent_communication_metadata', 'realtime_item'];
const ACTIVITY_EVENT = /^(?:token_count|item_|agent_|exec_|mcp_|patch_|web_search|user_message|turn_aborted|error|stream_error|task_)/;
// Runtime context in the user role, from runtimes that did not label kinds.
const FRAMED = /^(?:<[a-z_]+[ >]|# AGENTS\.md instructions for )/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const fail = message => { throw new Error(`Native Codex empty turn: ${message}`); };
const candidate = turn => object(turn) && turn.status === 'completed' && turn.error === null
  && turn.itemsView === 'full' && Array.isArray(turn.items) && turn.items.length === 0;

function activity(row) {
  if (!object(row) || !object(row.payload)) return true;
  const payload = row.payload;
  if (ACTIVITY_ROWS.includes(row.type)) return true;
  if (row.type === 'event_msg') return typeof payload.type !== 'string' || ACTIVITY_EVENT.test(payload.type);
  if (row.type !== 'response_item') return false;
  // A reply, reasoning, a tool call or its output.
  if (payload.type !== 'message' || !['developer', 'user'].includes(payload.role)) return true;
  // The runtime writes the developer role; the user never does.
  if (payload.role === 'developer') return false;
  // Authored input is labeled user.text, user.image and the like. Any other
  // user-role kind is context the runtime injected.
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (Array.isArray(kinds)) return kinds.some(kind => typeof kind !== 'string' || kind.startsWith('user.'));
  return !Array.isArray(payload.content) || payload.content.some(block => block?.type !== 'input_text'
    || typeof block.text !== 'string' || !FRAMED.test(block.text));
}

// References outside a candidate's exact segment must not introduce late output,
// repeated boundaries or nested items belonging to that candidate.
function references(value, ids) {
  if (!object(value) && !Array.isArray(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    ['turn_id', 'turnId', 'root_turn_id', 'rootTurnId'].includes(key) && ids.has(child)
  ) || references(child, ids));
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
      // Older runtimes record no root; a turn is then its own.
      const root = started.root_turn_id ?? turn.id, attribution = started.turn_attribution;
      if (selectedIds.has(root) && root !== turn.id || started.started_at != null && started.started_at !== turn.startedAt
        || object(attribution) && (attribution.turn_id != null && attribution.turn_id !== turn.id
          || attribution.root_turn_id != null && attribution.root_turn_id !== root))
        fail('empty turn start differs from the API.');
      let completed = null, completionIndex = -1;
      for (let index = start + 1; index < stop; index++) {
        const row = rows[index];
        if (row?.type === 'event_msg' && row.payload?.type === 'task_complete') {
          completed = row; completionIndex = index; break;
        }
        if (row?.type === 'turn_context') {
          if (row.payload?.turn_id !== turn.id || row.payload.cwd !== cwd) fail('empty turn context differs from the API.');
        } else if (activity(row)) fail('empty turn has model, tool or authored-input records.');
        else {
          const owner = row.payload.internal_chat_message_metadata_passthrough?.turn_id ?? row.payload.turn_id;
          if (owner != null && owner !== turn.id) fail('empty turn has contradictory turn identity.');
        }
      }
      const done = completed?.payload;
      if (!done || done.turn_id !== turn.id || done.last_agent_message != null || done.error != null
        || done.started_at != null && done.started_at !== turn.startedAt
        || done.completed_at != null && done.completed_at !== turn.completedAt
        || done.duration_ms != null && done.duration_ms !== turn.durationMs)
        fail('empty turn completion differs from the API.');
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
      // Records after the completion belong to the thread or to other turns.
      // Anything naming this turn is refused below, wherever it is.
      segments.set(turn.id, lines.slice(start, completionIndex + 1));
    }
    for (let index = 1; index < rows.length; index++) {
      if (allowed.has(index)) continue;
      // A second identity key hidden behind the parsed one must not escape.
      if (selected.some(turn => lines[index].includes(turn.id))) exactRow(index);
      if (references(rows[index], selectedIds)) fail('empty turn has duplicate or late same-turn records.');
    }
    return {
      turnIds: selected.map(turn => turn.id),
      sourceIdentity: Object.fromEntries(['dev', 'ino', 'uid', 'mode', 'nlink'].map(key => [key, data.fileIdentity[key]])),
      evidenceDigest: hash(JSON.stringify([lines[0], ...selected.map(turn => [turn.id, ...segments.get(turn.id)])])),
    };
  };
}
