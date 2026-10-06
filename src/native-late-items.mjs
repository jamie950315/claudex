import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { nativeItemDigest } from './native-history-order.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const IDENTITY = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink'];
const HEADER_FIELDS = ['creator_user_id', 'creator_account_id', 'session_id', 'id', 'timestamp', 'cwd',
  'runtime_workspace_roots', 'originator', 'cli_version', 'source', 'thread_source', 'model_provider',
  'base_instructions', 'history_mode', 'context_window', 'git'];
const CONTEXT_FIELDS = ['active_permission_profile', 'approval_policy', 'approvals_reviewer', 'collaboration_mode',
  'comp_hash', 'current_date', 'cwd', 'disabled_plugin_ids', 'effort', 'model', 'multi_agent_version',
  'permission_profile', 'personality', 'realtime_active', 'root_turn_id', 'sandbox_policy', 'summary',
  'timezone', 'turn_id', 'workspace_roots'];
const START_FIELDS = ['type', 'turn_id', 'root_turn_id', 'started_at', 'model_context_window', 'collaboration_mode_kind'];
const STOP_FIELDS = ['type', 'turn_id', 'started_at', 'completed_at', 'duration_ms', 'last_agent_message', 'time_to_first_token_ms'];
const ITEM_FIELDS = ['type', 'id', 'command', 'cwd', 'process_id', 'source', 'status', 'parsed_cmd',
  'aggregated_output', 'stdout', 'stderr', 'formatted_output', 'exit_code', 'duration'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const only = (value, names) => object(value) && Object.keys(value).every(key => names.includes(key));
const identity = info => Object.fromEntries(IDENTITY.map(key => [key, String(info[key])]));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const time = row => {
  if (typeof row?.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.timestamp)) return NaN;
  const value = Date.parse(row.timestamp);
  return Number.isFinite(value) && new Date(value).toISOString() === row.timestamp ? value : NaN;
};
const fail = message => { throw new Error(`Native Codex late item: ${message}`); };

// Match native shlex::try_join, including its split single/double quote chunks.
// This formats historical data; it never parses or executes a shell command.
function nativeQuote(value) {
  if (typeof value !== 'string' || value.includes('\0')) fail('command argv is not losslessly representable.');
  if (!value) return "''";
  let rest = Array.from(value), output = '';
  while (rest.length) {
    let allowed = rest[0] === '^' ? 2 : 7, index = rest[0] === '^' ? 1 : 0;
    for (; index < rest.length; index++) {
      const char = rest[index]; let next = allowed;
      if (!/^[A-Za-z0-9+./:@\]_-]$/.test(char)) next &= ~1;
      if (['\'', '^', '\\'].includes(char)) next &= ~2;
      if (['`', '$', '!', '^'].includes(char)) next &= ~4;
      if (!next) break;
      allowed = next;
    }
    const chunk = rest.slice(0, index).join(''); rest = rest.slice(index);
    output += allowed & 1 ? chunk : allowed & 2 ? `'${chunk}'` : `"${chunk.replace(/[\$`"\\]/g, '\\$&')}"`;
  }
  return output;
}

function projectCommand(item, cwd) {
  if (!keys(item, ITEM_FIELDS) || item.type !== 'CommandExecution' || typeof item.id !== 'string' || !item.id
    || item.source !== 'unified_exec_startup' || !['completed', 'failed'].includes(item.status)
    || !Array.isArray(item.command) || !item.command.length || !item.command.every(value => typeof value === 'string')
    || item.cwd !== pathToFileURL(cwd).href || typeof item.process_id !== 'string' || !/^\d+$/.test(item.process_id)
    || !Number.isSafeInteger(item.exit_code) || !keys(item.duration, ['secs', 'nanos'])
    || !integer(item.duration.secs) || !integer(item.duration.nanos) || item.duration.nanos >= 1e9
    || !Number.isSafeInteger(item.duration.secs * 1000 + Math.floor(item.duration.nanos / 1e6))
    || typeof item.aggregated_output !== 'string' || item.stdout !== item.aggregated_output
    || item.stderr !== '' || item.formatted_output !== item.aggregated_output
    || !Array.isArray(item.parsed_cmd) || !item.parsed_cmd.length
    || item.parsed_cmd.some(action => !keys(action, ['type', 'cmd']) || action.type !== 'unknown' || typeof action.cmd !== 'string'))
    fail('late command has an unsupported or lossy native schema.');
  return { type: 'commandExecution', id: item.id, pluginId: null, scriptPath: null,
    command: item.command.map(nativeQuote).join(' '), cwd, processId: item.process_id,
    source: 'unifiedExecStartup', status: item.status,
    commandActions: item.parsed_cmd.map(action => ({ type: 'unknown', command: action.cmd })),
    aggregatedOutput: item.aggregated_output, exitCode: item.exit_code,
    durationMs: item.duration.secs * 1000 + Math.floor(item.duration.nanos / 1e6) };
}

async function readSource(path, maxBytes) {
  if (await realpath(dirname(path)) !== dirname(path)) fail('source parent is not canonical.');
  const named = await lstat(path, { bigint: true });
  if (!named.isFile() || named.uid !== BigInt(process.getuid()) || named.nlink !== 1n
    || (named.mode & 0o077n) !== 0n || named.size > BigInt(maxBytes)) fail('source must be a private, owned, single-link bounded regular file.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || !isDeepStrictEqual(identity(named), identity(before))) fail('source changed before its stable read.');
    // A native writer may grow the file after the opened size check. Read at
    // most that size plus one byte, then reject any changed exact identity.
    const buffer = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.length > maxBytes || !isDeepStrictEqual(identity(before), identity(await file.stat({ bigint: true })))
      || !isDeepStrictEqual(identity(before), identity(await lstat(path, { bigint: true })))
      || await realpath(dirname(path)) !== dirname(path)) fail('source changed during its stable read.');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes) || !text.endsWith('\n')) fail('source has invalid encoding or an incomplete final record.');
    const lines = text.slice(0, -1).split('\n');
    let rows;
    try { rows = lines.map(line => JSON.parse(line)); } catch { fail('source has malformed JSON records.'); }
    return { rows, lines, sourceIdentity: identity(before), sourceDigest: nativeItemDigest(text) };
  } finally { await file.close(); }
}

function exactFrame(row, line) {
  if (!keys(row, ['timestamp', 'ordinal', 'type', 'payload']) || !Number.isFinite(time(row))
    || JSON.stringify(row) !== line) fail('native proof frame has unknown fields or ambiguous serialization.');
}

function boundaryProof(state, api, source, cwd) {
  if (!api || api.status !== 'completed' || api.error != null || api.itemsView !== 'full'
    || !integer(api.startedAt) || !integer(api.completedAt) || api.completedAt < api.startedAt
    || !state?.start || !state.stop || state.contexts.length !== 1) fail('late command lacks a unique completed native boundary.');
  const { start, stop } = state, context = state.contexts[0];
  for (const row of [start, stop, context]) exactFrame(row, source.lines[row.ordinal]);
  if (!keys(start.payload, START_FIELDS) || !keys(stop.payload, STOP_FIELDS)
    || start.payload.root_turn_id !== api.id || start.payload.started_at !== api.startedAt
    || stop.payload.started_at !== api.startedAt || stop.payload.completed_at !== api.completedAt
    || Math.floor(time(start) / 1000) !== api.startedAt || Math.floor(time(stop) / 1000) !== api.completedAt
    || !integer(stop.payload.duration_ms) || !integer(stop.payload.time_to_first_token_ms)
    || !only(context.payload, CONTEXT_FIELDS) || context.payload.root_turn_id !== api.id
    || context.payload.cwd !== cwd || context.ordinal <= start.ordinal || context.ordinal >= stop.ordinal
    || time(context) < time(start) || time(context) > time(stop)) fail('native boundary or context differs from the full API.');
  const lastUser = api.items.findLastIndex(item => item.type === 'userMessage');
  const lastAgent = api.items.findLastIndex(item => item.type === 'agentMessage');
  if (lastAgent <= lastUser || lastAgent < 0 || api.items[lastAgent].phase === 'commentary'
    || typeof api.items[lastAgent].text !== 'string' || !api.items[lastAgent].text.trim()
    || stop.payload.last_agent_message !== api.items[lastAgent].text) fail('native boundary lacks its exact final assistant response.');
}

/** Prove append arrival for completed commands backfilled into a closed turn.
 * Native turns and items stay intact; the caller uses placements only for the
 * portable order and still verifies the whole saved canonical checkpoint.
 */
export function createNativeLateItemResolver({ path, threadId, cwd, maxBytes = 480 * 1024 * 1024 }) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || !UUID.test(threadId)
    || typeof cwd !== 'string' || !isAbsolute(cwd) || resolve(cwd) !== cwd
    || !integer(maxBytes) || maxBytes < 1 || maxBytes > 480 * 1024 * 1024) fail('invalid source identity or byte limit.');
  return async (snapshot, { threadId: expectedThreadId }) => {
    if (expectedThreadId !== threadId || !Array.isArray(snapshot?.turns)) fail('source and API identities differ.');
    if (!snapshot.turns.some(turn => turn.items?.some(item => item.type === 'commandExecution'))) return null;
    const source = await readSource(path, maxBytes), { rows } = source;
    const states = new Map(), seenItems = new Map(), candidates = [];
    let active = null, latest = null, lifecycleError = false;
    for (const row of rows) {
      const payload = row?.payload;
      if (row?.type === 'event_msg' && payload?.type === 'task_started') {
        if (!UUID.test(payload.turn_id) || active !== null || states.has(payload.turn_id)) {
          lifecycleError = true; continue;
        }
        states.set(payload.turn_id, { start: row, stop: null, contexts: [] }); active = payload.turn_id;
      } else if (row?.type === 'turn_context') {
        states.get(payload?.turn_id)?.contexts.push(row);
      } else if (row?.type === 'event_msg' && (payload?.type === 'task_complete'
        || payload?.type === 'turn_aborted' && payload.reason === 'interrupted')) {
        const state = states.get(payload.turn_id);
        if (active !== payload.turn_id || !state || state.stop) { lifecycleError = true; continue; }
        state.stop = row; active = null; latest = payload.turn_id;
      } else if (row?.type === 'event_msg' && ['item_started', 'item_completed'].includes(payload?.type)) {
        const id = payload.item?.id, prior = seenItems.get(id) ?? [];
        if (payload.type === 'item_completed' && (states.get(payload.turn_id)?.stop
          || latest !== null && active !== payload.turn_id))
          candidates.push({ row, active, afterTurnId: latest, prior: prior.length });
        prior.push(row); seenItems.set(id, prior);
      }
    }
    if (!candidates.length) return null;
    if (lifecycleError) fail('native lifecycle has an invalid, repeated or unmatched boundary.');
    const header = rows[0]; exactFrame(header, source.lines[0]);
    if (header.type !== 'session_meta' || !only(header.payload, HEADER_FIELDS)
      || header.payload.id !== threadId || header.payload.cwd !== cwd || header.payload.history_mode !== 'paginated'
      || header.payload.session_id !== threadId || rows.slice(1).some(row => row?.type === 'session_meta')
      || rows.some((row, index) => row?.ordinal !== index)) fail('source header or ordinal chain differs from the exact native identity.');
    const turns = new Map();
    for (const [index, turn] of snapshot.turns.entries()) {
      if (!UUID.test(turn?.id) || turns.has(turn.id) || !Array.isArray(turn.items)) fail('API turn identity is ambiguous.');
      turns.set(turn.id, { turn, index });
    }
    const placements = [], selected = new Set(); let previousBoundary = -1;
    for (const candidate of candidates) {
      const { row, active: activeAtArrival, afterTurnId, prior } = candidate, payload = row.payload;
      exactFrame(row, source.lines[row.ordinal]);
      const parent = turns.get(payload.turn_id), after = turns.get(afterTurnId), state = states.get(payload.turn_id);
      if (activeAtArrival !== null || prior || !after || !parent || !state?.stop || after.index < parent.index
        || after.index < previousBoundary || row.ordinal <= state.stop.ordinal
        || !keys(payload, ['type', 'thread_id', 'turn_id', 'item', 'started_at_ms', 'completed_at_ms'])
        || payload.thread_id !== threadId || !integer(payload.started_at_ms) || !integer(payload.completed_at_ms)
        || payload.completed_at_ms !== time(row) || payload.started_at_ms < time(state.start)
        || payload.started_at_ms > time(state.stop) || payload.completed_at_ms <= time(state.stop)
        || payload.completed_at_ms < time(states.get(afterTurnId).stop)) fail('late arrival has an ambiguous identity, active turn or completion order.');
      if (rows.slice(states.get(afterTurnId).stop.ordinal + 1, row.ordinal).some(entry => entry.type !== 'event_msg'
        || entry.payload?.type !== 'item_completed' || entry.payload.item?.type !== 'CommandExecution'))
        fail('late arrival is separated from its closed boundary by unrecognized native activity.');
      boundaryProof(state, parent.turn, source, cwd); boundaryProof(states.get(afterTurnId), after.turn, source, cwd);
      const projected = projectCommand(payload.item, cwd), matches = parent.turn.items.filter(item => item.id === projected.id);
      if (matches.length !== 1 || snapshot.turns.some(turn => turn.id !== parent.turn.id && turn.items.some(item => item.id === projected.id))
        || selected.has(projected.id) || !isDeepStrictEqual(projected, matches[0])) fail('complete native command differs from the full API item.');
      selected.add(projected.id); previousBoundary = after.index;
      placements.push({ turnId: parent.turn.id, itemId: projected.id, afterTurnId, itemDigest: nativeItemDigest(matches[0]) });
    }
    return { placements, sourceIdentity: source.sourceIdentity,
      evidenceDigest: nativeItemDigest({ sourceDigest: source.sourceDigest, placements }) };
  };
}
