import { basename, isAbsolute, join, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { coldImportHint, coldImportInactive, persistentColdEligible, persistentColdNativeIdentity } from './desktop-watch-hints.mjs';
import { ColdVerificationCache, captureVerificationFiles } from './cold-verification-cache.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { codexSessionId, discoverSources, isCodexSubagentSource } from './discovery.mjs';
import { withLock, writeDiagnosticJSON } from './storage.mjs';
import { publishClaudeFolderMap } from './claude-folder-map.mjs';
import { createClaudeDesktopHandoffPublisher } from './claude-desktop-handoff.mjs';
import { homedir } from 'node:os';
import { RECONNECT_ID } from './sync-event-source.mjs';

const WAITING = /still running|complete assistant|no completed persisted history|in-progress turn|unfinished|incomplete final|incomplete final line|empty or invalid conversation|transcript changed while being read|source history changed between complete reads|active writer|destination is active|Claude turn is still running|Claude Code is open|another bridge operation|shared Codex Desktop backend is not ready|shared Codex transport (?:closed|failed|is not connected)|could not connect to the shared Codex transport|transport unavailable|socket.*(?:unavailable|closed|disconnected)|ECONNREFUSED|ECONNRESET|ENOENT.*socket/i;
const UNSUPPORTED = /Codex compaction|Compacted Codex history|Referenced Codex history|Claude compaction|Dependent Claude history|Forked Claude history|Nonlinear Claude history|Missing or dependent Codex history|working directory changed|turn was interrupted|Unsupported message role|Duplicate open tool call|Unpaired tool result|External image references|Artifact handoffs|^Native Codex local image recovery: |^Native Codex history export: (?:unsupported user input or external asset; nothing was silently omitted\.|(?:converted )?byte limit exceeded; no partial export is returned\.|a completed turn (?:lacks its final assistant response|has no persisted items)\.)$/i;
// These are explicit history guards, not permission to choose a branch or retry
// an arbitrary failed native operation. Keep the owning process alive so one
// blocked handoff does not disconnect every unrelated Remote Control session.
const HISTORY_BLOCKED = /^(?:Owned Claude history does not match the synchronized prefix; no branch was selected\.|Owned Claude image refresh does not match the complete synchronized prefix; no history was duplicated\.|Conversation history diverged before the common checkpoint; no branch was selected\.|Both sides changed; no history was replaced\.|Superseded original .*changed;.*|Source changed (?:during handoff|before promotion); pending evidence was preserved\.|Destination changed during handoff; no branch was selected\.|Native destination did not preserve the complete copied checkpoint\.|A retained snapshot was edited; it was not retired\.|Current history changed; prior snapshots were preserved\.|Owned projection has dependent threads\.|Snapshot retention cannot be satisfied safely; new allocations are paused\.)$/i;
const reason = error => String(error?.message ?? error).slice(0, 500);
const contextReason = error => String(error?.message ?? error).slice(0, 1000);
const conversationContext = (state, id) => ({
  ...(typeof id === 'string' && id ? { conversationId: id } : {}),
  ...(typeof state.conversations[id]?.title === 'string' && state.conversations[id].title
    ? { title: state.conversations[id].title.slice(0, 200) } : {}),
});
const isWaiting = error => WAITING.test(reason(error));
const lacksFirstTurn = error => /^Wait for a complete assistant turn(?: or verified synchronized checkpoint)?\.$/.test(reason(error))
  || /^Native Codex history export: no completed persisted history is available; wait for a complete turn\.(?: \[Codex thread [a-f0-9-]+\])?$/.test(reason(error));
const isUnsupported = error => UNSUPPORTED.test(reason(error))
  || /^Native Codex history export: an assistant message precedes the turn user input\.(?: \[Codex thread [a-f0-9-]+\])?$/i.test(reason(error));
const isHistoryBlocked = error => error?.code === 'CLAUDEX_ORIGINAL_ARCHIVE_BLOCKED'
  || error?.code === 'CLAUDEX_DEPENDENCY_ANCHOR_BLOCKED'
  || error?.code === 'CLAUDEX_TRACKED_HISTORY_UNAVAILABLE'
  || error?.code === 'CLAUDEX_TRACKED_CWD_UNAVAILABLE'
  || error?.code === 'CLAUDEX_CLAUDE_RELOCATION_BLOCKED' || error?.code === 'CLAUDE_RELOCATION_BLOCKED'
  || HISTORY_BLOCKED.test(reason(error)) || isUnsupported(error);

function usesActiveHints(state, id) {
  return state.conversations[id]?.discoveryMode !== 'cold-import'
    || state.records.some(record => record.conversationId === id && record.side === 'claude'
      && record.managed && record.kind === 'owner' && record.status === 'current');
}

// Unlike verified cold hints, these observations ONLY change queue priority.
// Every active conversation still receives the normal full lifecycle inspection.
async function activeActivityHint(state, id) {
  if (state.pending) return null;
  const records = state.records.filter(record => record.conversationId === id);
  if (!records.length) return null;
  const files = [];
  for (const record of records) {
    if (typeof record.path !== 'string' || !isAbsolute(record.path)) return null;
    try {
      const info = await lstat(record.path, { bigint: true });
      if (!info.isFile() || await realpath(record.path) !== resolve(record.path)) return null;
      files.push([record.path, ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'nlink']
        .map(key => info[key].toString())]);
    } catch { return null; }
  }
  return JSON.stringify({ conversation: state.conversations[id], records, files });
}

/** Run the opt-in Desktop coordinator under the same lock as the legacy watcher. */
export async function runDesktopWatch({ root, bridge, runtime, config, signal, pollMs = 2000,
  discover = discoverSources, sleep = (ms, options) => delay(ms, undefined, options),
  now = () => Date.now(), maxPasses = Infinity, coldValidationMs = 60_000,
  blockedRetryMs = 30_000,
  writeStatus = writeDiagnosticJSON,
  verificationCache,
  events,
  publishFolders = publishClaudeFolderMap,
  maintainFolders = async options => (await import('./claude-folder-install.mjs')).ensureClaudeFolderCache(options) }) {
  if (!root || !bridge || !runtime || !config) throw new Error('Desktop watcher requires root, bridge, runtime, and discovery configuration.');
  if (!Number.isInteger(pollMs) || pollMs < 0 || !(maxPasses > 0)) throw new Error('Invalid Desktop watcher interval or pass limit.');
  if (!Number.isInteger(coldValidationMs) || coldValidationMs < 1) throw new Error('Invalid cold-import validation interval.');
  if (!Number.isInteger(blockedRetryMs) || blockedRetryMs < 1) throw new Error('Invalid blocked-history revalidation interval.');
  const statusPath = join(root, 'watcher-status.json');
  const startedAt = now();
  let lastCollection = startedAt;
  let passes = 0;
  let eventBatch = null, presentationScope;
  let eventWakeCount = 0, eventSyncCount = 0, lastEventAt = null, awaitingEvents = false;
  let hookStatus = null;
  const deferredEvents = new Map();
  const eventWaits = new Map();
  const eventKey = event => `${event.side}:${event.nativeId}`;
  const deferEvent = (event, attempt = 0) => {
    const delays = [250, 1000, 3000];
    if (attempt < delays.length) deferredEvents.set(eventKey(event), { event, attempt: attempt + 1, due: now() + delays[attempt] });
  };
  let blocked = null;
  const blockedConversations = new Map();
  const deferredBlock = Symbol('deferred history revalidation');
  const deletedSource = Symbol('deleted discovered source');
  const block = (previous, error, fields) => ({ ...fields, reason: reason(error),
    ...(error?.code === 'CLAUDEX_TRACKED_HISTORY_UNAVAILABLE' ? { historyUnavailable: {
      side: error.side, nativeId: error.nativeId, savedPath: String(error.savedPath).slice(0, 4096),
      conversationId: error.conversationId ?? null,
    } } : {}),
    ...(error?.code === 'CLAUDEX_TRACKED_CWD_UNAVAILABLE' ? { workingDirectoryUnavailable: {
      side: error.side, nativeId: error.nativeId, savedCwd: String(error.savedCwd).slice(0, 4096),
      conversationId: error.conversationId ?? null,
    } } : {}),
    since: previous?.since ?? now(), lastAttemptAt: now(), retryAt: now() + blockedRetryMs,
    attempts: Math.min(Number.MAX_SAFE_INTEGER, (previous?.attempts ?? 0) + 1) });
  const blockingStatus = () => ({ blocked, blockedConversationCount: blockedConversations.size,
    blockedConversations: [...blockedConversations.values()].slice(0, 20) });
  // Persistent proofs only reuse fully verified, unchanged original pairs.
  // Native owners and mutation/collection guards never consume these proofs.
  const proofCache = verificationCache ?? (runtime.key && runtime.verificationCacheContext
    ? new ColdVerificationCache({ root, key: runtime.key, now }) : null);
  const coldHints = new Map();
  // Observations only select priority; unlike coldHints, they never authorize
  // skipping verification. Keep unsuccessful dirty work in the foreground.
  const coldObserved = new Map();
  const coldDirty = new Set();
  const activeObserved = new Map();
  const activeDirty = new Set();
  let activePrioritySyncs = 0;
  const clearHints = () => {
    coldHints.clear(); coldObserved.clear(); coldDirty.clear(); activeObserved.clear(); activeDirty.clear();
  };
  const observeActive = async (state, id) => {
    if (!usesActiveHints(state, id)) { activeObserved.delete(id); activeDirty.delete(id); return; }
    const hint = await activeActivityHint(state, id);
    if (activeObserved.has(id) && activeObserved.get(id) !== hint) activeDirty.add(id);
    activeObserved.set(id, hint);
  };
  let foregroundCompletedAt = null;
  let foregroundDurationMs = null;
  let initialSweepCompletedAt = null;
  let discoveryCompletedAt = null;
  let discoveryDurationMs = null;
  let maxDiscoveryGapMs = 0;
  let lastSync = null;
  let slowestSync = null;
  let currentOperation = null;
  let checkingConversationCount = 0;
  const checkedConversations = new Set();
  const reusedConversations = new Set();
  let fullVerificationCount = 0;
  let latestFields = { waiting: null, waitingContexts: [], blockedSourceCount: 0, blockedSources: [] };
  let folderProjection = null, lastFolderMaintenance = null, folderResource = null, folderResourceError = null;
  let localHandoff = null;
  const handoffs = config.desktopLocalHandoff?.enabled === true ? createClaudeDesktopHandoffPublisher({ root,
    desktopHome: config.desktopHome ?? join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
    inspect: async record => {
      const data = await bridge.inspect(record);
      if (record.managed && record.kind === 'owner') {
        const owner = runtime.owners?.get(record.conversationId)?.owner;
        const state = owner?.status();
        if (!state || state.nativeState !== 'idle' || state.backgroundTasks?.length || state.pending || state.reset)
          throw new Error('Claude replacement is active; Local archival is postponed.');
      }
      return data;
    } }) : null;
  let lastProgressAt = null, lastProgressHealth = null, publishedFirstOperation = false;
  const writeProgress = async () => {
    const timestamp = now();
    const hookBlock = hookStatus && !hookStatus.ready ? { scope: 'hooks', reason: hookStatus.reason } : null;
    const progress = { mode: 'desktop', running: true, pid: process.pid,
    scheduler: events ? 'completion-events' : 'activity-interleaved', startedAt, updatedAt: now(),
    ...(events ? { eventWakeCount, eventSyncCount, lastEventAt, awaitingEvents, eventSources: events.metrics, hookStatus } : {}),
    versionPolicy: runtime.versionPolicy ?? config.versionPolicy ?? 'strict',
    versionWarnings: runtime.versionWarnings?.() ?? [], foregroundCompletedAt, foregroundDurationMs, initialSweepCompletedAt,
    discoveryCompletedAt, discoveryDurationMs, maxDiscoveryGapMs, lastSync, slowestSync,
    currentOperation, checkingConversationCount, checkedConversationCount: checkedConversations.size,
    reusedVerificationCount: reusedConversations.size, fullVerificationCount,
    activePrioritySyncs, activeDirtyCount: activeDirty.size, folderProjection, localHandoff,
    synchronization: blocked || hookBlock ? 'blocked' : blockedConversations.size ? 'degraded' : latestFields.waiting ? 'waiting' : 'ready',
    ...blockingStatus(), ...latestFields, blocked: blocked ?? hookBlock };
    const guardHealth = value => value && Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['since', 'lastAttemptAt', 'retryAt', 'attempts'].includes(key)));
    const presentationHealth = value => value && { state: value.state, error: value.error, deferred: value.deferred };
    const health = JSON.stringify({ synchronization: progress.synchronization, awaitingEvents,
      blocked: guardHealth(progress.blocked), blockedConversations: progress.blockedConversations.map(guardHealth),
      waiting: progress.waiting, waitingContexts: progress.waitingContexts,
      blockedSourceCount: progress.blockedSourceCount, blockedSources: progress.blockedSources,
      folderProjection: presentationHealth(progress.folderProjection), localHandoff: presentationHealth(progress.localHandoff),
      foregroundComplete: progress.foregroundCompletedAt !== null, initialSweepComplete: progress.initialSweepCompletedAt !== null });
    // Progress is disposable diagnostics. Coalesce rapid updates while keeping
    // every changed conflict/reason visible immediately. The next poll or 10s
    // native-operation heartbeat publishes current state, never a queued snapshot.
    const firstOperation = progress.currentOperation && !publishedFirstOperation;
    if (!firstOperation && lastProgressAt !== null && timestamp >= lastProgressAt && timestamp - lastProgressAt < 2000
      && health === lastProgressHealth) return;
    await writeStatus(statusPath, progress);
    lastProgressAt = timestamp; lastProgressHealth = health;
    if (progress.currentOperation) publishedFirstOperation = true;
  };
  const status = async fields => {
    latestFields = fields;
    if (handoffs) {
      try {
        const result = await handoffs.publish(await bridge.status(), presentationScope === undefined ? {} : { conversationIds: presentationScope });
        localHandoff = { ...result, state: result.deferred === 'history_changed' ? 'waiting' : 'ready', updatedAt: now() };
      }
      catch (error) { localHandoff = { state: 'error', error: reason(error), updatedAt: now() }; }
    }
    if (config.folderProjection?.enabled === true) {
      try {
        const map = await publishFolders({ root, state: await bridge.status() });
        if (lastFolderMaintenance === null || now() - lastFolderMaintenance >= 60_000) {
          lastFolderMaintenance = now();
          try {
            folderResource = await maintainFolders({ root, cachePath: config.folderProjection.cachePath });
            folderResourceError = null;
          } catch (error) { folderResourceError = reason(error); throw error; }
        }
        if (folderResourceError) throw new Error(folderResourceError);
        folderProjection = { state: map.deferred ? 'deferred' : 'ready', entries: map.entries,
          deferred: map.deferred, resource: folderResource, updatedAt: now() };
      } catch (error) {
        // Presentation failures remain explicit without interrupting native
        // user work or changing the conversation coordinator's write guards.
        folderProjection = { state: 'error', error: reason(error), updatedAt: now() };
      }
    }
    return writeProgress();
  };
  return withLock(join(root, 'watch.lock'), async () => {
    await status({ waiting: null, waitingContexts: [], blockedSourceCount: 0, blockedSources: [] });
    try {
      while (!signal?.aborted && passes++ < maxPasses) {
        const broadPass = !events || eventBatch === null || eventBatch.some(event => event.kind === 'reconnect');
        presentationScope = broadPass ? undefined : [];
        if (broadPass) eventWaits.clear();
        let waiting = events ? [...eventWaits.values()][0]?.reason ?? null : null;
        const waitingContexts = events ? [...eventWaits.values()].slice(0, 20) : [];
        const wait = (error, fields) => {
          waiting ??= reason(error);
          const context = { ...fields, reason: contextReason(error) };
          if (events && fields.conversationId) eventWaits.set(fields.conversationId, context);
          if (waitingContexts.length < 20 && !waitingContexts.some(item => JSON.stringify(item) === JSON.stringify(context)))
            waitingContexts.push(context);
        };
        let blockedSourceCount = 0;
        const blockedSources = [];
        try {
          // A pending transaction remains the only allowed native operation.
          // Waiting out this backoff does not clear it or allocate a new target.
          if (blocked && now() < blocked.retryAt && !events) throw deferredBlock;
          // The transport is a prerequisite. Never enroll a source while it is absent.
          const codex = await runtime.codex();
          if (events && runtime.synchronizationHooks) hookStatus = await runtime.synchronizationHooks();
          const cacheContext = proofCache ? await runtime.verificationCacheContext() : null;
          const sync = async id => {
            if (blockedConversations.has(id) && now() < blockedConversations.get(id).retryAt && !events) return { blocked: true };
            try {
              const state = await bridge.status();
              const before = await coldImportHint(state, id);
              const previous = coldHints.get(id);
              const observedAt = now();
              const persistent = proofCache && before && persistentColdEligible(state, id);
              let nativeIdentity;
              if (persistent) {
                nativeIdentity = await persistentColdNativeIdentity(state, id, codex);
                const cached = nativeIdentity && await proofCache.load(id, before, { ...cacheContext, nativeIdentity });
                if (cached && await coldImportHint(await bridge.status(), id) === before) {
                  coldDirty.delete(id); coldObserved.set(id, before);
                  checkedConversations.add(id); reusedConversations.add(id);
                  return { changed: false, reused: true };
                }
                // A miss grants no reuse. Full verification still runs, and
                // its failure handler durably revokes any old proof. Do not
                // flush a tombstone before every successful context refresh
                // only to immediately replace it with a freshly verified proof.
              }
              if (!persistent && before && !coldDirty.has(id) && previous?.signature === before && observedAt >= previous.verifiedAt
                && observedAt - previous.verifiedAt < coldValidationMs) return;
              const activeBefore = usesActiveHints(state, id) ? await activeActivityHint(state, id) : undefined;
              coldHints.delete(id);
              if (before) coldDirty.add(id);
              const beganAt = now();
              currentOperation = { ...conversationContext(state, id), startedAt: beganAt };
              latestFields = { waiting, waitingContexts, blockedSourceCount, blockedSources };
              await writeProgress();
              // Status-only heartbeat: it never reads histories, publishes archive
              // intents, advances a checkpoint, or starts a second native operation.
              const heartbeatStop = new AbortController();
              const heartbeat = (async () => {
                while (!heartbeatStop.signal.aborted) {
                  try { await delay(10_000, undefined, { signal: heartbeatStop.signal }); }
                  catch (error) { if (error.name === 'AbortError') return; throw error; }
                  if (!heartbeatStop.signal.aborted) await writeProgress();
                }
              })();
              let heartbeatError;
              const heartbeatDone = heartbeat.catch(error => { heartbeatError = error; });
              let result, verificationFiles;
              try {
                fullVerificationCount++;
                if (persistent) {
                  const captured = await captureVerificationFiles(() => bridge.sync(id));
                  result = captured.result; verificationFiles = captured.files;
                } else result = await bridge.sync(id);
                checkedConversations.add(id);
              }
              finally {
                heartbeatStop.abort();
                await heartbeatDone;
                currentOperation = null;
                lastSync = { conversationId: id, durationMs: now() - beganAt };
                if (!slowestSync || lastSync.durationMs > slowestSync.durationMs) slowestSync = lastSync;
              }
              if (heartbeatError) throw heartbeatError;
              blockedConversations.delete(id);
              // An inactive original may retain an old unfinished tail. Its
              // exact unchanged bytes can reuse a verified canonical-prefix
              // no-op proof; the tail is never delivered or declared complete.
              if (before && result?.changed === false && (result.incompleteTail === false
                || persistent && result.incompleteTail === true)) {
                const latest = await bridge.status();
                if (await coldImportInactive(latest, id, codex)) {
                  const after = await coldImportHint(latest, id);
                  // A concurrent append, replacement or lifecycle transition
                  // must force another full sync, not refresh a stale hint.
                  if (before === after) {
                    coldHints.set(id, { signature: after, verifiedAt: now() });
                    coldDirty.delete(id);
                    if (persistent && verificationFiles) {
                      const latestIdentity = await persistentColdNativeIdentity(latest, id, codex);
                      if (latestIdentity && JSON.stringify(latestIdentity) === JSON.stringify(nativeIdentity))
                        await proofCache.store(id, { signature: after, context: { ...cacheContext, nativeIdentity: latestIdentity },
                          files: verificationFiles, verifiedAt: now() });
                    }
                  }
                }
              }
              if (activeBefore !== undefined) {
                const latest = await bridge.status();
                const activeAfter = await activeActivityHint(latest, id);
                // Preserve changes racing a read or handoff. Own writes may
                // require one later stable verification, never a self-loop.
                activeObserved.set(id, activeBefore);
                if (activeBefore !== null && activeBefore === activeAfter && result?.incompleteTail !== true) {
                  activeDirty.delete(id);
                  coldDirty.delete(id);
                  activeObserved.set(id, activeAfter);
                } else if (activeBefore !== activeAfter) activeDirty.add(id);
              }
              // A successful prefix read can still be incomplete or race more
              // native metadata. Unsatisfied priority work must yield too.
              if (activeDirty.delete(id)) activeDirty.add(id);
              return result ?? { changed: false };
            }
            catch (error) {
              coldHints.delete(id);
              if (proofCache) await proofCache.invalidate(id);
              // A native write may have committed before its response failed. Recover
              // its durable intent and verify the native target before proceeding.
              const latest = await bridge.status();
              if (latest.pending) {
                clearHints();
                // Do not discover or start another sync while recovery waits.
                await bridge.recover();
                return { recovered: true };
              }
              if (isWaiting(error)) {
                if (activeDirty.delete(id)) activeDirty.add(id); // Busy work yields to the next dirty owner.
                const waitingId = error.conversationId ?? id;
                wait(error, { scope: waitingId === id ? 'conversation' : 'coordinator',
                  ...conversationContext(latest, waitingId) }); return { waiting: true };
              }
              if (isHistoryBlocked(error)) {
                // An allocation's global original/retention guard can identify
                // another conversation. Keep that coordinator-wide source hold
                // attached to its actual identity instead of the caller's title.
                if (['CLAUDEX_TRACKED_HISTORY_UNAVAILABLE', 'CLAUDEX_TRACKED_CWD_UNAVAILABLE', 'CLAUDEX_CLAUDE_RELOCATION_BLOCKED',
                  'CLAUDE_RELOCATION_BLOCKED'].includes(error?.code)
                  && error.conversationId && error.conversationId !== id) throw error;
                // No durable intent exists, so other conversations may still
                // be verified. Their normal global quota/original guards are
                // unchanged and may independently block a new allocation.
                // Other global guards keep this caller held, but report the exact
                // conversation whose history failed instead of the caller's title.
                const blockedId = typeof error?.conversationId === 'string' && latest.conversations[error.conversationId]
                  ? error.conversationId : id;
                blockedConversations.set(id, block(blockedConversations.get(id), error, conversationContext(latest, blockedId)));
                return { blocked: true };
              }
              throw error;
            }
          };
          const discoverNew = async onlyKeys => {
            const beganAt = now();
            let state = await bridge.status();
            if (state.pending) { clearHints(); await bridge.recover(); }
            state = await bridge.status();
            checkingConversationCount = Object.keys(state.conversations).length;
            for (const id of checkedConversations) if (!state.conversations[id]) checkedConversations.delete(id);
            const existing = new Set(Object.keys(state.conversations));
            const known = new Set(state.records.map(record => `${record.side}:${record.nativeId}`));
            for (const id of await runtime.ownedNativeIds()) known.add(id);
            // Each refresh reports one discovery snapshot, not an accumulating
            // count of the same unsupported source during a long cold sweep.
            blockedSourceCount = 0;
            blockedSources.length = 0;
            // Event-filtered discovery reads only the notified sources' transcripts;
            // each candidate's identity is still derived and checked below.
            const candidates = await discover({ ...config, allProjects: true, projects: [], excludeSubagents: false,
              ...(onlyKeys ? { onlyKeys } : {}) }, known);
            for (const source of candidates) {
              if (signal?.aborted) break;
              let nativeId = source.nativeId ?? source.id;
              try {
                if (onlyKeys) {
                  if (!nativeId && source.side === 'codex') nativeId = await codexSessionId(source.path);
                  if (!nativeId && source.side === 'claude') {
                    const candidate = basename(source.path, '.jsonl');
                    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(candidate)) nativeId = candidate;
                  }
                  if (!onlyKeys.has(`${source.side}:${String(nativeId).toLowerCase()}`)) continue;
                }
                if (source.side === 'codex') {
                  nativeId ??= await codexSessionId(source.path);
                  const read = await codex.request('thread/read', { threadId: nativeId, includeTurns: false }).catch(async error => {
                    // Desktop can delete a transient thread and its rollout right
                    // after discovery listed it. Skip only a source whose exact
                    // discovered file is now absent; it has nothing to enroll.
                    if (typeof source.path === 'string' && isAbsolute(source.path)
                      && await lstat(source.path).then(() => false, lstatError => {
                        if (['ENOENT', 'ENOTDIR'].includes(lstatError.code)) return true;
                        throw lstatError;
                      })) return deletedSource;
                    if (/not found|no rollout/i.test(reason(error))) throw new Error('Referenced Codex history is unavailable.');
                    throw error;
                  });
                  if (read === deletedSource) continue;
                  const metadata = read?.thread;
                  if (!metadata || metadata.id !== nativeId) throw new Error('Codex returned a different native identity.');
                  if (isCodexSubagentSource(metadata.source)) continue;
                }
                await bridge.track({ ...source, ...(nativeId ? { nativeId } : {}) });
                const latest = await bridge.status();
                for (const record of latest.records) known.add(`${record.side}:${record.nativeId}`);
              } catch (error) {
                // An unenrolled source without a completed first turn has
                // nothing eligible to hand off. It must not mark every healthy
                // tracked conversation (or the whole status UI) as waiting.
                if (isWaiting(error)) {
                  if (!lacksFirstTurn(error)) wait(error, { scope: 'source', side: source.side,
                    ...(typeof nativeId === 'string' && nativeId ? { nativeId } : {}),
                    ...(typeof source.title === 'string' && source.title ? { title: source.title.slice(0, 200) } : {}) });
                  continue;
                }
                if (!isUnsupported(error)) throw error;
                blockedSourceCount++;
                if (blockedSources.length < 20) blockedSources.push({ side: source.side, path: source.path, reason: reason(error) });
              }
            }
            state = await bridge.status();
            checkingConversationCount = Object.keys(state.conversations).length;
            const completedAt = now();
            if (discoveryCompletedAt !== null) maxDiscoveryGapMs = Math.max(maxDiscoveryGapMs, completedAt - discoveryCompletedAt);
            discoveryCompletedAt = completedAt;
            discoveryDurationMs = completedAt - beganAt;
            return Object.keys(state.conversations).filter(id => !existing.has(id));
          };
          // A whole foreground sweep can itself take tens of seconds. Discover
          // new work and observe existing active files between operations. One
          // dirty active owner may jump ahead per boundary; the fixed sweep still
          // advances, and managed lifecycle checks are never skipped by metadata.
          const refreshNew = async nextId => {
            if (signal?.aborted || now() - discoveryCompletedAt < Math.max(1, pollMs)) return;
            const fresh = await discoverNew();
            for (const id of fresh) {
              if (signal?.aborted) break;
              // After enrollment, errors belong to a tracked history. Keep this
              // outside discovery's unsupported-source warning handler.
              await sync(id);
            }
            const latest = await bridge.status();
            for (const id of Object.keys(latest.conversations)) {
              await observeActive(latest, id);
              const hint = await coldImportHint(latest, id);
              if (coldObserved.has(id) && hint !== coldObserved.get(id)) coldDirty.add(id);
              if (hint) coldObserved.set(id, hint);
              else if (usesActiveHints(latest, id)) coldObserved.delete(id);
            }
            for (const id of activeDirty) if (!latest.conversations[id]) { activeDirty.delete(id); activeObserved.delete(id); }
            const nextDirty = [...new Set([...coldDirty, ...activeDirty])].find(id => id !== nextId && !fresh.includes(id)
              && (!blockedConversations.has(id) || now() >= blockedConversations.get(id).retryAt));
            if (nextDirty && !signal?.aborted) {
              activePrioritySyncs++;
              await sync(nextDirty);
            }
            await status({ waiting, waitingContexts, blockedSourceCount, blockedSources });
          };
          const foreground = async () => {
            const beganAt = now();
            const fresh = await discoverNew();
            const freshIds = new Set(fresh);
            const state = await bridge.status();
            for (const cache of [coldHints, coldObserved, coldDirty, activeObserved, activeDirty, blockedConversations]) {
              for (const id of cache.keys()) if (!state.conversations[id]) cache.delete(id);
            }
            const dirty = [], active = [], background = [];
            for (const id of Object.keys(state.conversations)) {
              const hint = await coldImportHint(state, id);
              if (hint && coldObserved.has(id) && coldObserved.get(id) !== hint) coldDirty.add(id);
              if (hint) coldObserved.set(id, hint);
              await observeActive(state, id);
              if (freshIds.has(id)) continue;
              else if (coldDirty.has(id) || activeDirty.has(id)) dirty.push(id);
              else if (!hint) active.push(id); // Includes live managed owners and invalid/missing paths.
              else background.push(id);
            }
            for (const id of [...fresh, ...dirty, ...active]) {
              if (signal?.aborted) break;
              await refreshNew(id);
              if (signal?.aborted) break;
              await sync(id);
            }
            foregroundCompletedAt = now();
            foregroundDurationMs = foregroundCompletedAt - beganAt;
            await status({ waiting, waitingContexts, blockedSourceCount, blockedSources });
            return background;
          };
          // Refresh only new/changed work between cold operations, not the whole
          // active queue again every poll. Every active owner still receives its
          // regular full lifecycle check once per pass. Never parallelize writers.
          if (broadPass) {
            const background = await foreground();
            for (const id of background) {
              if (signal?.aborted) break;
              await refreshNew(id);
              if (signal?.aborted) break;
              await sync(id);
            }
            await refreshNew();
          } else {
            eventBatch = await events.current?.(eventBatch) ?? eventBatch;
            let state = await bridge.status();
            if (state.pending) { clearHints(); await bridge.recover(); state = await bridge.status(); }
            await events.observe(eventBatch, state);
            const relevant = eventBatch.filter(event => !['started', 'configuration'].includes(event.kind));
            const keys = new Set(relevant.map(eventKey));
            const known = new Set(state.records.map(record => `${record.side}:${record.nativeId?.toLowerCase()}`));
            if ([...keys].some(key => !known.has(key))) await discoverNew(keys);
            state = await bridge.status();
            for (const event of relevant) if (event.kind !== 'session'
              && !state.records.some(record => `${record.side}:${record.nativeId?.toLowerCase()}` === eventKey(event)))
              deferEvent(event, event.retryAttempt ?? 0);
            await events.observe(eventBatch, state);
            const targets = new Map();
            for (const event of relevant) for (const record of state.records) {
              if (`${record.side}:${record.nativeId?.toLowerCase()}` !== eventKey(event)) continue;
              // Session-start notifications also describe our own snapshot registration.
              if (event.kind === 'session' && known.has(eventKey(event)) && record.managed) continue;
              if (state.conversations[record.conversationId]) {
                const list = targets.get(record.conversationId) ?? [];
                list.push(event); targets.set(record.conversationId, list);
              }
            }
            presentationScope = [...targets.keys()];
            for (const [id, sourceEvents] of targets) {
              if (signal?.aborted) break;
              eventWaits.delete(id);
              for (let index = waitingContexts.length - 1; index >= 0; index--)
                if (waitingContexts[index].conversationId === id) waitingContexts.splice(index, 1);
              waiting = waitingContexts[0]?.reason ?? null;
              eventSyncCount++;
              const result = await sync(id);
              if (result?.waiting || result?.incompleteTail || result?.changed === false) {
                for (const event of sourceEvents) if (event.kind !== 'session') deferEvent(event, event.retryAttempt ?? 0);
              }
            }
            await events.observe(eventBatch, await bridge.status());
          }
          if (!signal?.aborted && initialSweepCompletedAt === null) initialSweepCompletedAt = now();
          if (!signal?.aborted && broadPass && now() - lastCollection >= 60_000) {
            await bridge.collect();
            lastCollection = now();
          }
          blocked = null;
        } catch (error) {
          clearHints();
          if (error === deferredBlock) { /* Keep the exact pending intent and visible blocked state. */ }
          else if (isWaiting(error)) {
            blocked = null;
            const state = await bridge.status();
            wait(error, { scope: 'coordinator',
              ...conversationContext(state, state.pending?.record?.conversationId ?? error.conversationId) });
            if (events) {
              const retry = eventBatch?.length ? eventBatch : [{ side: 'codex', nativeId: RECONNECT_ID, kind: 'reconnect' }];
              for (const event of retry) deferEvent(event, event.retryAttempt ?? 0);
            }
          }
          else if (isHistoryBlocked(error)) {
            const state = await bridge.status(), pending = state.pending;
            const conversationId = pending?.record?.conversationId ?? error.conversationId ?? null;
            blocked = block(blocked, error, { scope: pending ? 'pending' : 'coordinator',
              conversationId, ...conversationContext(state, conversationId),
              operationId: pending?.operationId ?? null, phase: pending?.phase ?? null });
          } else throw error;
        }
        await status({ waiting, waitingContexts, blockedSourceCount, blockedSources });
        if (!signal?.aborted && passes < maxPasses) {
          if (events) {
            if (eventBatch) await events.acknowledge(eventBatch);
            awaitingEvents = true;
            await writeProgress();
            // Only liveness metadata is refreshed while idle. No history reads,
            // discovery, archive proof renewal or synchronization runs here.
            let heartbeatError;
            const idleStop = new AbortController();
            const heartbeat = (async () => {
              while (!idleStop.signal.aborted) {
                try { await delay(30_000, undefined, { signal: idleStop.signal }); }
                catch (error) { if (error.name === 'AbortError') return; throw error; }
                if (!idleStop.signal.aborted) await writeProgress();
              }
            })().catch(error => { heartbeatError = error; idleStop.abort(); });
            const abortIdle = () => idleStop.abort();
            signal?.addEventListener('abort', abortIdle, { once: true });
            if (signal?.aborted) idleStop.abort();
            try {
              const nextDue = Math.min(...[...deferredEvents.values()].map(value => value.due));
              eventBatch = await events.wait({ signal: idleStop.signal,
                ...(Number.isFinite(nextDue) ? { timeoutMs: Math.max(0, nextDue - now()) } : {}) });
              if (heartbeatError) throw heartbeatError;
              const freshKeys = new Set(eventBatch.map(eventKey));
              for (const [key, pending] of deferredEvents) {
                if (freshKeys.has(key)) deferredEvents.delete(key);
                else if (pending.due <= now()) {
                  eventBatch.push({ ...pending.event, retryAttempt: pending.attempt }); deferredEvents.delete(key);
                }
              }
              if (eventBatch.length) { eventWakeCount++; lastEventAt = now(); }
            } finally {
              idleStop.abort(); await heartbeat;
              signal?.removeEventListener('abort', abortIdle);
              awaitingEvents = false;
            }
            continue;
          }
          // Abortable, bounded sleep prevents a broken persisted history from
          // causing a hot recover loop. Normal healthy polling stays unchanged.
          const pauseMs = blocked ? Math.max(pollMs, Math.min(60_000, blocked.retryAt - now())) : pollMs;
          try { await sleep(pauseMs, { signal }); }
          catch (error) { if (error.name !== 'AbortError' || !signal?.aborted) throw error; }
        }
      }
      await writeStatus(statusPath, { mode: 'desktop', running: false, pid: process.pid, startedAt, stoppedAt: now(), error: null,
        ...blockingStatus() });
    } catch (error) {
      await writeStatus(statusPath, { mode: 'desktop', running: false, pid: process.pid, startedAt, stoppedAt: now(), error: reason(error) });
      // A busy ClaudeOwner must keep its live handle; closing it can interrupt user work.
      throw error;
    }
  }, { recoverDead: true });
}
