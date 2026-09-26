import { join } from 'node:path';
import { coldImportHint, coldImportInactive } from './desktop-watch-hints.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { codexSessionId, discoverSources, isCodexSubagentSource } from './discovery.mjs';
import { withLock, writeJSON } from './storage.mjs';
import { publishClaudeFolderMap } from './claude-folder-map.mjs';

const WAITING = /still running|complete assistant|no completed persisted history|in-progress turn|unfinished|incomplete final|incomplete final line|empty or invalid conversation|transcript changed while being read|source history changed between complete reads|active writer|destination is active|Claude turn is still running|Claude Code is open|another bridge operation|shared Codex Desktop backend is not ready|shared Codex transport (?:closed|failed|is not connected)|could not connect to the shared Codex transport|transport unavailable|socket.*(?:unavailable|closed|disconnected)|ECONNREFUSED|ECONNRESET|ENOENT.*socket/i;
const UNSUPPORTED = /Codex compaction|Compacted Codex history|Referenced Codex history|Claude compaction|Dependent Claude history|Nonlinear Claude history|Missing or dependent Codex history|working directory changed|turn was interrupted|Unsupported message role|Duplicate open tool call|Unpaired tool result|External image references|Artifact handoffs|^Native Codex local image recovery: |^Native Codex history export: (?:unsupported user input or external asset; nothing was silently omitted\.|(?:converted )?byte limit exceeded; no partial export is returned\.|a completed turn (?:lacks its final assistant response|has no persisted items)\.)$/i;
const reason = error => String(error?.message ?? error).slice(0, 500);
const isWaiting = error => WAITING.test(reason(error));
const isUnsupported = error => UNSUPPORTED.test(reason(error));

/** Run the opt-in Desktop coordinator under the same lock as the legacy watcher. */
export async function runDesktopWatch({ root, bridge, runtime, config, signal, pollMs = 2000,
  discover = discoverSources, sleep = (ms, options) => delay(ms, undefined, options),
  now = () => Date.now(), maxPasses = Infinity, coldValidationMs = 60_000,
  publishFolders = publishClaudeFolderMap,
  maintainFolders = async options => (await import('./claude-folder-install.mjs')).ensureClaudeFolderCache(options) }) {
  if (!root || !bridge || !runtime || !config) throw new Error('Desktop watcher requires root, bridge, runtime, and discovery configuration.');
  if (!Number.isInteger(pollMs) || pollMs < 0 || !(maxPasses > 0)) throw new Error('Invalid Desktop watcher interval or pass limit.');
  if (!Number.isInteger(coldValidationMs) || coldValidationMs < 1) throw new Error('Invalid cold-import validation interval.');
  const statusPath = join(root, 'watcher-status.json');
  const startedAt = now();
  let lastCollection = startedAt;
  let passes = 0;
  // Ephemeral scheduling hints only. Durable checkpoints are never inferred
  // from file metadata, and every process starts with full verification.
  const coldHints = new Map();
  // Observations only select priority; unlike coldHints, they never authorize
  // skipping verification. Keep unsuccessful dirty work in the foreground.
  const coldObserved = new Map();
  const coldDirty = new Set();
  const clearHints = () => { coldHints.clear(); coldObserved.clear(); coldDirty.clear(); };
  let foregroundCompletedAt = null;
  let foregroundDurationMs = null;
  let discoveryCompletedAt = null;
  let discoveryDurationMs = null;
  let maxDiscoveryGapMs = 0;
  let lastSync = null;
  let slowestSync = null;
  let folderProjection = null, lastFolderMaintenance = null, folderResource = null, folderResourceError = null;
  const status = async fields => {
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
    return writeJSON(statusPath, { mode: 'desktop', running: true, pid: process.pid,
    scheduler: 'operation-interleaved',
    startedAt, updatedAt: now(), versionPolicy: runtime.versionPolicy ?? config.versionPolicy ?? 'strict',
    versionWarnings: runtime.versionWarnings?.() ?? [], foregroundCompletedAt, foregroundDurationMs,
    discoveryCompletedAt, discoveryDurationMs, maxDiscoveryGapMs, lastSync, slowestSync, folderProjection, ...fields });
  };
  return withLock(join(root, 'watch.lock'), async () => {
    await status({ waiting: null, blockedSourceCount: 0, blockedSources: [] });
    try {
      while (!signal?.aborted && passes++ < maxPasses) {
        let waiting = null;
        let blockedSourceCount = 0;
        const blockedSources = [];
        try {
          // The transport is a prerequisite. Never enroll a source while it is absent.
          const codex = await runtime.codex();
          const sync = async id => {
            try {
              const state = await bridge.status();
              const before = await coldImportHint(state, id);
              const previous = coldHints.get(id);
              const observedAt = now();
              if (before && !coldDirty.has(id) && previous?.signature === before && observedAt >= previous.verifiedAt
                && observedAt - previous.verifiedAt < coldValidationMs) return;
              coldHints.delete(id);
              if (before) coldDirty.add(id);
              const beganAt = now();
              let result;
              try { result = await bridge.sync(id); }
              finally {
                lastSync = { conversationId: id, durationMs: now() - beganAt };
                if (!slowestSync || lastSync.durationMs > slowestSync.durationMs) slowestSync = lastSync;
              }
              if (before && result?.changed === false && result.incompleteTail === false) {
                const latest = await bridge.status();
                if (await coldImportInactive(latest, id, codex)) {
                  const after = await coldImportHint(latest, id);
                  // A concurrent append, replacement or lifecycle transition
                  // must force another full sync, not refresh a stale hint.
                  if (before === after) {
                    coldHints.set(id, { signature: after, verifiedAt: now() });
                    coldDirty.delete(id);
                  }
                }
              }
            }
            catch (error) {
              coldHints.delete(id);
              // A native write may have committed before its response failed. Recover
              // its durable intent and verify the native target before proceeding.
              if ((await bridge.status()).pending) {
                clearHints();
                // Do not discover or start another sync while recovery waits.
                await bridge.recover();
                return;
              }
              if (isWaiting(error)) { waiting ??= reason(error); return; }
              throw error;
            }
          };
          const discoverNew = async () => {
            const beganAt = now();
            let state = await bridge.status();
            if (state.pending) { clearHints(); await bridge.recover(); }
            state = await bridge.status();
            const existing = new Set(Object.keys(state.conversations));
            const known = new Set(state.records.map(record => `${record.side}:${record.nativeId}`));
            for (const id of await runtime.ownedNativeIds()) known.add(id);
            // Each refresh reports one discovery snapshot, not an accumulating
            // count of the same unsupported source during a long cold sweep.
            blockedSourceCount = 0;
            blockedSources.length = 0;
            const candidates = await discover({ ...config, allProjects: true, projects: [], excludeSubagents: false }, known);
            for (const source of candidates) {
              if (signal?.aborted) break;
              try {
                if (source.side === 'codex') {
                  const nativeId = source.nativeId ?? source.id ?? await codexSessionId(source.path);
                  const metadata = (await codex.request('thread/read', { threadId: nativeId, includeTurns: false }).catch(error => {
                    if (/not found|no rollout/i.test(reason(error))) throw new Error('Referenced Codex history is unavailable.');
                    throw error;
                  }))?.thread;
                  if (!metadata || metadata.id !== nativeId) throw new Error('Codex returned a different native identity.');
                  if (isCodexSubagentSource(metadata.source)) continue;
                }
                await bridge.track(source);
                const latest = await bridge.status();
                for (const record of latest.records) known.add(`${record.side}:${record.nativeId}`);
              } catch (error) {
                if (isWaiting(error)) { waiting ??= reason(error); continue; }
                if (!isUnsupported(error)) throw error;
                blockedSourceCount++;
                if (blockedSources.length < 20) blockedSources.push({ side: source.side, path: source.path, reason: reason(error) });
              }
            }
            state = await bridge.status();
            const completedAt = now();
            if (discoveryCompletedAt !== null) maxDiscoveryGapMs = Math.max(maxDiscoveryGapMs, completedAt - discoveryCompletedAt);
            discoveryCompletedAt = completedAt;
            discoveryDurationMs = completedAt - beganAt;
            return Object.keys(state.conversations).filter(id => !existing.has(id));
          };
          // A whole foreground sweep can itself take tens of seconds. Refresh
          // only discovery/new deliveries between individual operations, without
          // recursively restarting the active sweep or running parallel writers.
          const refreshNew = async () => {
            if (signal?.aborted || now() - discoveryCompletedAt < Math.max(1, pollMs)) return;
            const fresh = await discoverNew();
            for (const id of fresh) {
              if (signal?.aborted) break;
              // After enrollment, errors belong to a tracked history. Keep this
              // outside discovery's unsupported-source warning handler.
              await sync(id);
            }
            await status({ waiting, blockedSourceCount, blockedSources });
          };
          const foreground = async () => {
            const beganAt = now();
            const fresh = await discoverNew();
            const freshIds = new Set(fresh);
            const state = await bridge.status();
            for (const cache of [coldHints, coldObserved, coldDirty]) {
              for (const id of cache.keys()) if (!state.conversations[id]) cache.delete(id);
            }
            const dirty = [], active = [], background = [];
            for (const id of Object.keys(state.conversations)) {
              const hint = await coldImportHint(state, id);
              if (hint && coldObserved.has(id) && coldObserved.get(id) !== hint) coldDirty.add(id);
              if (hint) coldObserved.set(id, hint);
              if (freshIds.has(id)) continue;
              else if (coldDirty.has(id)) dirty.push(id);
              else if (!hint) active.push(id); // Includes live managed owners and invalid/missing paths.
              else background.push(id);
            }
            for (const id of [...fresh, ...dirty, ...active]) {
              if (signal?.aborted) break;
              await refreshNew();
              if (signal?.aborted) break;
              await sync(id);
            }
            foregroundCompletedAt = now();
            foregroundDurationMs = foregroundCompletedAt - beganAt;
            await status({ waiting, blockedSourceCount, blockedSources });
            return background;
          };
          // Keep a fair, complete cold sweep, but yield between native operations
          // for fresh discovery and active/dirty work. Never parallelize writers
          // or interrupt a verification/transaction. The 60s hint expiry is still
          // absolute; elapsed background work does not renew it.
          const background = await foreground();
          for (const id of background) {
            if (signal?.aborted) break;
            if (now() - foregroundCompletedAt >= Math.max(1, pollMs)) await foreground();
            if (signal?.aborted) break;
            await sync(id);
          }
          await refreshNew();
          if (!signal?.aborted && now() - lastCollection >= 60_000) {
            await bridge.collect();
            lastCollection = now();
          }
        } catch (error) {
          clearHints();
          if (!isWaiting(error)) throw error;
          waiting ??= reason(error);
        }
        await status({ waiting, blockedSourceCount, blockedSources });
        if (!signal?.aborted && passes < maxPasses) {
          try { await sleep(pollMs, { signal }); }
          catch (error) { if (error.name !== 'AbortError' || !signal?.aborted) throw error; }
        }
      }
      await writeJSON(statusPath, { mode: 'desktop', running: false, pid: process.pid, startedAt, stoppedAt: now(), error: null });
    } catch (error) {
      await writeJSON(statusPath, { mode: 'desktop', running: false, pid: process.pid, startedAt, stoppedAt: now(), error: reason(error) });
      // A busy ClaudeOwner must keep its live handle; closing it can interrupt user work.
      throw error;
    }
  }, { recoverDead: true });
}
