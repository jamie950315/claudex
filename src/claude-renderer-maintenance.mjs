import { watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readAppStopState } from './app-stop-state.mjs';
import { writeDiagnosticJSON } from './storage.mjs';
import { claudeCacheDirectory, changedClaudeFrontendHint } from './claude-frontend-graph.mjs';
import { ensureClaudeRendererAdapters } from './claude-renderer-adapters.mjs';

// Fixed diagnostic codes only: native errors may contain paths or cache keys.
function failureCode(error) {
  if (error?.code === 'CLAUDEX_FRONTEND_CACHE_MISSING') return 'cache-entry-missing';
  if (error?.code === 'CLAUDEX_FRONTEND_CACHE_CHANGED') return 'cache-changed';
  if (error?.code === 'CLAUDEX_FRONTEND_EVIDENCE_MISSING') return 'recovery-evidence-missing';
  if (error?.code === 'ENOENT') return 'required-file-missing';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'access-denied';
  if (['Claude frontend graph: graph changed during discovery',
    'Claude frontend graph: graph changed before publication',
    'Claude frontend graph: entry changed during discovery',
    'Claude frontend graph: cache inventory changed while reading'].includes(error?.message)) return 'cache-changed';
  if (['Renderer maintenance stopped', 'Renderer maintenance held by app stop'].includes(error?.message)) return 'stopped';
  return 'validation-refused';
}
const transientCodes = new Set(['cache-entry-missing', 'cache-changed']);
const diagnosticCodes = new Set([...transientCodes, 'recovery-evidence-missing', 'required-file-missing',
  'access-denied', 'stopped', 'validation-refused']);
const checkingReason = 'The frontend cache changed during inspection. Claudex is checking it again; no action is required.';

/** One watcher-owned, serialized cache consumer. It never touches histories,
 * native owners, inference, archive proof lifetimes or service/app lifecycle.
 * fs.watch is an after-write hint, not an interception of renderer evaluation.
 */
export async function startClaudeRendererMaintenance({ root, home = homedir(), folders = true, signal, onStatus = () => {},
  settleMs = 1000, watchFactory = watch, watchAppStop, maintain = ensureClaudeRendererAdapters, stopState = readAppStopState,
  writeStatus = writeDiagnosticJSON } = {}) {
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 60_000) throw new Error('Invalid renderer maintenance settle interval');
  let closed = false, dirty = false, pending, timer, watcher, stopWatcher, closing, notificationsFailed = false, publication = Promise.resolve();
  const files = new Set(); let anonymous = true, observations = new Map();
  let transientRetryUsed = false;
  let cacheRevalidationNeeded = false;
  let lastFailure;
  const rememberFailure = (phase, code) => {
    lastFailure = { at: Date.now(), phase, code: diagnosticCodes.has(code) ? code : 'validation-refused' };
  };
  const present = value => {
    const summary = { updatedAt: Date.now(), ...value, ...(lastFailure ? { lastFailure: { ...lastFailure } } : {}) };
    publication = publication.then(async () => {
      try { await writeStatus(join(root, 'renderer-adapters-status.json'), summary); }
      catch { summary.state = 'skipped'; summary.reason = 'Renderer maintenance status could not be published'; }
      onStatus(summary);
    });
    return publication;
  };
  const checkHold = async () => {
    if (closed || signal?.aborted) throw new Error('Renderer maintenance stopped');
    if ((await stopState(root))?.stopped) throw new Error('Renderer maintenance held by app stop');
  };
  const retryInterruptedCache = () => {
    if (!closed && !signal?.aborted && !dirty && !timer && !transientRetryUsed && cacheRevalidationNeeded) {
      transientRetryUsed = true;
      anonymous = true; dirty = true;
      return true;
    }
    return false;
  };
  const run = () => {
    if (pending || closed) return pending;
    pending = (async () => {
      while (dirty && !closed) {
        dirty = false;
        const names = [...files]; files.clear();
        // After an interrupted inventory, a vanished filename cannot be
        // classified against the discarded observations. Its notification is
        // enough to request a fresh proof, never enough to report readiness.
        let changed = anonymous || cacheRevalidationNeeded; anonymous = false;
        let phase = 'lifecycle';
        try {
          await checkHold();
          phase = 'cache-hint';
          if (!changed) for (const filename of names) {
            if (await changedClaudeFrontendHint({ home, filename, observations })) { changed = true; break; }
          }
          if (!changed) continue;
          phase = 'discovery-or-installation';
          const result = await maintain({ root, home, folders }, { beforeReplace: checkHold, beforePublish: checkHold });
          // A drained publication may report the intentional shutdown fence as
          // a refusal. Do not overwrite the last health report after close.
          if (closed || signal?.aborted) break;
          const refusals = Object.values(result.adapters).filter(a => a.status === 'skipped');
          const refused = refusals.length > 0;
          cacheRevalidationNeeded = refusals.some(a => transientCodes.has(a.failure?.code));
          if (!refused) transientRetryUsed = false;
          if (refused) observations = new Map();
          else if (result.observations instanceof Map) observations = result.observations;
          if (refused) rememberFailure(phase, (refusals.find(a => !transientCodes.has(a.failure?.code)) ?? refusals[0]).failure?.code);
          else if (lastFailure && !lastFailure.recoveredAt) lastFailure.recoveredAt = Date.now();
          const retryScheduled = retryInterruptedCache();
          const checking = retryScheduled && refusals.every(a => transientCodes.has(a.failure?.code));
          await present({ state: notificationsFailed ? 'skipped' : checking ? 'checking' : refused ? 'degraded' : 'ready',
            ...(notificationsFailed ? { reason: 'Frontend cache notifications unavailable' } : checking ? { reason: checkingReason } : {}),
            entry: result.entry, missingChunks: result.missingChunks,
            adapters: Object.fromEntries(Object.entries(result.adapters).map(([key, value]) => [key,
              { ...Object.fromEntries(['status', 'asset', 'reason', 'changed', 'activation', 'search'].filter(k => value[k] !== undefined).map(k => [k, value[k]])),
                ...(value.failure ? { failure: { code: value.failure.code } } : {}) }])) });
        } catch (error) {
          // A prior successful observation cannot prove a failed pass healthy.
          // The next JS hint must revalidate, including unchanged known assets.
          observations = new Map();
          const code = failureCode(error);
          cacheRevalidationNeeded = transientCodes.has(code);
          rememberFailure(phase, code);
          // Chromium can evict an entry during the inventory walk, after its
          // last notification. Re-discover once in this pass; never replay a
          // native operation or poll persistent validation/permission failures.
          const checking = retryInterruptedCache() && !notificationsFailed;
          if (!closed) await present({ state: checking ? 'checking' : 'skipped',
            reason: checking ? checkingReason : `Frontend cache discovery or maintenance refused; no native work was restarted [${phase}/${code}]`,
            failure: { phase, code } });
        }
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const notify = filename => {
    if (closed || signal?.aborted || filename && !/^[a-f0-9]{16}_0$/.test(String(filename))) return;
    transientRetryUsed = false;
    if (!filename || files.size >= 4096) anonymous = true;
    else files.add(String(filename));
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; void run(); }, settleMs); timer.unref?.();
  };
  const close = () => {
    if (closing) return closing;
    closed = true; clearTimeout(timer); watcher?.close(); stopWatcher?.close(); signal?.removeEventListener('abort', abort);
    closing = (async () => { await pending; await publication; })();
    return closing;
  };
  const abort = () => { void close(); };
  if (signal?.aborted) { closed = true; return { close }; }
  try {
    watcher = watchFactory(claudeCacheDirectory(home), (_type, filename) => notify(filename));
    watcher.on('error', () => { notificationsFailed = true; watcher.close(); void present({ state: 'skipped', reason: 'Frontend cache notifications unavailable' }); });
    // Services start before graphical resume clears app-stop.json. Subscribe
    // through the shared root watcher before checking the hold to avoid losing
    // that release; a notification still rechecks the authoritative stop state.
    stopWatcher = await watchAppStop?.(() => notify(null));
    signal?.addEventListener('abort', abort, { once: true });
    dirty = true; await run();
  } catch {
    await close(); await present({ state: 'skipped', reason: 'Frontend cache watcher unavailable' });
  }
  return { close };
}
