import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { nativeItemDigest } from './native-history-order.mjs';
import { resolveRolloutHistoryBase } from './native-local-images.mjs';
import { decompressRollout, isCompressedRollout, physicalRolloutPath, recordedDirectories } from './codex-rollout-file.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const IDENTITY = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink'];
const START_REQUIRED = ['type', 'turn_id', 'started_at', 'model_context_window', 'collaboration_mode_kind'];
const STOP_REQUIRED = ['type', 'turn_id', 'started_at', 'completed_at', 'duration_ms', 'last_agent_message'];
const ABORT_FIELDS = ['type', 'turn_id', 'reason', 'started_at', 'completed_at', 'duration_ms'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).sort().join(',') === [...names].sort().join(',');
// By user decision a proof names the fields it uses; a field a release adds
// is ignored, never a reason to refuse.
const needs = (value, required) => object(value) && required.every(key => Object.hasOwn(value, key));
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

// A command may run outside the thread's working directory; the full API
// reports the same directory as a plain path.
function commandDirectory(value) {
  try {
    const path = typeof value === 'string' && value.startsWith('file:///') ? fileURLToPath(value) : null;
    return path !== null && isAbsolute(path) && pathToFileURL(path).href === value ? path : null;
  } catch { return null; }
}

function projectCommand(item) {
  const cwd = commandDirectory(item?.cwd);
  if (cwd === null || !object(item) || item.type !== 'CommandExecution' || typeof item.id !== 'string' || !item.id
    || typeof item.source !== 'string' || !/^[a-z]+(?:_[a-z]+)*$/.test(item.source) || !['completed', 'failed'].includes(item.status)
    || !Array.isArray(item.command) || !item.command.length || !item.command.every(value => typeof value === 'string')
    || typeof item.process_id !== 'string' || !/^\d+$/.test(item.process_id)
    || !Number.isSafeInteger(item.exit_code) || !keys(item.duration, ['secs', 'nanos'])
    || !integer(item.duration.secs) || !integer(item.duration.nanos) || item.duration.nanos >= 1e9
    || !Number.isSafeInteger(item.duration.secs * 1000 + Math.floor(item.duration.nanos / 1e6))
    // Output a second field would add, or separate error output, is not
    // representable in the single API field; absent copies are not a loss.
    || typeof item.aggregated_output !== 'string' || item.stdout !== undefined && item.stdout !== item.aggregated_output
    || item.stderr !== undefined && item.stderr !== ''
    || item.formatted_output !== undefined && item.formatted_output !== item.aggregated_output
    || !Array.isArray(item.parsed_cmd) || !item.parsed_cmd.length
    || item.parsed_cmd.some(action => !keys(action, ['type', 'cmd']) || action.type !== 'unknown' || typeof action.cmd !== 'string'))
    fail('late command has an unsupported or lossy native schema.');
  return { type: 'commandExecution', id: item.id, pluginId: null, scriptPath: null,
    command: item.command.map(nativeQuote).join(' '), cwd, processId: item.process_id,
    source: item.source.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), status: item.status,
    commandActions: item.parsed_cmd.map(action => ({ type: 'unknown', command: action.cmd })),
    aggregatedOutput: item.aggregated_output, exitCode: item.exit_code,
    durationMs: item.duration.secs * 1000 + Math.floor(item.duration.nanos / 1e6) };
}

// A sub-agent notification is recorded on the turn that spawned the agent,
// whenever it arrives; the API reports the same fields in camel case.
function projectSubAgent(item) {
  if (!object(item) || typeof item.id !== 'string' || !item.id || typeof item.kind !== 'string' || !item.kind
    || typeof item.agent_thread_id !== 'string' || !item.agent_thread_id || typeof item.agent_path !== 'string')
    fail('late sub-agent activity has an unsupported native schema.');
  return { type: 'subAgentActivity', id: item.id, kind: item.kind, agentThreadId: item.agent_thread_id, agentPath: item.agent_path };
}

async function readSource(logicalPath, maxBytes) {
  if (await realpath(dirname(logicalPath)) !== dirname(logicalPath)) fail('source parent is not canonical.');
  const path = await physicalRolloutPath(logicalPath), compressed = isCompressedRollout(path);
  const named = await lstat(path, { bigint: true });
  // Another reader (a usage cache) may hard-link the rollout; the stable read
  // below proves the exact inode, so an extra link is not a refusal.
  if (!named.isFile() || named.uid !== BigInt(process.getuid())
    || (named.mode & 0o022n) !== 0n || named.size > BigInt(maxBytes)) fail('source must be an owned, bounded regular file without group or world write access.');
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
    const stored = buffer.subarray(0, length);
    const bytes = compressed ? decompressRollout(stored, maxBytes) : stored;
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
  if (!needs(row, ['timestamp', 'ordinal', 'type', 'payload']) || !Number.isFinite(time(row))
    || JSON.stringify(row) !== line) fail('native proof frame is incomplete or has ambiguous serialization.');
}

// A closed native turn is completed (with or without a final reply: a
// compaction-only turn has none), failed with its error, or interrupted.
// Only the fields this proof relies on are compared; native adds metadata to
// context rows between versions, and none of it orders a late command.
function boundaryProof(state, api, source, directories, { ranCommand = false } = {}) {
  const stopped = state?.stop?.payload;
  const status = stopped?.type === 'turn_aborted' ? 'interrupted' : stopped?.error === undefined ? 'completed' : 'failed';
  if (!api || api.status !== status || (api.error != null) !== (status === 'failed') || api.itemsView !== 'full'
    || !integer(api.startedAt) || !integer(api.completedAt) || api.completedAt < api.startedAt
    || !state?.start || !state.stop || ranCommand && !state.contexts.length)
    fail('late command lacks a unique closed native boundary.');
  const { start, stop } = state;
  for (const row of [start, stop, ...state.contexts]) exactFrame(row, source.lines[row.ordinal]);
  if (!needs(start.payload, START_REQUIRED)
    || !needs(stop.payload, status === 'interrupted' ? ['type', 'turn_id', 'reason'] : STOP_REQUIRED)
    || start.payload.turn_id !== api.id || ![start.payload, stop.payload, ...state.contexts.map(context => context.payload)]
      .every(payload => object(payload) && (payload.root_turn_id === undefined || payload.root_turn_id === api.id))
    // A time the runtime did not record is not a contradiction; the record
    // timestamps below still bind both ends to the API.
    || [start.payload.started_at, stop.payload.started_at].some(value => value !== undefined && value !== api.startedAt)
    || stop.payload.completed_at !== undefined && stop.payload.completed_at !== api.completedAt
    || Math.floor(time(start) / 1000) !== api.startedAt || Math.floor(time(stop) / 1000) !== api.completedAt
    || stop.payload.duration_ms !== undefined && !integer(stop.payload.duration_ms) || stop.payload.time_to_first_token_ms !== undefined && !integer(stop.payload.time_to_first_token_ms)
    || state.contexts.some(context => !directories.has(context.payload.cwd) || context.ordinal <= start.ordinal || context.ordinal >= stop.ordinal
      || time(context) < time(start) || time(context) > time(stop))) fail('native boundary or context differs from the full API.');
  if (status !== 'completed') return;
  const lastUser = api.items.findLastIndex(item => item.type === 'userMessage');
  const lastAgent = api.items.findLastIndex(item => item.type === 'agentMessage');
  const reply = stop.payload.last_agent_message;
  if (reply === null ? api.items.some((item, index) => index > lastUser && item.type === 'agentMessage' && item.phase !== 'commentary')
    : lastAgent <= lastUser || lastAgent < 0 || api.items[lastAgent].phase === 'commentary'
      || typeof api.items[lastAgent].text !== 'string' || !api.items[lastAgent].text.trim()
      || reply !== api.items[lastAgent].text) fail('native boundary lacks its exact final assistant response.');
}

// A rollover continues the same thread in a new segment whose header names
// the previous one and the row prefix it inherits. The inherited rows are
// read through the same stable reader and joined by their contiguous native
// ordinals, so a boundary and its late completion may lie in different
// segments. A fork inherits another thread's rows and is not joined.
async function readHistory(path, threadId, locateRollout, maxBytes) {
  const current = await readSource(path, maxBytes), base = current.rows[0]?.payload?.history_base;
  if (base == null) return { ...current, starts: new Set([0]) };
  if (typeof locateRollout !== 'function') fail('source continues an earlier rollout that this reader was not given.');
  let chain;
  try { chain = await resolveRolloutHistoryBase({ path, threadId, locate: locateRollout }); }
  catch (error) { fail(`earlier rollout is not proven: ${error.message}`); }
  const rows = [], lines = [], digests = [], starts = new Set();
  let budget = maxBytes - Buffer.byteLength(current.lines.join('\n'));
  for (const link of chain.toReversed()) {
    if (link.threadId !== threadId) fail('source inherits a forked history; its late commands are not placed.');
    if (budget < 1) fail('combined rollout sources exceed their byte limit.');
    const segment = await readSource(link.path, budget), count = link.prefix.endOrdinal - link.prefix.startOrdinal;
    if (rows.length !== link.prefix.startOrdinal || segment.rows.length < count) fail('earlier rollout does not cover its referenced rows.');
    // Observed offsets can land a few bytes inside an adjacent row.
    let bytes = 0;
    for (let index = 0; index < count - 1; index++) bytes += Buffer.byteLength(segment.lines[index]) + 1;
    const last = Buffer.byteLength(segment.lines[count - 1]) + 1;
    const next = segment.lines[count] === undefined ? 0 : Buffer.byteLength(segment.lines[count]) + 1;
    if (link.prefix.endByte <= bytes || link.prefix.endByte > bytes + last + next) fail('earlier rollout byte offset does not match its row boundary.');
    budget -= bytes + last; starts.add(rows.length);
    rows.push(...segment.rows.slice(0, count)); lines.push(...segment.lines.slice(0, count));
    digests.push({ sourceDigest: segment.sourceDigest, sourceIdentity: segment.sourceIdentity, ...link.prefix });
  }
  if (rows.length !== current.rows[0].ordinal) fail('source does not continue its earlier rollout.');
  starts.add(rows.length);
  return { rows: [...rows, ...current.rows], lines: [...lines, ...current.lines], starts, sourceIdentity: current.sourceIdentity,
    sourceDigest: nativeItemDigest({ sourceDigest: current.sourceDigest, inherited: digests }) };
}

/** Prove append arrival for completed commands and sub-agent notifications
 * backfilled into a closed turn.
 * Native turns and items stay intact; the caller uses placements only for the
 * portable order and still verifies the whole saved canonical checkpoint.
 */
export function createNativeLateItemResolver({ path, threadId, cwd, locateRollout, maxBytes = 480 * 1024 * 1024 }) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || !UUID.test(threadId)
    || typeof cwd !== 'string' || !isAbsolute(cwd) || resolve(cwd) !== cwd
    || !integer(maxBytes) || maxBytes < 1 || maxBytes > 480 * 1024 * 1024) fail('invalid source identity or byte limit.');
  return async (snapshot, { threadId: expectedThreadId }) => {
    if (expectedThreadId !== threadId || !Array.isArray(snapshot?.turns)) fail('source and API identities differ.');
    if (!snapshot.turns.some(turn => turn.items?.some(item => ['commandExecution', 'subAgentActivity'].includes(item.type)))) return null;
    const source = await readHistory(path, threadId, locateRollout, maxBytes), { rows } = source;
    const states = new Map(), seenItems = new Map(), candidates = [], closed = [];
    let active = null, latest = null, lifecycleError = false;
    for (const row of rows) {
      const payload = row?.payload;
      if (row?.type === 'event_msg' && payload?.type === 'task_started') {
        if (!UUID.test(payload.turn_id) || states.has(payload.turn_id)) { lifecycleError = true; continue; }
        // A runtime that stops mid-turn writes no closing record, so the next
        // start follows a turn that is still open. That turn stays open: it
        // is never a boundary, and a later record closing it is an overlap.
        states.set(payload.turn_id, { start: row, stop: null, contexts: [] }); active = payload.turn_id;
      } else if (row?.type === 'turn_context') {
        states.get(payload?.turn_id)?.contexts.push(row);
      } else if (row?.type === 'event_msg' && (payload?.type === 'task_complete'
        || payload?.type === 'turn_aborted' && payload.reason === 'interrupted')) {
        const state = states.get(payload.turn_id);
        if (active !== payload.turn_id || !state || state.stop) { lifecycleError = true; continue; }
        state.stop = row; active = null; latest = payload.turn_id; closed.push(payload.turn_id);
      } else if (row?.type === 'event_msg' && ['item_started', 'item_completed'].includes(payload?.type)) {
        const id = payload.item?.id, prior = seenItems.get(id) ?? [];
        if (payload.type === 'item_completed' && (states.get(payload.turn_id)?.stop
          || latest !== null && active !== payload.turn_id))
          candidates.push({ row, active, latest, closed: closed.length, prior: prior.length });
        prior.push(row); seenItems.set(id, prior);
      }
    }
    if (!candidates.length) return null;
    if (lifecycleError) fail('native lifecycle has an invalid, repeated or unmatched boundary.');
    // Every segment opens with the header of this exact thread; no other
    // row is one.
    for (const index of source.starts) exactFrame(rows[index], source.lines[index]);
    const directories = await recordedDirectories(rows, cwd);
    if (rows.some((row, index) => row?.ordinal !== index || (row.type === 'session_meta') !== source.starts.has(index)
      || source.starts.has(index) && (!object(row.payload) || row.payload.id !== threadId || !directories.has(row.payload.cwd)
        || row.payload.history_mode !== 'paginated' || row.payload.session_id !== threadId)))
      fail('source header or ordinal chain differs from the exact native identity.');
    const turns = new Map();
    for (const [index, turn] of snapshot.turns.entries()) {
      if (!UUID.test(turn?.id) || turns.has(turn.id) || !Array.isArray(turn.items)) fail('API turn identity is ambiguous.');
      turns.set(turn.id, { turn, index });
    }
    // Turns proven empty are never exported, so they cannot be a boundary.
    const empty = new Set((snapshot.emptyTurnEvidence ?? []).flatMap(entry => entry.proof.turnIds));
    const exportedEnd = states.get(snapshot.turns.at(-1)?.id)?.stop?.ordinal;
    const placements = [], withheld = [], selected = new Set(); let previousBoundary = -1;
    for (const candidate of candidates) {
      const { row, active: activeAtArrival, latest, prior } = candidate, payload = row.payload;
      exactFrame(row, source.lines[row.ordinal]);
      const parent = turns.get(payload.turn_id), state = states.get(payload.turn_id), newest = states.get(latest);
      // A closed turn the API does not export yet lies after everything it
      // does; its late items are proven when that turn is exported.
      if (!parent && state?.stop && Number.isSafeInteger(exportedEnd) && state.start.ordinal > exportedEnd) continue;
      const subAgent = payload.item?.type === 'SubAgentActivity';
      let position = candidate.closed;
      while (position > 1 && empty.has(closed[position - 1])) position--;
      const afterTurnId = closed[position - 1], boundary = states.get(afterTurnId), after = turns.get(afterTurnId);
      // The command may finish while a later turn is running. That turn is
      // still open at this row, so the newest closed turn remains the boundary.
      const running = activeAtArrival === null ? null : states.get(activeAtArrival);
      if (prior || !parent || !state?.stop || !newest?.stop || !boundary?.stop || boundary.stop.ordinal < state.stop.ordinal
        || boundary.stop.ordinal < previousBoundary || row.ordinal <= state.stop.ordinal
        // A boundary the API does not export yet lies after everything it does.
        || !after && !(Number.isSafeInteger(exportedEnd) && boundary.start.ordinal > exportedEnd)
        || activeAtArrival !== null && (!running || running.stop && running.stop.ordinal <= row.ordinal
          || activeAtArrival === payload.turn_id || running.start.ordinal <= newest.stop.ordinal || running.start.ordinal >= row.ordinal)
        // Earlier native versions record no start time for the command.
        || !needs(payload, ['type', 'thread_id', 'turn_id', 'item', 'completed_at_ms'])
        || payload.thread_id !== threadId || !integer(payload.completed_at_ms)
        // A command starts inside its turn; a notification has no duration.
        || payload.started_at_ms !== undefined && (!integer(payload.started_at_ms)
          || (subAgent ? payload.started_at_ms > payload.completed_at_ms
            : payload.started_at_ms < time(state.start) || payload.started_at_ms > time(state.stop)))
        // The row is written at or after the completion it records; its
        // position in the file, not its clock, is the arrival evidence.
        || payload.completed_at_ms > time(row) || payload.completed_at_ms <= time(state.stop)
        || payload.completed_at_ms < time(newest.stop)) fail('late arrival has an ambiguous identity, active turn or completion order.');
      if (running) exactFrame(running.start, source.lines[running.start.ordinal]);
      // Everything from the running turn's start belongs to that open turn.
      // Its start may follow the settings events native writes on submission.
      const idleEnd = running ? running.start.ordinal : row.ordinal;
      const gap = rows.slice(newest.stop.ordinal + 1, idleEnd);
      let settled = gap.length;
      while (running && settled && gap[settled - 1].type === 'event_msg' && gap[settled - 1].payload?.type === 'thread_settings_applied') settled--;
      if (gap.slice(0, settled).some(entry => entry.type !== 'event_msg' || entry.payload?.type !== 'item_completed'
        || !['CommandExecution', 'SubAgentActivity'].includes(entry.payload.item?.type)))
        fail('late arrival is separated from its closed boundary by unrecognized native activity.');
      boundaryProof(state, parent.turn, source, directories, { ranCommand: true });
      if (after) boundaryProof(boundary, after.turn, source, directories);
      const projected = subAgent ? projectSubAgent(payload.item) : projectCommand(payload.item);
      const matches = parent.turn.items.filter(item => item.id === projected.id);
      // The full API reports a command without output as null.
      if (projected.aggregatedOutput === '' && matches[0]?.aggregatedOutput === null) projected.aggregatedOutput = null;
      if (matches.length !== 1 || snapshot.turns.some(turn => turn.id !== parent.turn.id && turn.items.some(item => item.id === projected.id))
        || selected.has(projected.id) || !isDeepStrictEqual(projected, matches[0])) fail('complete native item differs from the full API item.');
      selected.add(projected.id); previousBoundary = boundary.stop.ordinal;
      (after ? placements : withheld).push({ turnId: parent.turn.id, itemId: projected.id, afterTurnId, itemDigest: nativeItemDigest(matches[0]) });
    }
    if (!placements.length && !withheld.length) return null;
    // An item whose boundary is not exported yet stays out of this export
    // and appears with that boundary; it never moves ahead of it.
    return { placements, ...(withheld.length ? { withheld } : {}), sourceIdentity: source.sourceIdentity,
      evidenceDigest: nativeItemDigest({ sourceDigest: source.sourceDigest, placements, ...(withheld.length ? { withheld } : {}) }) };
  };
}
