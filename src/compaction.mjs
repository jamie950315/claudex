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
  if (summaries.length !== 1 || summary.type !== 'user' || summary.parentUuid !== boundary.uuid) {
    throw new Error('Claude compaction requires one explicitly linked native summary.');
  }
  const content = summary.message?.content;
  const readable = typeof content === 'string' ? content : Array.isArray(content) && content.every(block => block.type === 'text' && typeof block.text === 'string') ? content.map(block => block.text).join('\n') : '';
  if (!readable.trim()) throw new Error('Claude compaction summary is missing or opaque.');
  if (tail.slice(0, tail.indexOf(summary)).some(row => row.type === 'user' || row.type === 'assistant')) throw new Error('Claude compaction summary order is ambiguous.');
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

/** Owned Desktop histories retain their authenticated earlier packets. A
 * native context compaction is not permission to discard that canonical prefix.
 * Only the observed full-history, explicitly linked summary form qualifies;
 * preserved-segment chains still require a separate supported contract.
 */
export function claudeCompactionHistory(text, rows, authenticatePreservedPacket) {
  const boundaries = rows.flatMap((row, index) => !row.isSidechain && row.type === 'system'
    && row.subtype === 'compact_boundary' ? [index] : []);
  if (!boundaries.length) return null;
  const summaries = new Map();
  let preservedAuthenticatedPackets = 0;
  for (let ordinal = 0; ordinal < boundaries.length; ordinal++) {
    const index = boundaries[ordinal];
    const { boundary, summary, readable } = claudeSummary(rows, index, boundaries[ordinal + 1], true);
    if (boundary.parentUuid !== null || typeof boundary.logicalParentUuid !== 'string' || !boundary.logicalParentUuid
      || !summary.uuid || summary.sessionId !== boundary.sessionId || summary.cwd !== boundary.cwd
      // An interactive /compact summary is not queued input, in a native
      // original or in an owned conversation the user compacts from Desktop.
      || summary.isVisibleInTranscriptOnly !== true
      || summary.queueTranscriptOnly !== true && summary.queueTranscriptOnly !== undefined)
      throw new Error('Owned Claude compaction lacks an exact native history link.');
    const interactive = summary.queueTranscriptOnly === undefined;
    if (boundary.compactMetadata?.preservedSegment || boundary.compactMetadata?.preservedMessages) {
      const segment = boundary.compactMetadata.preservedSegment, messages = boundary.compactMetadata.preservedMessages;
      const keys = (value, expected) => value && !Array.isArray(value) && typeof value === 'object'
        && Object.keys(value).sort().join(',') === expected;
      // A native original, and an owned history compacted interactively, keep
      // the complete earlier history, so a preserved segment only references
      // rows that already exist in that prefix: an exact, contiguous parent
      // chain ending at the boundary's logical parent and anchored to its
      // summary. Nothing is replayed or reordered.
      if (typeof authenticatePreservedPacket !== 'function' || interactive) {
        const uuids = messages?.uuids, all = messages?.allUuids;
        const chain = Array.isArray(uuids) ? uuids.map(uuid => rows.slice(0, index).filter(row => !row.isSidechain && row.uuid === uuid)) : [];
        if (!keys(segment, 'anchorUuid,headUuid,tailUuid') || !keys(messages, 'allUuids,anchorUuid,uuids')
          || !Array.isArray(uuids) || !uuids.length || uuids.length > 4096 || !Array.isArray(all) || all.length > 4096
          || new Set(uuids).size !== uuids.length || uuids.some(uuid => typeof uuid !== 'string' || !uuid)
          || uuids.some((uuid, n) => all.indexOf(uuid) < (n ? all.indexOf(uuids[n - 1]) + 1 : 0))
          || segment.headUuid !== uuids[0] || segment.tailUuid !== uuids.at(-1) || boundary.logicalParentUuid !== uuids.at(-1)
          || segment.anchorUuid !== summary.uuid || messages.anchorUuid !== summary.uuid
          || chain.some(found => found.length !== 1)
          || chain.some(([row], n) => n > 0 && row.parentUuid !== uuids[n - 1]))
          throw new Error('Claude compaction preserved-segment dependencies are unsupported; automatic handoff paused.');
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
    if (row.type === 'system' && row.subtype === 'compact_boundary'
      && (!previous || row.logicalParentUuid !== previous.uuid || row.sessionId !== previous.sessionId || row.cwd !== previous.cwd))
      throw new Error('Owned Claude compaction does not continue its complete persisted prefix.');
    known.set(row.uuid, row);
    previous = row;
  }
  return { rows: rows.map(row => summaries.get(row) ?? row),
    metadata: { ...boundaryMetadata(text, rows, boundaries.at(-1), 'claude'), retainedHistory: true,
      boundaries: boundaries.length, preservedAuthenticatedPackets } };
}
