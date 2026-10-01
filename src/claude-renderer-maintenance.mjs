import { watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readAppStopState } from './app-stop-state.mjs';
import { writeDiagnosticJSON } from './storage.mjs';
import { claudeCacheDirectory, changedClaudeFrontendHint } from './claude-frontend-graph.mjs';
import { ensureClaudeRendererAdapters } from './claude-renderer-adapters.mjs';

/** One watcher-owned, serialized cache consumer. It never touches histories,
 * native owners, inference, archive proof lifetimes or service/app lifecycle.
 * fs.watch is an after-write hint, not an interception of renderer evaluation.
 */
export async function startClaudeRendererMaintenance({ root, home = homedir(), folders = true, signal, onStatus = () => {},
  settleMs = 1000, watchFactory = watch, maintain = ensureClaudeRendererAdapters, stopState = readAppStopState,
  writeStatus = writeDiagnosticJSON } = {}) {
  if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs > 60_000) throw new Error('Invalid renderer maintenance settle interval');
  let closed = false, dirty = false, pending, timer, watcher, closing, notificationsFailed = false, publication = Promise.resolve();
  const files = new Set(); let anonymous = true, observations = new Map();
  const present = value => {
    const summary = { updatedAt: Date.now(), ...value };
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
  const run = () => {
    if (pending || closed) return pending;
    pending = (async () => {
      while (dirty && !closed) {
        dirty = false;
        const names = [...files]; files.clear(); let changed = anonymous; anonymous = false;
        try {
          await checkHold();
          if (!changed) for (const filename of names) {
            if (await changedClaudeFrontendHint({ home, filename, observations })) { changed = true; break; }
          }
          if (!changed) continue;
          const result = await maintain({ root, home, folders }, { beforeReplace: checkHold, beforePublish: checkHold });
          if (result.observations instanceof Map) observations = result.observations;
          await present({ state: notificationsFailed ? 'skipped' : Object.values(result.adapters).some(a => a.status === 'skipped') ? 'degraded' : 'ready',
            ...(notificationsFailed ? { reason: 'Frontend cache notifications unavailable' } : {}),
            entry: result.entry, missingChunks: result.missingChunks,
            adapters: Object.fromEntries(Object.entries(result.adapters).map(([key, value]) => [key,
              Object.fromEntries(['status', 'asset', 'reason', 'changed', 'activation'].filter(k => value[k] !== undefined).map(k => [k, value[k]]))])) });
        } catch {
          if (!closed) await present({ state: 'skipped', reason: 'Frontend cache discovery or maintenance refused; no native work was restarted' });
        }
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const notify = filename => {
    if (closed || signal?.aborted || filename && !/^[a-f0-9]{16}_0$/.test(String(filename))) return;
    if (!filename || files.size >= 4096) anonymous = true;
    else files.add(String(filename));
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = undefined; void run(); }, settleMs); timer.unref?.();
  };
  const close = () => {
    if (closing) return closing;
    closed = true; clearTimeout(timer); watcher?.close(); signal?.removeEventListener('abort', abort);
    closing = (async () => { await pending; await publication; })();
    return closing;
  };
  const abort = () => { void close(); };
  if (signal?.aborted) { closed = true; return { close }; }
  try {
    watcher = watchFactory(claudeCacheDirectory(home), (_type, filename) => notify(filename));
    watcher.on('error', () => { notificationsFailed = true; watcher.close(); void present({ state: 'skipped', reason: 'Frontend cache notifications unavailable' }); });
    signal?.addEventListener('abort', abort, { once: true });
    dirty = true; await run();
  } catch {
    await close(); await present({ state: 'skipped', reason: 'Frontend cache watcher unavailable' });
  }
  return { close };
}
