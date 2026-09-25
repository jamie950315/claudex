import { encodeContextPacket } from './context-packet.mjs';
import { decodeTransportPacket as decodeContextPacket, prepareArchiveResolver } from './context-packet-reader.mjs';
import { decodeCodex } from './native-drivers.mjs';
import { assertComplete, fingerprint, portableMessages } from './history.mjs';
import { convertNativeTurns, readStableNativeHistory, NATIVE_HISTORY_LIMITS } from './native-history.mjs';
import { hasPortableInitialDelegation } from './codex-delegation.mjs';

const RECEIPT_LABEL = '[Claudex import receipt — not an AI response]';

function receipt(digest) {
  return `${RECEIPT_LABEL}\nImported conversation checkpoint: ${digest}\nThis is a transport receipt only. No model was called and no assistant answer was generated.`;
}

/** A new immutable native projection transports one authenticated checkpoint.
 * Its explicit receipt closes the native turn without pretending to be an AI
 * answer. The logical decoder removes both transport messages together.
 */
export function buildOwnedCodexCommon({ canonical, key, conversationId, targetSessionId, operationId, contextContent, resolveArchive }) {
  assertComplete(canonical);
  if (canonical.messages[0].role !== 'user' && !hasPortableInitialDelegation(canonical.messages[0]))
    throw new Error('Owned Codex checkpoint requires an initial user message or an exact native Desktop delegation.');
  const content = contextContent ?? encodeContextPacket({ common: canonical, conversationId, targetSessionId, operationId, sourceSide: 'claude', previousDigest: null, key });
  const digest = fingerprint(canonical);
  if (contextContent) {
    const verified = decodeContextPacket({ content, conversationId, targetSessionId, key, resolveArchive });
    if (!verified || verified.digest !== digest || verified.sourceSide !== 'claude' || verified.previousDigest !== null
        || verified.operationId !== operationId) throw new Error('Prepared Codex context does not match the full canonical checkpoint.');
  }
  return {
    ...canonical,
    meta: { ...canonical.meta, id: targetSessionId },
    messages: [
      { role: 'user', content },
      { role: 'assistant', content: [{ type: 'text', text: receipt(digest) }] },
    ],
  };
}

/** Decode only independent native rollouts whose authenticated bootstrap is
 * still present. Referenced or compacted history is never silently reduced to
 * its tail; the caller must use a verified full-history source for that case.
 */
export function decodeOwnedCodexHistory({ text, conversationId, targetSessionId, sessionId = targetSessionId, key, resolveArchive }) {
  if (targetSessionId !== undefined && sessionId !== targetSessionId) throw new Error('Owned Codex history has conflicting expected session identities.');
  const native = decodeCodex(text);
  if (native.nativeId !== sessionId || native.common.meta.id !== sessionId) throw new Error('Owned Codex history has a different native session identity.');
  if (native.originator !== 'claudex') throw new Error('Owned Codex history lacks its native ownership marker.');
  const [bootstrap, acknowledgement, ...continuation] = native.common.messages;
  if (bootstrap?.role !== 'user') throw new Error('Owned Codex history is missing its initial checkpoint packet.');
  const packet = decodeContextPacket({ content: bootstrap.content, conversationId, targetSessionId: sessionId, key, resolveArchive });
  if (!packet) throw new Error('Owned Codex history is missing its authenticated checkpoint packet.');
  if (packet.sourceSide !== 'claude' || packet.previousDigest !== null) throw new Error('Owned Codex checkpoint has an invalid source side or prefix.');
  if (acknowledgement?.role !== 'assistant' || acknowledgement.content.length !== 1
      || acknowledgement.content[0].type !== 'text' || acknowledgement.content[0].text !== receipt(packet.digest)) {
    throw new Error('Owned Codex checkpoint is missing its exact transport receipt.');
  }
  for (const message of continuation) {
    if (decodeContextPacket({ content: message.content, conversationId, targetSessionId: sessionId, key, resolveArchive })) {
      throw new Error('Owned Codex history contains an unexpected additional checkpoint packet.');
    }
    if (message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text.startsWith(RECEIPT_LABEL))) {
      throw new Error('Owned Codex history contains an unexpected transport receipt.');
    }
  }
  const common = { ...native.common, messages: [
    ...packet.messages,
    ...portableMessages(continuation),
  ], meta: { ...native.common.meta, ownedHistory: {
    conversationId, importedPackets: 1, representation: 'logical-conversation',
    bootstrapDigest: packet.digest, operationId: packet.operationId,
  } } };
  assertComplete(common);
  return { common, digest: fingerprint(common), importedPackets: 1, operationId: packet.operationId, bootstrapDigest: packet.digest };
}

function onlyKeys(object, allowed, description) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(key => !allowed.includes(key))) {
    throw new Error(`Owned Codex checkpoint contains unexpected ${description}.`);
  }
}

function bootstrapContent(item) {
  onlyKeys(item, ['type', 'id', 'clientId', 'content'], 'user metadata');
  if (item.type !== 'userMessage' || typeof item.id !== 'string' || !item.id
      || item.clientId != null && (typeof item.clientId !== 'string' || !item.clientId)
      || !Array.isArray(item.content) || !item.content.length) throw new Error('Owned Codex checkpoint has invalid user metadata.');
  return item.content.map(block => {
    if (block?.type === 'text') {
      onlyKeys(block, ['type', 'text', 'text_elements'], 'user text metadata');
      if (typeof block.text !== 'string' || !Array.isArray(block.text_elements) || block.text_elements.length) throw new Error('Owned Codex checkpoint has modified text elements.');
      return { type: 'text', text: block.text };
    }
    if (block?.type === 'image') {
      onlyKeys(block, ['type', 'url', 'detail'], 'user image metadata');
      if (block.detail != null || typeof block.url !== 'string') throw new Error('Owned Codex checkpoint has modified image metadata.');
      const image = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(block.url);
      if (!image || Buffer.from(image[2], 'base64').toString('base64') !== image[2]) throw new Error('Owned Codex checkpoint requires exact inline image bytes.');
      return { type: 'image', source: { type: 'base64', media_type: image[1], data: image[2] } };
    }
    throw new Error('Owned Codex checkpoint contains an unsupported native user input.');
  });
}

/** Expand an authenticated immutable checkpoint from full native API items.
 * Native API history can span earlier rollouts and compaction. Packet content
 * is verified before generic rendering adds readable native metadata.
 */
export function decodeOwnedCodexNativeHistory({ snapshot, conversationId, targetSessionId, sessionId = targetSessionId, cwd, timestamp, key, resolveArchive }) {
  if (targetSessionId !== undefined && sessionId !== targetSessionId) throw new Error('Owned Codex history has conflicting expected session identities.');
  if (snapshot?.threadId !== sessionId) throw new Error('Owned Codex native snapshot has a different session identity.');
  // Validates every turn, including active/error status and final responses.
  // This view is used only for the continuation, never for decoding the packet.
  const display = convertNativeTurns(snapshot, { threadId: sessionId, cwd, timestamp, includeNotice: false });
  const first = snapshot.turns[0];
  if (first.items.length !== 2) throw new Error('Owned Codex checkpoint turn must contain exactly its packet and receipt.');
  const content = bootstrapContent(first.items[0]);
  const packet = decodeContextPacket({ content, conversationId, targetSessionId: sessionId, key, resolveArchive });
  if (!packet) throw new Error('Owned Codex history is missing its authenticated checkpoint packet.');
  if (packet.sourceSide !== 'claude' || packet.previousDigest !== null) throw new Error('Owned Codex checkpoint has an invalid source side or prefix.');
  const acknowledgement = first.items[1];
  onlyKeys(acknowledgement, ['type', 'id', 'text', 'phase', 'memoryCitation', 'delivery', 'questions'], 'receipt metadata');
  if (acknowledgement.type !== 'agentMessage' || acknowledgement.phase !== 'final_answer'
      || acknowledgement.text !== receipt(packet.digest)
      || ['memoryCitation', 'delivery', 'questions'].some(name => acknowledgement[name] != null)) {
    throw new Error('Owned Codex checkpoint is missing its exact transport receipt.');
  }
  const continuation = display.messages.slice(2);
  for (const message of continuation) {
    if (decodeContextPacket({ content: message.content, conversationId, targetSessionId: sessionId, key, resolveArchive })) throw new Error('Owned Codex history contains an unexpected additional checkpoint packet.');
    if (message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text.startsWith(RECEIPT_LABEL))) throw new Error('Owned Codex history contains an unexpected transport receipt.');
  }
  const common = { ...display, messages: [...packet.messages, ...continuation], meta: { ...display.meta, ownedHistory: {
    conversationId, importedPackets: 1, representation: 'logical-conversation',
    bootstrapDigest: packet.digest, operationId: packet.operationId,
  } } };
  assertComplete(common);
  return { common, digest: fingerprint(common), importedPackets: 1, operationId: packet.operationId, bootstrapDigest: packet.digest, nativeDigest: snapshot.digest };
}

export async function exportOwnedCodexHistory({ client, limits, completedPrefix = false, archiveRoot, ...options }) {
  const sessionId = options.sessionId ?? options.targetSessionId;
  const snapshot = await readStableNativeHistory({ client, threadId: sessionId, limits, completedPrefix });
  if (archiveRoot) options.resolveArchive = await prepareArchiveResolver({ root: archiveRoot,
    contents: [bootstrapContent(snapshot.turns[0].items[0])], conversationId: options.conversationId,
    targetSessionId: sessionId, key: options.key });
  const result = decodeOwnedCodexNativeHistory({ ...options, snapshot });
  if (Buffer.byteLength(JSON.stringify(result.common)) > (limits?.maxBytes ?? NATIVE_HISTORY_LIMITS.maxBytes)) throw new Error('Owned Codex history exceeds the converted byte limit; no partial history was returned.');
  return { ...result, turnCount: snapshot.turnCount, itemCount: snapshot.itemCount, bytes: snapshot.bytes, pages: snapshot.pages,
    incompleteTail: snapshot.incompleteTail, incompleteTailCount: snapshot.incompleteTailCount };
}

export async function decodeOwnedCodexHistoryWithArchives({ archiveRoot, ...options }) {
  const native = decodeCodex(options.text);
  const resolveArchive = await prepareArchiveResolver({ root: archiveRoot,
    contents: [native.common.messages[0]?.content], conversationId: options.conversationId,
    targetSessionId: options.sessionId ?? options.targetSessionId, key: options.key });
  return decodeOwnedCodexHistory({ ...options, resolveArchive });
}
