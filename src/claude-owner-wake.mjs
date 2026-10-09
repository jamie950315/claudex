import { readAppStopState } from './app-stop-state.mjs';
import { inspectClaudeOwnerWake, readClaudeOwnerWakeLedger } from './claude-folder-map.mjs';
import { SyncEventInbox, validateSyncEvent } from './sync-events.mjs';

export function validateClaudeOwnerWakeRequest(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || Object.keys(params).join(',') !== 'remoteId' || typeof params.remoteId !== 'string'
    || !/^cse_[A-Za-z0-9_-]{1,200}$/.test(params.remoteId))
    throw new Error('Owner wake accepts only one exact Remote Control identity.');
  return params.remoteId;
}

/** The Desktop controller capability authenticates this narrow publisher.
 * Its receipt is a durable activation hint, never synchronization or delivery.
 */
export function createClaudeOwnerWakePublisher({ root, inbox = new SyncEventInbox({ root }), now = Date.now }) {
  let chain = Promise.resolve();
  const recent = new Map();
  return params => {
    const remoteId = validateClaudeOwnerWakeRequest(params);
    const operation = chain.then(async () => {
      if ((await readAppStopState(root))?.stopped) return { accepted: false, reason: 'application stopped' };
      for (const [id, at] of recent) if (now() - at >= 30_000) recent.delete(id);
      if (recent.has(remoteId) && now() - recent.get(remoteId) < 5000)
        return { accepted: false, reason: 'rate limited' };
      if (recent.size >= 16) return { accepted: false, reason: 'rate limited' };
      const state = await readClaudeOwnerWakeLedger(root);
      // This unlocked read usually sees another conversation's delivery in
      // flight. The hint is durable: the watcher handles it under the
      // coordinator lock after that delivery and still refuses a transaction
      // that is really left pending.
      const target = await inspectClaudeOwnerWake({ root, state, remoteId, allowPending: true });
      if (target.ignored) return { accepted: false, reason: target.ignored };
      await target.recheck();
      if ((await readAppStopState(root))?.stopped) return { accepted: false, reason: 'application stopped' };
      await inbox.initialize();
      await inbox.publish({ side: 'claude', nativeId: target.record.nativeId, kind: 'owner-wake', remoteId });
      recent.set(remoteId, now());
      return { accepted: true };
    });
    chain = operation.catch(() => {});
    return operation;
  };
}

/** Called under watcher ownership, serializing with the coordinator. No sync,
 * recovery, discovery, Codex connection or message input is authorized here.
 */
export async function handleClaudeOwnerWake({ root, bridge, runtime, event, blocked, blockedConversations = new Map() }) {
  event = validateSyncEvent(event);
  if (event.kind !== 'owner-wake') throw new Error('Expected a Claude owner wake event.');
  return bridge.locked(async state => {
    if ((await readAppStopState(root))?.stopped) return { ignored: 'application stopped' };
    if (blocked) return { ignored: 'coordinator is blocked' };
    const target = await inspectClaudeOwnerWake({ root, state, remoteId: event.remoteId });
    if (target.ignored) return { ignored: target.ignored };
    const { record } = target;
    if (record.nativeId.toLowerCase() !== event.nativeId) return { ignored: 'native owner identity changed' };
    if (blockedConversations.has(record.conversationId)
      || [...blockedConversations.values()].some(value => value.conversationId === record.conversationId))
      return { ignored: 'conversation is blocked' };
    await target.recheck();
    if ((await readAppStopState(root))?.stopped) return { ignored: 'application stopped' };
    const result = await runtime.wakeClaudeOwner(record, target.owner);
    return result?.ignored ? result : { woken: true, conversationId: record.conversationId };
  });
}
