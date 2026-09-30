import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fingerprint } from './history.mjs';
import { snapshot } from './storage.mjs';
import { isDesktopTracked } from './desktop-enrollment.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const validCheckpoint = value => Number.isSafeInteger(value?.count) && value.count > 0
  && /^[a-f0-9]{64}$/.test(value.digest ?? '');
const blocked = message => Object.assign(new Error(message), { code: 'CLAUDEX_ORIGINAL_SPLIT_BLOCKED' });
const contains = (data, checkpoint) => data.common.messages.length >= checkpoint.count
  && fingerprint(data.common, checkpoint.count) === checkpoint.digest;

/** Explicitly preserve two independently continued branches. Only enrollment
 * moves: native histories, the existing pair and its canonical history remain
 * unchanged. This is never an automatic choice of a winning branch.
 */
export async function splitDesktopOriginal({ bridge, conversationId, originalNativeId, originalRecordId, expectedCheckpoint }) {
  if (![conversationId, originalNativeId, originalRecordId].every(value => UUID.test(value ?? ''))
    || !validCheckpoint(expectedCheckpoint))
    throw blocked('Original splitting requires exact logical, native and record IDs and an inspected checkpoint.');
  return bridge.locked(async state => {
    if (state.pending) throw blocked('Recover the pending Desktop handoff before splitting an original branch.');
    const completed = Object.values(state.conversations).find(conversation => {
      const receipt = conversation.originalSplit;
      return receipt?.version === 1 && receipt.fromConversationId === conversationId
        && receipt.originalNativeId === originalNativeId && receipt.originalRecordId === originalRecordId;
    });
    if (completed) {
      const record = state.records.find(record => record.id === originalRecordId);
      if (state.conversations[completed.id] !== completed || !UUID.test(completed.id)
        || !validCheckpoint(completed.originalSplit.previousCheckpoint)
        || !Number.isSafeInteger(completed.originalSplit.at) || completed.originalSplit.at < 0
        || !record || record.nativeId !== originalNativeId || record.conversationId !== completed.id
        || record.side !== 'claude' || record.managed !== false || record.kind !== 'original' || record.verified !== true
        || !isDeepStrictEqual(completed.originalSplit.separatedCheckpoint, expectedCheckpoint))
        throw blocked('The saved original split receipt no longer matches its exact enrollment.');
      return result(completed, false);
    }
    const conversation = state.conversations[conversationId];
    const original = state.records.find(record => record.id === originalRecordId);
    if (!conversation || !isDesktopTracked(conversation) || !validCheckpoint(conversation.canonical)
      || !original || original.conversationId !== conversationId || original.nativeId !== originalNativeId
      || original.side !== 'claude' || original.managed !== false || original.kind !== 'original'
      || original.status !== 'original' || original.verified !== true || original.importPacket !== undefined
      || original.cwd !== conversation.cwd
      || !validCheckpoint(original.checkpoint)
      || state.records.filter(record => record.side === 'claude' && record.nativeId === originalNativeId).length !== 1)
      throw blocked('Only an exact tracked, verified, superseded unmanaged Claude original can be split.');
    const currents = state.records.filter(record => record.conversationId === conversationId && record.status === 'current');
    if (currents.length !== 2 || !['codex', 'claude'].every(side => currents.filter(record => record.side === side).length === 1)
      || currents.some(record => record.managed !== true || record.verified !== true
        || record.kind !== (record.side === 'codex' ? 'snapshot' : 'owner')
        || !isDeepStrictEqual(record.checkpoint, conversation.canonical)))
      throw blocked('Original splitting requires the unchanged verified current Codex and Claude pair.');

    // Each native adapter checks its normal identity/history rules. Raw proof
    // also fences metadata-only replacement or rewrites between those reads.
    const inspect = async record => {
      await bridge.adapters[record.side].assertIdle(record);
      const before = await snapshot(record.path);
      const data = await bridge.inspect(record);
      const after = await snapshot(record.path);
      if (data.path !== record.path || data.incompleteTail !== false
        || before.hash !== after.hash || !isDeepStrictEqual(before.fileIdentity, after.fileIdentity))
        throw blocked('Native history changed or has an unfinished turn; neither branch was changed.');
      return { data, proof: { path: record.path, hash: after.hash, fileIdentity: after.fileIdentity } };
    };
    const validateOriginal = ({ data }) => {
      if (!contains(data, original.checkpoint) || data.common.messages.length <= original.checkpoint.count
        || data.common.messages.length !== expectedCheckpoint.count || data.digest !== expectedCheckpoint.digest)
        throw blocked('The original no longer contains its saved prefix and the exact inspected completed branch.');
    };
    const validateCurrent = ({ data }) => {
      if (data.common.messages.length !== conversation.canonical.count || data.digest !== conversation.canonical.digest
        || !contains(data, original.checkpoint))
        throw blocked('The current pair changed or lost the shared original prefix; neither branch was changed.');
    };
    const source = await inspect(original); validateOriginal(source);
    // Other originals and dependency anchors retain their existing guards.
    await bridge.assertOriginalsUnchanged({ ...state, records: state.records.filter(record => record.id !== originalRecordId) }, conversationId);
    const destinations = [];
    for (const current of currents) {
      const reading = await inspect(current); validateCurrent(reading);
      destinations.push({ current, reading });
    }
    const sharedLength = Math.min(expectedCheckpoint.count, conversation.canonical.count);
    if (fingerprint(source.data.common, sharedLength) === fingerprint(destinations[0].reading.data.common, sharedLength))
      throw blocked('These histories are not independent branches; no original was split.');
    for (const { current, reading } of destinations) {
      const latest = await inspect(current); validateCurrent(latest);
      if (!isDeepStrictEqual(latest.proof, reading.proof))
        throw blocked('The current pair changed between verification reads; neither branch was changed.');
    }
    const latest = await inspect(original); validateOriginal(latest);
    if (!isDeepStrictEqual(latest.proof, source.proof))
      throw blocked('The original changed between verification reads; neither branch was changed.');

    const id = randomUUID(), at = bridge.now();
    if (!Number.isSafeInteger(at) || at < 0) throw blocked('The original split timestamp is invalid; neither branch was changed.');
    const branch = { id, cwd: conversation.cwd, title: conversation.title, canonical: { ...expectedCheckpoint },
      originalSplit: { version: 1, fromConversationId: conversationId, originalNativeId, originalRecordId,
        previousCheckpoint: { ...original.checkpoint }, separatedCheckpoint: { ...expectedCheckpoint }, at } };
    state.conversations[id] = branch;
    original.conversationId = id; original.status = 'current';
    original.checkpoint = { ...expectedCheckpoint }; original.bytes = latest.data.bytes;
    delete original.retiredAt;
    await bridge.save(state, { event: 'original-branch-split', conversationId: id, fromConversationId: conversationId,
      nativeId: originalNativeId });
    return result(branch, true);
  });
}

function result(conversation, changed) {
  const receipt = conversation.originalSplit;
  return { changed, conversationId: conversation.id, fromConversationId: receipt.fromConversationId,
    originalNativeId: receipt.originalNativeId, originalRecordId: receipt.originalRecordId,
    checkpoint: { ...receipt.separatedCheckpoint } };
}
