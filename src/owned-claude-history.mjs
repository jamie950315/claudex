import { decodeClaude } from './claude.mjs';
import { decodeContextPacket } from './context-packet.mjs';
import { assertComplete, fingerprint, portableMessages } from './history.mjs';

// CLI 2.1.281 repairs a resumed no-query user tail with this zero-usage
// placeholder before persisting the next input. It is not an authored reply.
// Recognize it only immediately after an authenticated imported packet.
function noQueryReceipt(message) {
  return message.role === 'assistant' && message.model === '<synthetic>' && message.stop_reason === 'stop_sequence'
    && message.content?.length === 1 && message.content[0].type === 'text' && message.content[0].text === 'No response requested.'
    && message.usage?.input_tokens === 0 && message.usage?.output_tokens === 0
    && Object.values(message.usage).every(value => value === 0);
}

const messageKey = message => {
  const time = Date.parse(message.timestamp);
  const timestamp = Number.isFinite(time) ? new Date(time).toISOString() : message.timestamp ?? '';
  return `${timestamp}:${fingerprint({ messages: [message] })}`;
};

function nativeImageAnnotationKeys(text, native, { conversationId, sessionId, key }) {
  const rows = text.split('\n').filter(Boolean).map(JSON.parse);
  const byId = new Map(rows.filter(row => row.uuid).map(row => [row.uuid, row]));
  const excluded = new Set();
  for (const row of rows) {
    if (row.type !== 'user' || row.isMeta !== true || row.isSidechain || row.sessionId !== sessionId || row.version !== '2.1.281') continue;
    const parent = byId.get(row.parentUuid);
    if (parent?.type !== 'user' || parent.sessionId !== sessionId || parent.promptSource !== 'sdk' || parent.queueTranscriptOnly !== true
        || !row.promptId || row.promptId !== parent.promptId || row.timestamp !== parent.timestamp || row.cwd !== parent.cwd
        || !Array.isArray(parent.imagePasteIds) || !parent.imagePasteIds.length
        || new Set(parent.imagePasteIds).size !== parent.imagePasteIds.length
        || parent.imagePasteIds.some(id => !Number.isSafeInteger(id) || id < 0)) continue;
    const packet = decodeContextPacket({ content: parent.message?.content, conversationId, targetSessionId: sessionId, key });
    if (!packet || packet.sourceSide !== 'codex') continue;
    const images = parent.message.content.filter(block => block.type === 'image');
    if (images.length !== parent.imagePasteIds.length || !Array.isArray(row.message?.content) || row.message.content.length !== 1
        || row.message.content[0].type !== 'text' || typeof row.message.content[0].text !== 'string') continue;
    const lines = row.message.content[0].text.split('\n');
    if (lines.length !== images.length || typeof parent.cwd !== 'string') continue;
    const encodedProject = parent.cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const valid = lines.every((line, index) => {
      const match = /^\[Image: source: (\/[^\r\n]+?)(?:, original [1-9]\d*x[1-9]\d*, displayed at [1-9]\d*x[1-9]\d*\. Multiply coordinates by \d+\.\d{2} to map to original image\.)?\]$/.exec(line);
      const extensions = { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'], 'image/webp': ['webp'] }[images[index].source?.media_type];
      return Boolean(match && extensions?.some(extension => match[1].endsWith(`/${encodedProject}/${sessionId}/images/${parent.imagePasteIds[index]}.${extension}`)));
    });
    if (!valid) continue;
    const identity = messageKey({ role: 'user', content: row.message.content, timestamp: row.timestamp });
    if (excluded.has(identity) || native.messages.filter(message => messageKey(message) === identity).length !== 1) {
      throw new Error('Native image annotation identity is ambiguous; no metadata was discarded.');
    }
    excluded.add(identity);
  }
  return excluded;
}

/** A completed native assistant turn or an authenticated no-query packet forms
 * a publication boundary. A newer unfinished user turn is deliberately kept
 * local until it finishes, rather than blocking earlier completed work.
 */
export function completedClaudePrefix({ text, conversationId, sessionId, key }) {
  let offset = 0, cutoff = 0;
  for (const line of text.split('\n')) {
    offset += line.length + 1;
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('Malformed Claude history; source was left unchanged.'); }
    if (row.isSidechain) continue;
    if (row.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(row.message?.stop_reason)) cutoff = offset;
    if (key && row.type === 'user') {
      const packet = decodeContextPacket({ content: row.message?.content, conversationId, targetSessionId: sessionId, key });
      if (packet) cutoff = offset;
    }
  }
  if (!cutoff) throw new Error('Wait for a complete assistant turn or verified synchronized checkpoint.');
  return { text: text.slice(0, cutoff), incompleteTail: text.slice(cutoff).split('\n').filter(Boolean).some(line => {
    const row = JSON.parse(line);
    return !row.isSidechain && (row.type === 'user' || row.type === 'assistant');
  }) };
}

/** Recover logical conversation history without mistaking imports for new turns.
 * The native SDK remains the only writer. Callers must snapshot the source and
 * require an idle owner before using this view as a completed source checkpoint.
 */
export function decodeOwnedClaudeHistory({ text, conversationId, sessionId, key }) {
  const native = decodeClaude(text);
  if (native.meta.id !== sessionId) throw new Error('Owned Claude history has a different native session identity.');
  // Validate the full native parent graph first. Then exclude only the pinned
  // CLI's exact image-source sidecar tied to an authenticated no-query packet.
  // The sidecar stays in the native transcript and is not an authored turn.
  const imageAnnotations = nativeImageAnnotationKeys(text, native, { conversationId, sessionId, key });
  const messages = [];
  const operations = new Set();
  let importedPackets = 0;
  let followsPacket = false;
  for (const message of native.messages) {
    if (imageAnnotations.has(messageKey(message))) continue;
    const packet = message.role === 'user' ? decodeContextPacket({
      content: message.content, conversationId, targetSessionId: sessionId, key,
    }) : null;
    if (!packet) {
      const receipt = followsPacket && noQueryReceipt(message);
      followsPacket = false;
      if (!receipt) messages.push(...portableMessages([message]));
      continue;
    }
    if (packet.sourceSide !== 'codex') throw new Error('Owned Claude history contains a packet from the wrong source side.');
    if (operations.has(packet.operationId)) throw new Error('Owned Claude history contains a repeated synchronization operation.');
    const previous = messages.length ? fingerprint({ messages }) : null;
    if (packet.previousDigest !== previous) throw new Error('Owned Claude history does not match the synchronized prefix; no branch was selected.');
    operations.add(packet.operationId);
    messages.push(...packet.messages);
    importedPackets++;
    followsPacket = true;
  }
  const common = { ...native, messages, meta: { ...native.meta, ownedHistory: {
    conversationId, importedPackets, representation: 'logical-conversation',
  } } };
  assertComplete(common);
  return { common, digest: fingerprint(common), importedPackets };
}
