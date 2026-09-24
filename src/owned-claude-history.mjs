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
  const messages = [];
  const operations = new Set();
  let importedPackets = 0;
  let followsPacket = false;
  for (const message of native.messages) {
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
