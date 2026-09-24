import { decodeClaude } from './claude.mjs';
import { decodeContextPacket } from './context-packet.mjs';
import { assertComplete, fingerprint, portableMessages } from './history.mjs';

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
  for (const message of native.messages) {
    const packet = message.role === 'user' ? decodeContextPacket({
      content: message.content, conversationId, targetSessionId: sessionId, key,
    }) : null;
    if (!packet) { messages.push(...portableMessages([message])); continue; }
    if (packet.sourceSide !== 'codex') throw new Error('Owned Claude history contains a packet from the wrong source side.');
    if (operations.has(packet.operationId)) throw new Error('Owned Claude history contains a repeated synchronization operation.');
    const previous = messages.length ? fingerprint({ messages }) : null;
    if (packet.previousDigest !== previous) throw new Error('Owned Claude history does not match the synchronized prefix; no branch was selected.');
    operations.add(packet.operationId);
    messages.push(...packet.messages);
    importedPackets++;
  }
  const common = { ...native, messages, meta: { ...native.meta, ownedHistory: {
    conversationId, importedPackets, representation: 'logical-conversation',
  } } };
  assertComplete(common);
  return { common, digest: fingerprint(common), importedPackets };
}
