import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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
import { activeDesktopState, activeDesktopConversationIds, isDesktopTracked } from './desktop-enrollment.mjs';
import { handleClaudeOwnerWake } from './claude-owner-wake.mjs';
import { syncEventKey } from './sync-events.mjs';
import { startClaudeRendererMaintenance } from './claude-renderer-maintenance.mjs';
import { claudeCacheDirectory } from './claude-frontend-graph.mjs';

const WAITING = /still running|complete assistant|no completed persisted history|in-progress turn|unfinished|incomplete final|incomplete final line|empty or invalid conversation|transcript changed while being read|source history changed between complete reads|active writer|destination is active|Claude turn is still running|Claude Code is open|another bridge operation|shared Codex Desktop backend is not ready|shared Codex transport (?:closed|failed|is not connected)|could not connect to the shared Codex transport|transport unavailable|socket.*(?:unavailable|closed|disconnected)|ECONNREFUSED|ECONNRESET|ENOENT.*socket/i;
const UNSUPPORTED = /Codex compaction|Compacted Codex history|Referenced Codex history|Claude compaction|Dependent Claude history|Forked Claude history|Nonlinear Claude history|Missing or dependent Codex history|working directory changed|turn was interrupted|Unsupported message role|Duplicate open tool call|Unpaired tool result|External image references|Artifact handoffs|^Native Codex local image recovery: |^Native Codex history export: (?:unsupported user input or external asset; nothing was silently omitted\.|(?:converted )?byte limit exceeded; no partial export is returned\.|a completed turn (?:lacks its final assistant response|has no persisted items)\.)(?: \[Codex thread [a-f0-9-]+\])?$/i;
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
const isUnsupported = error => error?.code === 'CLAUDEX_NATIVE_CWD_UNAVAILABLE' || UNSUPPORTED.test(reason(error))
  || /^Native Codex empty turn: /.test(reason(error))
  || /^Native Codex history export: an assistant message precedes the turn user input\.(?: \[Codex thread [a-f0-9-]+\])?$/i.test(reason(error));
const isHistoryBlocked = error => error?.code === 'CLAUDEX_ORIGINAL_ARCHIVE_BLOCKED'
  || error?.code === 'CLAUDEX_DEPENDENCY_ANCHOR_BLOCKED'
  || error?.code === 'CLAUDEX_TRACKED_HISTORY_UNAVAILABLE'
  || error?.code === 'CLAUDEX_TRACKED_CWD_UNAVAILABLE'
  || error?.code === 'CLAUDEX_TRACKING_STOP_BLOCKED'
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
  heartbeatSleep = (ms, options) => delay(ms, undefined, options),
  now = () => Date.now(), maxPasses = Infinity, coldValidationMs = 60_000,
  blockedRetryMs = 30_000,
  writeStatus = writeDiagnosticJSON,
  verificationCache,
  events,
  publishFolders = publishClaudeFolderMap,
  createHandoffPublisher = createClaudeDesktopHandoffPublisher,
  startRendererMaintenance = startClaudeRendererMaintenance,
  claudeRelaunch,
  maintainFolders = async options => (await import('./claude-folder-presentation-cache.mjs')).ensureClaudeFolderPresentationCache(options) }) {
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
  const eventKey = syncEventKey;
  let ownerWake = { handled: 0, woken: 0, ignored: 0, lastReason: null };
  const deferEvent = (event, attempt = 0) => {
    const delays = [250, 1000, 3000];
    if (attempt < delays.length) deferredEvents.set(eventKey(event), { event, attempt: attempt + 1, due: now() + delays[attempt] });
  };
  let blocked = null;
  const blockedConversations = new Map();
  const deferredBlock = Symbol('deferred history revalidation');
  // Allocation-time collection holds another conversation that fails its own
  // verification instead of stopping the delivery. Keep those holds visible.
  let collectionHolds = null, reportedHolds = new Set();
  const reflectCollectionHolds = async bridge => {
    const holds = bridge.collectionHolds;
    if (!(holds instanceof Map) || holds === collectionHolds) return;
    collectionHolds = holds;
    const state = await bridge.status();
    for (const id of reportedHolds) if (!holds.has(id)) blockedConversations.delete(id);
    reportedHolds = new Set(holds.keys());
    for (const [id, error] of holds)
      blockedConversations.set(id, block(blockedConversations.get(id), error, conversationContext(state, id)));
  };
  const deletedSource = Symbol('deleted discovered source');
  const block = (previous, error, fields) => ({ ...fields, reason: reason(error),
    ...(error?.code === 'CLAUDEX_TRACKED_HISTORY_UNAVAILABLE' ? { historyUnavailable: {
      side: error.side, nativeId: error.nativeId, savedPath: String(error.savedPath).slice(0, 4096),
      conversationId: error.conversationId ?? null,
    } } : {}),
    ...(['CLAUDEX_TRACKED_CWD_UNAVAILABLE', 'CLAUDEX_TRACKING_STOP_BLOCKED'].includes(error?.code) ? { workingDirectoryUnavailable: {
      side: error.side, nativeId: error.nativeId, savedCwd: String(error.savedCwd).slice(0, 4096),
      conversationId: error.conversationId ?? null,
      ...(['missing', 'alias', 'unresolved'].includes(error.workingDirectoryReason) ? { reason: error.workingDirectoryReason } : {}),
      ...(error.code === 'CLAUDEX_TRACKING_STOP_BLOCKED' ? { autoStopFailed: true } : {}),
    } } : {}),
    since: previous?.since ?? now(), lastAttemptAt: now(), retryAt: now() + blockedRetryMs,
    attempts: Math.min(Number.MAX_SAFE_INTEGER, (previous?.attempts ?? 0) + 1) });
  // Several held callers can report the same conversation's global guard;
  // present each actually blocked conversation once.
  const blockingStatus = () => {
    const unique = new Map();
    for (const [id, entry] of blockedConversations) unique.set(entry.conversationId ?? id, entry);
    return { blocked, blockedConversationCount: unique.size, blockedConversations: [...unique.values()].slice(0, 20) };
  };
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
    if (!isDesktopTracked(state.conversations[id])) { activeObserved.delete(id); activeDirty.delete(id); return; }
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
  let blockedSourceDiagnostics = new Map();
  // Sources whose working directory is confirmed absent on this Mac (a remote
  // SSH session, a deleted project) have nothing to enroll and need no action.
  let absentSourceDiagnostics = new Map();
  let latestFields = { waiting: null, waitingContexts: [], blockedSourceCount: 0, blockedSources: [] };
  let folderProjection = null, folderMapProjection = null;
  let lastFolderMaintenance = null, folderResource = null, folderResourceError = null;
  let rendererAdapters = null;
  const autoRenderers = config.rendererAdapters?.enabled !== false && (config.rendererAdapters?.enabled === true
    || config.folderProjection?.enabled === true && typeof config.folderProjection.cachePath === 'string'
      && dirname(config.folderProjection.cachePath) === claudeCacheDirectory());
  // The map publication and renderer resources have independent lifecycles.
  // Resource notifications may refresh presentation, never its map proof/time
  // or an unrelated mapping failure. Idle heartbeats publish this current view.
  const refreshFolderProjection = () => {
    if (!folderMapProjection || folderMapProjection.state === 'error') {
      folderProjection = folderMapProjection;
      return;
    }
    folderProjection = { ...folderMapProjection, resource: folderResource,
      ...(folderResourceError ? { state: 'error', error: folderResourceError }
        : ['checking', 'held'].includes(rendererAdapters?.state) && folderMapProjection.state === 'ready'
          ? { state: 'waiting' } : {}) };
  };
  const updateRendererStatus = value => {
    rendererAdapters = value;
    folderResource = value?.adapters?.folders ?? null;
    folderResourceError = ['checking', 'held'].includes(value?.state) ? null : folderResource?.status === 'skipped' ? folderResource.reason
      : value?.state === 'skipped' ? value.reason : null;
    refreshFolderProjection();
  };
  let localHandoff = null;
  const handoffs = config.desktopLocalHandoff?.enabled === true ? createHandoffPublisher({ root,
    desktopHome: config.desktopHome ?? join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
    inspect: async record => {
      const data = await bridge.inspect(record);
      if (record.managed && record.kind === 'owner') {
        const owner = runtime.owners?.get(record.conversationId)?.owner;
        const state = owner?.status();
        if (!state || state.nativeState !== 'idle' || state.backgroundTasks?.length || state.pending || state.reset)
          throw Object.assign(new Error('Claude replacement has no verified idle owner; Local archival is postponed.'),
            { code: 'CLAUDEX_HANDOFF_OWNER_NOT_IDLE', conversationId: record.conversationId });
      }
      return data;
    } }) : null;
  let lastProgressAt = null, lastProgressHealth = null, publishedFirstOperation = false;
  const writeProgress = async () => {
    const timestamp = now();
    const hookBlock = hookStatus && !hookStatus.ready ? { scope: 'hooks', reason: hookStatus.reason } : null;
    const progress = { mode: 'desktop', running: true, pid: process.pid,
    scheduler: events ? 'completion-events' : 'activity-interleaved', startedAt, updatedAt: now(),
    ...(events ? { eventWakeCount, eventSyncCount, lastEventAt, awaitingEvents, eventSources: events.metrics, hookStatus, ownerWake } : {}),
    versionPolicy: runtime.versionPolicy ?? config.versionPolicy ?? 'strict',
    versionWarnings: runtime.versionWarnings?.() ?? [], foregroundCompletedAt, foregroundDurationMs, initialSweepCompletedAt,
    discoveryCompletedAt, discoveryDurationMs, maxDiscoveryGapMs, lastSync, slowestSync,
    currentOperation, checkingConversationCount, checkedConversationCount: checkedConversations.size,
    reusedVerificationCount: reusedConversations.size, fullVerificationCount,
    activePrioritySyncs, activeDirtyCount: activeDirty.size, folderProjection, localHandoff, rendererAdapters,
    synchronization: blocked || hookBlock ? 'blocked' : blockedConversations.size ? 'degraded' : latestFields.waiting ? 'waiting' : 'ready',
    ...blockingStatus(), ...latestFields, blocked: blocked ?? hookBlock,
    absentSourceCount: absentSourceDiagnostics.size, absentSources: [...absentSourceDiagnostics.values()].slice(0, 20) };
    const guardHealth = value => value && Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['since', 'lastAttemptAt', 'retryAt', 'attempts'].includes(key)));
    const presentationHealth = value => value && { state: value.state, error: value.error, deferred: value.deferred };
    const health = JSON.stringify({ synchronization: progress.synchronization, awaitingEvents, ownerWake,
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
  let lastEmptyPresentationKey = null;
  const status = async (fields, { configurationOnly = false } = {}) => {
    latestFields = fields;
    const foldersEnabled = config.folderProjection?.enabled === true;
    if (!handoffs && !foldersEnabled) return writeProgress();
    let state;
    try { state = await bridge.status(); }
    catch (error) {
      lastEmptyPresentationKey = null;
      if (handoffs) localHandoff = { state: 'error', error: reason(error), updatedAt: now() };
      if (foldersEnabled) {
        folderMapProjection = { state: 'error', error: reason(error), updatedAt: now() };
        refreshFolderProjection();
      }
      return writeProgress();
    }
    const emptyScope = Array.isArray(presentationScope) && presentationScope.length === 0;
    const key = emptyScope && !state.pending ? JSON.stringify(state) : null;
    // Configuration hints recheck hooks, not native presentation histories.
    // Reuse only after an empty scope successfully revoked archive commands.
    // Leave timestamps and proof lifetimes untouched, just like idle status.
    if (configurationOnly && key !== null && key === lastEmptyPresentationKey) return writeProgress();
    lastEmptyPresentationKey = null;
    if (handoffs) {
      try {
        const result = await handoffs.publish(state, presentationScope === undefined ? {} : { conversationIds: presentationScope });
        localHandoff = { ...result, state: ['history_changed', 'owner_not_idle'].includes(result.deferred) ? 'waiting' : 'ready', updatedAt: now() };
      }
      catch (error) { localHandoff = { state: 'error', error: reason(error), updatedAt: now() }; }
    }
    if (foldersEnabled) {
      try {
        const map = await publishFolders({ root, state });
        // Rows whose project directory moved or disappeared are omitted, not errors.
        folderMapProjection = { state: map.deferred ? 'deferred' : 'ready', entries: map.entries,
          deferred: map.deferred, updatedAt: now(),
          ...(map.unavailableCount ? { unavailableCount: map.unavailableCount, unavailable: map.unavailable } : {}) };
        if (!autoRenderers && (lastFolderMaintenance === null || now() - lastFolderMaintenance >= 60_000)) {
          lastFolderMaintenance = now();
          try {
            folderResource = await maintainFolders({ root, cachePath: config.folderProjection.cachePath });
            folderResourceError = null;
          } catch (error) { folderResourceError = reason(error); }
        }
      } catch (error) {
        // Presentation failures remain explicit without interrupting native
        // user work or changing the conversation coordinator's write guards.
        folderMapProjection = { state: 'error', error: reason(error), updatedAt: now() };
      }
      refreshFolderProjection();
    }
    if (key !== null && (!handoffs || localHandoff?.state === 'ready' && localHandoff.actions === 0 && !localHandoff.deferred)
      && (!foldersEnabled || folderProjection?.state === 'ready')) lastEmptyPresentationKey = key;
    return writeProgress();
  };
  return withLock(join(root, 'watch.lock'), async () => {
    let rendererMaintenance;
    try {
      if (autoRenderers) rendererMaintenance = await startRendererMaintenance({ root,
        folders: config.folderProjection?.enabled === true, signal,
        watchAppStop: events?.watchAppStop,
        afterPass: config.rendererAdapters?.relaunchAfterUpdate === false ? undefined : claudeRelaunch?.consider,
        onStatus: updateRendererStatus });
      await status({ waiting: null, waitingContexts: [], blockedSourceCount: 0, blockedSources: [] });
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
        let blockedSourceCount = blockedSourceDiagnostics.size;
        const blockedSources = [...blockedSourceDiagnostics.values()].slice(0, 20);
        let configurationOnly = false;
        let ownerWakeOnly = false;
        if (events && eventBatch) {
          eventBatch = await events.current?.(eventBatch) ?? eventBatch;
          const wakes = eventBatch.filter(event => event.kind === 'owner-wake');
          for (const event of wakes) {
            if (signal?.aborted) break;
            let result;
            try { result = await handleClaudeOwnerWake({ root, bridge, runtime, event, blocked, blockedConversations }); }
            catch (error) { result = { ignored: reason(error) }; }
            ownerWake = { handled: ownerWake.handled + 1, woken: ownerWake.woken + (result.woken ? 1 : 0),
              ignored: ownerWake.ignored + (result.woken ? 0 : 1), lastReason: result.ignored ?? null };
          }
          ownerWakeOnly = wakes.length > 0 && wakes.length === eventBatch.length;
        }
        if (!ownerWakeOnly) try {
          // A pending transaction remains the only allowed native operation.
          // Waiting out this backoff does not clear it or allocate a new target.
          if (blocked && now() < blocked.retryAt && !events) throw deferredBlock;
          // The transport is a prerequisite. Never enroll a source while it is absent.
          const codex = await runtime.codex();
          if (events && runtime.synchronizationHooks) hookStatus = await runtime.synchronizationHooks();
          const cacheContext = proofCache ? await runtime.verificationCacheContext() : null;
          const stopMissing = async id => {
            // Injected legacy test bridges may omit the metadata-only API.
            const enrollment = await bridge.untrack?.(id, { missingWorkingDirectoryOnly: true });
            if (enrollment?.tracking === 'stopped') {
              for (const cache of [coldHints, coldObserved, coldDirty, activeObserved, activeDirty]) cache.delete(id);
              for (const [key, entry] of blockedConversations)
                if (key === id || entry.conversationId === id) blockedConversations.delete(key);
              checkedConversations.delete(id); reusedConversations.delete(id);
              checkingConversationCount = activeDesktopConversationIds(await bridge.status()).length;
              if (proofCache) await proofCache.invalidate(id);
            }
            return enrollment;
          };
          const sync = async id => {
            if (blockedConversations.has(id) && now() < blockedConversations.get(id).retryAt && !events) return { blocked: true };
            try {
              const state = await bridge.status();
              if (state.pending) { clearHints(); await bridge.recover(); return { recovered: true }; }
              // Before any cached proof or native read, stop only enrollment
              // when the locked bridge confirms an exact saved cwd is absent.
              const enrollment = await stopMissing(id);
              if (enrollment?.tracking === 'stopped') return enrollment;
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
                  try { await heartbeatSleep(10_000, { signal: heartbeatStop.signal }); }
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
                await reflectCollectionHolds(bridge);
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
              // A global allocation guard can encounter a different missing
              // project before its scheduled sync. Confirm that exact ledger
              // entry now so it cannot starve the remaining startup queue.
              const missingId = error.conversationId ?? id;
              if (error?.code === 'CLAUDEX_TRACKED_CWD_UNAVAILABLE' && latest.conversations[missingId]) {
                const enrollment = await stopMissing(missingId);
                if (enrollment?.tracking === 'stopped') {
                  if (missingId === id) return enrollment;
                  activeDirty.add(id); // Enrollment changed; normal fair scheduling rechecks this caller.
                  return { changed: false, stoppedConversationId: missingId };
                }
              }
              if (isWaiting(error)) {
                if (activeDirty.delete(id)) activeDirty.add(id); // Busy work yields to the next dirty owner.
                const waitingId = error.conversationId ?? id;
                wait(error, { scope: waitingId === id ? 'conversation' : 'coordinator',
                  ...conversationContext(latest, waitingId) });
                // The startup sweep has no event to retry. Give its own wait the
                // same bounded follow-ups a completion event gets, so a brief
                // race cannot leave an offline completion undelivered.
                const current = events && broadPass && waitingId === id
                  && latest.records.find(record => record.conversationId === id && record.status === 'current');
                if (current) deferEvent({ side: current.side, nativeId: current.nativeId, kind: 'completed' }, 0);
                return { waiting: true };
              }
              if (isHistoryBlocked(error)) {
                // An allocation's global original/retention guard can identify
                // another conversation. Keep that coordinator-wide source hold
                // attached to its actual identity instead of the caller's title.
                if (['CLAUDEX_TRACKED_HISTORY_UNAVAILABLE', 'CLAUDEX_TRACKED_CWD_UNAVAILABLE', 'CLAUDEX_TRACKING_STOP_BLOCKED', 'CLAUDEX_CLAUDE_RELOCATION_BLOCKED',
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
              if (signal?.aborted || error?.name === 'AbortError' || !(error instanceof Error)) throw error;
              // No durable intent exists (checked above), the ledger was just
              // read and the backend still answers, so this failure belongs to
              // one conversation. Hold it visibly with its own reason instead
              // of ending the worker for every conversation. Nothing is retried
              // or reported as synchronized.
              await runtime.codex();
              blockedConversations.set(id, block(blockedConversations.get(id), error, conversationContext(latest,
                typeof error.conversationId === 'string' && latest.conversations[error.conversationId] ? error.conversationId : id)));
              return { blocked: true };
            }
          };
          const discoverNew = async onlyKeys => {
            const beganAt = now();
            let state = await bridge.status();
            if (state.pending) { clearHints(); await bridge.recover(); }
            state = await bridge.status();
            checkingConversationCount = activeDesktopConversationIds(state).length;
            for (const id of checkedConversations) if (!state.conversations[id] || !isDesktopTracked(state.conversations[id])) checkedConversations.delete(id);
            const existing = new Set(Object.keys(state.conversations));
            const known = new Set(state.records.map(record => `${record.side}:${record.nativeId}`));
            for (const id of await runtime.ownedNativeIds()) known.add(id);
            // Event-filtered discovery reads only the notified sources' transcripts;
            // each candidate's identity is still derived and checked below.
            const candidates = await discover({ ...config, allProjects: true, projects: [], excludeSubagents: false,
              ...(onlyKeys ? { onlyKeys } : {}) }, known);
            // A full discovery replaces its snapshot. A targeted discovery may
            // resolve only its exact identities; unrelated events cannot erase
            // an unsupported source that was never rechecked.
            const nextBlockedSources = onlyKeys ? new Map(blockedSourceDiagnostics) : new Map();
            const nextAbsentSources = onlyKeys ? new Map(absentSourceDiagnostics) : new Map();
            if (onlyKeys) for (const sources of [nextBlockedSources, nextAbsentSources]) for (const [key, entry] of sources)
              if (entry.nativeId && onlyKeys.has(`${entry.side}:${entry.nativeId.toLowerCase()}`)) sources.delete(key);
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
                const absent = error.code === 'CLAUDEX_NATIVE_CWD_UNAVAILABLE' && error.workingDirectoryReason === 'missing';
                (absent ? nextAbsentSources : nextBlockedSources).set(`${source.side}:${source.path}`, { side: source.side, path: source.path,
                  ...(typeof nativeId === 'string' && nativeId ? { nativeId } : {}), reason: reason(error) });
              }
            }
            blockedSourceDiagnostics = nextBlockedSources;
            absentSourceDiagnostics = nextAbsentSources;
            blockedSourceCount = blockedSourceDiagnostics.size;
            blockedSources.splice(0, blockedSources.length, ...[...blockedSourceDiagnostics.values()].slice(0, 20));
            state = await bridge.status();
            checkingConversationCount = activeDesktopConversationIds(state).length;
            const completedAt = now();
            if (discoveryCompletedAt !== null) maxDiscoveryGapMs = Math.max(maxDiscoveryGapMs, completedAt - discoveryCompletedAt);
            discoveryCompletedAt = completedAt;
            discoveryDurationMs = completedAt - beganAt;
            return activeDesktopConversationIds(state).filter(id => !existing.has(id));
          };
          const interleavedDiscovery = new Map();
          const interleavedServiced = new Map();
          let interleavedSequence = 0;
          const refreshCompletion = async nextId => {
            if (signal?.aborted || !events.peek) return;
            let batch = await events.peek();
            batch = await events.current?.(batch) ?? batch;
            let state = await bridge.status();
            if (state.pending) { clearHints(); await bridge.recover(); state = await bridge.status(); }
            await events.observe(batch, activeDesktopState(state));
            const pendingKeys = new Set(batch.map(eventKey));
            // Keep only the current inbox's bounded identities, never a growing
            // history of processed or unenrollable native sessions.
            for (const key of interleavedDiscovery.keys()) if (!pendingKeys.has(key)) interleavedDiscovery.delete(key);
            for (const key of interleavedServiced.keys()) if (!pendingKeys.has(key)) interleavedServiced.delete(key);
            const actionable = batch.filter(event => ['completed', 'idle', 'interrupted', 'changed', 'session'].includes(event.kind))
              .sort((left, right) => (interleavedServiced.get(eventKey(left)) ?? 0) - (interleavedServiced.get(eventKey(right)) ?? 0)
                || (left.at ?? 0) - (right.at ?? 0));
            const known = new Set(state.records.map(record => `${record.side}:${record.nativeId?.toLowerCase()}`));
            const unknown = actionable.filter(event => !known.has(eventKey(event))
              && interleavedDiscovery.get(eventKey(event)) !== event.revision);
            if (unknown.length) {
              for (const event of unknown) interleavedDiscovery.set(eventKey(event), event.revision);
              await discoverNew(new Set(unknown.map(eventKey)));
              state = await bridge.status();
            }
            // A completed revision can be superseded by started while discovery
            // awaits. Do not turn stale completion into a streaming inspection.
            const current = await events.current?.(actionable) ?? actionable;
            const targets = new Map();
            for (const event of current) for (const record of state.records) {
              if (`${record.side}:${record.nativeId?.toLowerCase()}` !== eventKey(event)
                || event.kind === 'session' && known.has(eventKey(event)) && record.managed
                || record.conversationId === nextId || !state.conversations[record.conversationId]
                || !isDesktopTracked(state.conversations[record.conversationId])) continue;
              const sourceEvents = targets.get(record.conversationId) ?? [];
              sourceEvents.push(event); targets.set(record.conversationId, sourceEvents);
            }
            const selected = targets.entries().next().value;
            if (!selected || signal?.aborted) return;
            const [id, sourceEvents] = selected;
            for (const event of sourceEvents) interleavedServiced.set(eventKey(event), ++interleavedSequence);
            eventWaits.delete(id);
            for (let index = waitingContexts.length - 1; index >= 0; index--)
              if (waitingContexts[index].conversationId === id) waitingContexts.splice(index, 1);
            waiting = waitingContexts[0]?.reason ?? null;
            eventSyncCount++;
            const result = await sync(id);
            for (const event of sourceEvents) {
              deferredEvents.delete(eventKey(event));
              if (event.kind !== 'session' && (result?.waiting || result?.incompleteTail || result?.changed === false))
                deferEvent(event, event.retryAttempt ?? 0);
            }
            await events.observe(sourceEvents, activeDesktopState(await bridge.status()));
            // Only these revisions were inspected. Newer streaming/completion
            // hints and unrelated control work remain durable for the outer loop.
            await events.acknowledge(sourceEvents);
            await status({ waiting, waitingContexts, blockedSourceCount, blockedSources });
          };
          // A whole foreground sweep can itself take tens of seconds. Discover
          // new work and observe existing active files between operations. One
          // dirty active owner may jump ahead per boundary; the fixed sweep still
          // advances, and managed lifecycle checks are never skipped by metadata.
          const refreshNew = async nextId => {
            if (events) return refreshCompletion(nextId);
            if (signal?.aborted || now() - discoveryCompletedAt < Math.max(1, pollMs)) return;
            const fresh = await discoverNew();
            for (const id of fresh) {
              if (signal?.aborted) break;
              // After enrollment, errors belong to a tracked history. Keep this
              // outside discovery's unsupported-source warning handler.
              await sync(id);
            }
            const latest = await bridge.status();
            for (const id of activeDesktopConversationIds(latest)) {
              await observeActive(latest, id);
              const hint = await coldImportHint(latest, id);
              if (coldObserved.has(id) && hint !== coldObserved.get(id)) coldDirty.add(id);
              if (hint) coldObserved.set(id, hint);
              else if (usesActiveHints(latest, id)) coldObserved.delete(id);
            }
            for (const id of activeDirty) if (!latest.conversations[id] || !isDesktopTracked(latest.conversations[id])) { activeDirty.delete(id); activeObserved.delete(id); }
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
              for (const id of cache.keys()) if (!state.conversations[id] || !isDesktopTracked(state.conversations[id])) cache.delete(id);
            }
            const dirty = [], active = [], background = [];
            for (const id of activeDesktopConversationIds(state)) {
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
            configurationOnly = eventBatch.length > 0 && eventBatch.every(event => event.kind === 'configuration');
            let state = await bridge.status();
            if (state.pending) { configurationOnly = false; clearHints(); await bridge.recover(); state = await bridge.status(); }
            await events.observe(eventBatch, activeDesktopState(state));
            const relevant = eventBatch.filter(event => !['started', 'configuration', 'owner-wake'].includes(event.kind));
            const keys = new Set(relevant.map(eventKey));
            const known = new Set(state.records.map(record => `${record.side}:${record.nativeId?.toLowerCase()}`));
            if ([...keys].some(key => !known.has(key))) await discoverNew(keys);
            state = await bridge.status();
            for (const event of relevant) if (event.kind !== 'session'
              && !state.records.some(record => `${record.side}:${record.nativeId?.toLowerCase()}` === eventKey(event)))
              deferEvent(event, event.retryAttempt ?? 0);
            await events.observe(eventBatch, activeDesktopState(state));
            const targets = new Map();
            for (const event of relevant) for (const record of state.records) {
              if (`${record.side}:${record.nativeId?.toLowerCase()}` !== eventKey(event)) continue;
              // Session-start notifications also describe our own snapshot registration.
              if (event.kind === 'session' && known.has(eventKey(event)) && record.managed) continue;
              if (state.conversations[record.conversationId] && isDesktopTracked(state.conversations[record.conversationId])) {
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
              if (result?.tracking !== 'stopped' && (result?.waiting || result?.incompleteTail || result?.changed === false)) {
                for (const event of sourceEvents) if (event.kind !== 'session') deferEvent(event, event.retryAttempt ?? 0);
              }
            }
            await events.observe(eventBatch, activeDesktopState(await bridge.status()));
          }
          if (!signal?.aborted && initialSweepCompletedAt === null) initialSweepCompletedAt = now();
          if (!signal?.aborted && broadPass && now() - lastCollection >= 60_000) {
            await bridge.collect();
            await reflectCollectionHolds(bridge);
            lastCollection = now();
          }
          blocked = null;
        } catch (error) {
          configurationOnly = false;
          clearHints();
          if (error === deferredBlock) { /* Keep the exact pending intent and visible blocked state. */ }
          else if (isWaiting(error)) {
            blocked = null;
            const state = await bridge.status();
            wait(error, { scope: 'coordinator',
              ...conversationContext(state, state.pending?.record?.conversationId ?? error.conversationId) });
            if (events) {
              const retry = eventBatch?.length ? eventBatch.filter(event => event.kind !== 'owner-wake') : [{ side: 'codex', nativeId: RECONNECT_ID, kind: 'reconnect' }];
              for (const event of retry) deferEvent(event, event.retryAttempt ?? 0);
            }
          }
          else {
            const state = await bridge.status(), pending = state.pending;
            const known = isHistoryBlocked(error);
            if (!known && (!pending || signal?.aborted || error?.name === 'AbortError' || !(error instanceof Error))) throw error;
            const conversationId = pending?.record?.conversationId ?? error.conversationId ?? null;
            // A delivery that failed before writing anything natively is
            // dropped and held on its own conversation. Otherwise the single
            // pending transaction stays, visibly blocked and retried by the
            // next pass, instead of ending the worker into the same failure.
            const abandoned = pending ? await Promise.resolve().then(() => bridge.abandonUnapplied?.()).catch(() => null) : null;
            if (abandoned?.abandoned) {
              blocked = null;
              blockedConversations.set(conversationId, block(blockedConversations.get(conversationId), error, conversationContext(state, conversationId)));
            } else blocked = block(blocked, error, { scope: pending ? 'pending' : 'coordinator',
              conversationId, ...conversationContext(state, conversationId),
              operationId: pending?.operationId ?? null, phase: pending?.phase ?? null });
          }
        }
        // Activation alone keeps the last synchronization report and never
        // renews archival proofs or performs presentation history inspection.
        if (ownerWakeOnly) await writeProgress();
        else await status({ waiting, waitingContexts, blockedSourceCount, blockedSources }, { configurationOnly });
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
                try { await heartbeatSleep(30_000, { signal: idleStop.signal }); }
                catch (error) { if (error.name === 'AbortError') return; throw error; }
                if (!idleStop.signal.aborted) await writeProgress();
              }
            })().catch(error => { heartbeatError = error; idleStop.abort(); });
            const abortIdle = () => idleStop.abort();
            signal?.addEventListener('abort', abortIdle, { once: true });
            if (signal?.aborted) idleStop.abort();
            try {
              let ownersHeld = false;
              for (;;) {
                const nextDue = Math.min(...[...deferredEvents.values()].map(value => value.due));
                // Idle Claude owners are closed while waiting; never during a
                // pending transaction, which must recover with its live owner.
                const ownerIdleAt = ownersHeld ? Infinity : runtime.nextOwnerIdleAt?.() ?? Infinity;
                const wake = Math.min(nextDue, ownerIdleAt);
                eventBatch = await events.wait({ signal: idleStop.signal,
                  ...(Number.isFinite(wake) ? { timeoutMs: Math.max(0, wake - now()) } : {}) });
                if (heartbeatError) throw heartbeatError;
                if (eventBatch.length || idleStop.signal.aborted || nextDue <= now() || ownerIdleAt > now()) break;
                if ((await bridge.status()).pending) { ownersHeld = true; continue; }
                await runtime.closeIdleOwners();
                await writeProgress();
              }
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
    } finally { await rendererMaintenance?.close(); }
  }, { recoverDead: true });
}
