import { isDeepStrictEqual } from 'node:util';
import { hash } from './storage.mjs';

export const summaryText = text => `[Imported native compaction summary; earlier verbatim history is not included.]\n${text}`;

export function boundaryMetadata(text, rows, index, source) {
  const lines = text.split('\n');
  let ordinal = 0;
  let offset = 0;
  for (const line of lines) {
    if (line && ordinal++ === index) break;
    offset += Buffer.byteLength(line + '\n');
  }
  return { id: hash({ source, offset, row: rows[index] }), offset, source };
}

export function provenance(text, record = {}, compaction) {
  const bytes = Buffer.from(text);
  return {
    rawHash: hash(text),
    prefixUnchanged: Number.isSafeInteger(record.bytes) && record.bytes >= 0 && record.bytes <= bytes.length
      && typeof record.rawHash === 'string' && hash(bytes.subarray(0, record.bytes).toString('utf8')) === record.rawHash,
    compactionId: compaction?.id ?? null,
    compactionOffset: compaction?.offset ?? null,
  };
}

/** Only explicit readable summaries qualify; ordinary retained messages do not. */
export function codexCompaction(text, rows) {
  const index = rows.findLastIndex(row => row.type === 'compacted');
  if (index < 0) return null;
  const boundary = rows[index];
  const message = boundary.payload?.message;
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('Opaque Codex compaction has no readable native summary; automatic handoff paused.');
  }
  // Replacement histories carry additional context with separate semantics. Do
  // not discard any such items or infer a summary from arbitrary retained text.
  if (boundary.payload.replacement_history?.length) throw new Error('Codex compaction replacement history is unsupported; automatic handoff paused.');
  const meta = rows.find(row => row.type === 'session_meta');
  const summary = { timestamp: boundary.timestamp, type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: summaryText(message) }],
  } };
  return { rows: [meta, summary, ...rows.slice(index + 1)], metadata: boundaryMetadata(text, rows, index, 'codex') };
}

function claudeSummary(rows, index, end = rows.length, allowPreservedMetadata = false) {
  const boundary = rows[index];
  if (!boundary.uuid) throw new Error('Claude compaction boundary identity is missing.');
  if (!allowPreservedMetadata && (boundary.compactMetadata?.preservedSegment || boundary.compactMetadata?.preservedMessages)) {
    throw new Error('Claude compaction preserved-segment dependencies are unsupported; automatic handoff paused.');
  }
  const tail = rows.slice(index + 1, end).filter(row => !row.isSidechain);
  const summaries = tail.filter(row => row.isCompactSummary);
  const summary = summaries[0];
  // With the earlier history retained, the summary is one more record of the
  // file: how native links, types or repeats it does not change what is kept.
  if (!summary || !allowPreservedMetadata && (summaries.length !== 1 || summary.type !== 'user' || summary.parentUuid !== boundary.uuid)) {
    throw new Error('Claude compaction requires one explicitly linked native summary.');
  }
  const content = summary.message?.content;
  const readable = typeof content === 'string' ? content : Array.isArray(content) && content.every(block => block.type === 'text' && typeof block.text === 'string') ? content.map(block => block.text).join('\n') : '';
  if (!readable.trim()) throw new Error('Claude compaction summary is missing or opaque.');
  if (!allowPreservedMetadata && tail.slice(0, tail.indexOf(summary)).some(row => row.type === 'user' || row.type === 'assistant')) throw new Error('Claude compaction summary order is ambiguous.');
  return { boundary, summary, readable, tail };
}

export function claudeCompaction(text, rows) {
  const index = rows.findLastIndex(row => !row.isSidechain && row.type === 'system' && row.subtype === 'compact_boundary');
  if (index < 0) return null;
  const { boundary, summary, readable, tail } = claudeSummary(rows, index);
  return {
    rows: [boundary, ...tail.map(row => row === summary ? { ...row, message: { ...row.message, content: summaryText(readable) } } : row)],
    metadata: boundaryMetadata(text, rows, index, 'claude'),
  };
}

// Fields native rewrites when it persists a row it already persisted: the
// relinked parent, the prompt and slug of the rewriting turn, the display copy
// of a tool result and the usage counters. Everything else must be equal.
const stable = ({ parentUuid, promptId, slug, toolUseResult, ...row }) => row.message && typeof row.message === 'object'
  ? { ...row, message: (({ usage, ...message }) => message)(row.message) } : row;

/** Claude Code 2.1.295 /compact was observed appending, before its new
 * boundary, a second copy of rows from an earlier generation: same uuid, type,
 * time and message. Such a copy says nothing new, so the first record stays
 * the history and the copy becomes an inert placeholder at its position (line
 * ordinals and native bytes are unchanged). A row that reuses an identity with
 * any other difference is not a copy and keeps failing as ambiguous. Only
 * native originals are read this way: an owned history holds bridge packets,
 * each delivered once, and keeps refusing every repeated identity.
 */
export function withoutRepersistedRows(rows) {
  const first = new Map();
  return rows.map(row => {
    if (row.isSidechain || typeof row.uuid !== 'string' || !row.uuid) return row;
    const known = first.get(row.uuid);
    if (!known) { first.set(row.uuid, row); return row; }
    return isDeepStrictEqual(stable(known), stable(row)) ? { type: 'claudex-repersisted-record' } : row;
  });
}

/** Owned Desktop histories retain their authenticated earlier packets. A
 * native context compaction is not permission to discard that canonical prefix.
 * Only the observed full-history, explicitly linked summary form qualifies;
 * preserved-segment chains still require a separate supported contract.
 */
export function claudeCompactionHistory(text, rows, authenticatePreservedPacket) {
  const boundaries = rows.flatMap((row, index) => !row.isSidechain && row.type === 'system'
    && row.subtype === 'compact_boundary' ? [index] : []);
  if (!boundaries.length) return null;
  const summaries = new Map(), exact = new Set();
  let preservedAuthenticatedPackets = 0;
  for (let ordinal = 0; ordinal < boundaries.length; ordinal++) {
    const index = boundaries[ordinal];
    const { boundary, summary, readable } = claudeSummary(rows, index, boundaries[ordinal + 1], true);
    // By user decision this names the real problems only. The complete
    // earlier history must still be in the file: the boundary names the row
    // it follows (checked below against the physical prefix) and the summary
    // belongs to the same session and directory. How native flags the summary
    // or describes the segment it preserved is its own bookkeeping.
    if (typeof boundary.logicalParentUuid !== 'string' || !boundary.logicalParentUuid
      || !summary.uuid || summary.sessionId !== boundary.sessionId || summary.cwd !== boundary.cwd)
      throw new Error('Owned Claude compaction lacks an exact native history link.');
    // A queued summary in an owned history is Claudex's own context reset; an
    // interactive /compact, in a native original or an owned conversation, is not.
    const interactive = summary.queueTranscriptOnly !== true;
    if (!interactive) exact.add(boundary);
    // Claudex's own reset is a write it must be able to prove exactly.
    if (!interactive && typeof authenticatePreservedPacket === 'function'
      && (boundary.parentUuid !== null || summary.type !== 'user' || summary.parentUuid !== boundary.uuid
        || summary.isVisibleInTranscriptOnly !== true
        || rows.slice(index + 1, boundaries[ordinal + 1]).filter(row => !row.isSidechain && row.isCompactSummary).length !== 1))
      throw new Error('Owned Claude compaction lacks an exact native history link.');
    if (boundary.compactMetadata?.preservedSegment || boundary.compactMetadata?.preservedMessages) {
      const segment = boundary.compactMetadata.preservedSegment, messages = boundary.compactMetadata.preservedMessages;
      const keys = (value, expected) => value && !Array.isArray(value) && typeof value === 'object'
        && Object.keys(value).sort().join(',') === expected;
      // A native original, and an owned history compacted interactively, keep
      // every earlier row, so a preserved segment only points at rows the
      // file already holds. Nothing is replayed or reordered; a row that
      // native wrote a second time is caught as a repeated identity below.
      if (typeof authenticatePreservedPacket !== 'function' || interactive) {
        summaries.set(summary, { ...summary, message: { ...summary.message,
          content: `[Imported native compaction summary; complete earlier verified history is retained.]\n${readable}` } });
        continue;
      }
      const id = messages?.uuids?.[0];
      const candidates = rows.slice(0, index).filter(row => !row.isSidechain && row.uuid === id);
      // Pinned native /compact can preserve its one trailing no-query packet.
      // This is an authenticated reference to an existing physical prefix row,
      // not a general preserved-segment loader or permission to replay a tail.
      if (!keys(segment, 'anchorUuid,headUuid,tailUuid') || !keys(messages, 'allUuids,anchorUuid,uuids')
        || !Array.isArray(messages.uuids) || messages.uuids.length !== 1
        || !Array.isArray(messages.allUuids) || messages.allUuids.length !== 1
        || typeof id !== 'string' || !id || messages.allUuids[0] !== id
        || segment.headUuid !== id || segment.tailUuid !== id || boundary.logicalParentUuid !== id
        || segment.anchorUuid !== summary.uuid || messages.anchorUuid !== summary.uuid || candidates.length !== 1
        || candidates[0].type !== 'user' || candidates[0].promptSource !== 'sdk' || candidates[0].queueTranscriptOnly !== true
        || candidates[0].isMeta === true || candidates[0].isSynthetic === true
        || typeof authenticatePreservedPacket !== 'function' || authenticatePreservedPacket(candidates[0], boundary, summary) !== true)
        throw new Error('Claude compaction preserved-segment dependencies are unsupported; automatic handoff paused.');
      preservedAuthenticatedPackets++;
    }
    summaries.set(summary, { ...summary, message: { ...summary.message,
      content: `[Imported native compaction summary; complete earlier verified history is retained.]\n${readable}` } });
  }
  const known = new Map();
  let previous;
  for (const row of rows) {
    if (row.isSidechain) continue;
    if (['user', 'assistant'].includes(row.type) && (typeof row.uuid !== 'string' || !row.uuid))
      throw new Error('Owned Claude compaction history is missing a native message identity.');
    if (!row.uuid) continue;
    if (typeof row.uuid !== 'string' || known.has(row.uuid)) throw new Error('Owned Claude compaction history has ambiguous native record identities.');
    if (row.parentUuid != null && !known.has(row.parentUuid)) throw new Error('Owned Claude compaction history has a missing or forward native parent.');
    // Earlier history is missing when nothing precedes the boundary, or when
    // the row it names is in the file but is not the last one. A named row
    // native never wrote to the file (observed after a completed turn, Claude
    // Code 2.1.295 /compact) is its own bookkeeping: every row it kept is
    // still before the boundary. Claudex's own reset names its exact row.
    if (row.type === 'system' && row.subtype === 'compact_boundary'
      && (!previous || row.sessionId !== previous.sessionId || row.cwd !== previous.cwd
        || row.logicalParentUuid !== previous.uuid && (exact.has(row) || known.has(row.logicalParentUuid))))
      throw new Error('Owned Claude compaction does not continue its complete persisted prefix.');
    known.set(row.uuid, row);
    previous = row;
  }
  return { rows: rows.map(row => summaries.get(row) ?? row),
    metadata: { ...boundaryMetadata(text, rows, boundaries.at(-1), 'claude'), retainedHistory: true,
      boundaries: boundaries.length, preservedAuthenticatedPackets } };
}
