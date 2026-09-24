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

export function claudeCompaction(text, rows) {
  const index = rows.findLastIndex(row => !row.isSidechain && row.type === 'system' && row.subtype === 'compact_boundary');
  if (index < 0) return null;
  const boundary = rows[index];
  if (!boundary.uuid) throw new Error('Claude compaction boundary identity is missing.');
  if (boundary.compactMetadata?.preservedSegment || boundary.compactMetadata?.preservedMessages) {
    throw new Error('Claude compaction preserved-segment dependencies are unsupported; automatic handoff paused.');
  }
  const tail = rows.slice(index + 1).filter(row => !row.isSidechain);
  const summaries = tail.filter(row => row.isCompactSummary);
  const summary = summaries[0];
  if (summaries.length !== 1 || summary.type !== 'user' || summary.parentUuid !== boundary.uuid) {
    throw new Error('Claude compaction requires one explicitly linked native summary.');
  }
  const content = summary.message?.content;
  const readable = typeof content === 'string' ? content : Array.isArray(content) && content.every(block => block.type === 'text' && typeof block.text === 'string') ? content.map(block => block.text).join('\n') : '';
  if (!readable.trim()) throw new Error('Claude compaction summary is missing or opaque.');
  if (tail.slice(0, tail.indexOf(summary)).some(row => row.type === 'user' || row.type === 'assistant')) throw new Error('Claude compaction summary order is ambiguous.');
  return {
    rows: [boundary, ...tail.map(row => row === summary ? { ...row, message: { ...row.message, content: summaryText(readable) } } : row)],
    metadata: boundaryMetadata(text, rows, index, 'claude'),
  };
}
