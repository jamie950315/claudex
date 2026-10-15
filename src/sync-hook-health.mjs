import { join } from 'node:path';
import { link, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { privateDir, privateJSON, writeReceipt, syncDir } from './claude-mod-storage.mjs';
import { withLock } from './storage.mjs';

// Presentation only. This file is never a hook trust, delivery or replay proof.
export const HOOK_HEALTH_LIMITS = Object.freeze({ history: 16, bytes: 16384, count: 1_000_000_000 });
const providers = ['codex', 'claude'];
const phases = ['input', 'origin_bind', 'origin_recheck', 'mailbox', 'sync'];
const codes = new Set(['INPUT_INVALID', 'ORIGIN_UNVERIFIED', 'COORDINATION_UNVERIFIED', 'SYNC_EVENT_UNRECORDED',
  'REQUIRED_FILE_MISSING', 'ACCESS_DENIED', 'UNSAFE_STORAGE', 'STORAGE_CHANGED', 'BROKER_UNAVAILABLE',
  'BROKER_TIMEOUT', 'MAILBOX_CAPACITY_EXHAUSTED']);
const defaults = { input: 'INPUT_INVALID', origin_bind: 'ORIGIN_UNVERIFIED', origin_recheck: 'ORIGIN_UNVERIFIED',
  mailbox: 'COORDINATION_UNVERIFIED', sync: 'SYNC_EVENT_UNRECORDED' };
const pathFor = (root, provider) => join(root, `sync-hook-health-${provider}.json`);
const incompletePath = (root, provider) => join(root, `sync-hook-health-${provider}-incomplete.json`);
const increment = value => Math.min(HOOK_HEALTH_LIMITS.count, value + 1);
const count = value => Number.isInteger(value) && value >= 0 && value <= HOOK_HEALTH_LIMITS.count;
const time = value => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
function validate(value, provider) {
  const error = entry => keys(entry, ['at', 'phase', 'code']) && time(entry.at)
    && phases.includes(entry.phase) && codes.has(entry.code);
  if (!keys(value, ['version', 'provider', 'errorCount', 'phases', 'history']) || value.version !== 1
    || value.provider !== provider || !count(value.errorCount) || !keys(value.phases, phases)
    || !Array.isArray(value.history) || value.history.length > HOOK_HEALTH_LIMITS.history || !value.history.every(error)
    || !Object.entries(value.phases).every(([phase, entry]) => keys(entry, ['errorCount', 'lastError', 'recoveredAt'])
      && count(entry.errorCount) && entry.errorCount > 0 && error(entry.lastError) && entry.lastError.phase === phase
      && (entry.recoveredAt === undefined || time(entry.recoveredAt) && entry.recoveredAt >= entry.lastError.at))) {
    throw new Error('Invalid hook health diagnostics.');
  }
  return value;
}
export function syncHookErrorCode(phase, error) {
  if (error?.code === 'ENOENT') return 'REQUIRED_FILE_MISSING';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'ACCESS_DENIED';
  if (['UNSAFE_FILE', 'UNSAFE_ROOT', 'ELOOP'].includes(error?.code)) return 'UNSAFE_STORAGE';
  if (error?.code === 'FILE_CHANGED') return 'STORAGE_CHANGED';
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error?.code)) return 'BROKER_UNAVAILABLE';
  if (['ETIMEDOUT', 'TIMEOUT'].includes(error?.code)) return 'BROKER_TIMEOUT';
  return codes.has(error?.code) ? error.code : defaults[phase];
}

/** Serialize recorded counters; contention/storage refusal is reported by the
 * caller and never retried. A matching successful operation marks recovery but
 * retains the last error, bounded history and saturating recorded-error counts.
 */
export async function recordSyncHookHealth({ root, provider, phase, error, at = Date.now() }) {
  if (!providers.includes(provider) || !phases.includes(phase) || !time(at)) throw new Error('Invalid hook health operation.');
  await privateDir(root);
  const path = pathFor(root, provider);
  if (!error) {
    try { if (!await privateJSON(path, { maxBytes: HOOK_HEALTH_LIMITS.bytes, optional: true })) return; }
    catch (failure) { if (failure.code === 'FILE_CHANGED') return; throw failure; }
  }
  let entered = false;
  try { return await withLock(`${path}.lock`, async () => {
    entered = true;
    const existing = await privateJSON(path, { maxBytes: HOOK_HEALTH_LIMITS.bytes, optional: true });
    const value = existing ? validate(existing, provider) : { version: 1, provider, errorCount: 0, phases: {}, history: [] };
    const prior = value.phases[phase];
    if (!error) {
      if (!prior || prior.recoveredAt !== undefined) return;
      prior.recoveredAt = Math.max(at, prior.lastError.at);
    } else {
      const lastError = { at, phase, code: syncHookErrorCode(phase, error) };
      value.errorCount = increment(value.errorCount);
      value.phases[phase] = { errorCount: increment(prior?.errorCount ?? 0), lastError };
      value.history = [...value.history, lastError].slice(-HOOK_HEALTH_LIMITS.history);
    }
    const temporary = join(root, `.hook-health-${randomUUID()}.tmp`);
    await writeReceipt(temporary, value, { exclusive: true });
    try { await rename(temporary, path); }
    finally { await unlink(temporary).catch(failure => { if (failure.code !== 'ENOENT') throw failure; }); }
    await syncDir(root);
  }, { recoverDead: true }); }
  catch (failure) {
    if (entered) throw failure;
    if (!error) return; // Keep the error active until a later matching success.
    // Concurrent hooks must not lose an error silently. Retain the first
    // uncounted error independently, without waiting or retrying the operation.
    // The marker is never cleared automatically: recorded counts are lower bounds.
    const marker = { at, phase, code: syncHookErrorCode(phase, error) };
    const temporary = join(root, `.hook-health-${randomUUID()}.tmp`);
    await writeReceipt(temporary, marker, { exclusive: true });
    try { await link(temporary, incompletePath(root, provider)); }
    catch (publication) { if (publication.code !== 'EEXIST') throw publication; }
    finally { await unlink(temporary); }
    await syncDir(root);
  }
}

async function readIncomplete(root, provider) {
  const value = await privateJSON(incompletePath(root, provider), { maxBytes: 256, optional: true });
  if (value !== null && (!keys(value, ['at', 'phase', 'code']) || !time(value.at)
    || !phases.includes(value.phase) || !codes.has(value.code))) throw new Error('Invalid hook health diagnostic marker.');
  return value;
}

/** Bounded private reads only; heartbeat refreshes inspect no native history. */
export async function readSyncHookHealth(root) {
  const entries = await Promise.all(providers.map(async provider => {
    try {
      await privateDir(root);
      const value = await privateJSON(pathFor(root, provider), { maxBytes: HOOK_HEALTH_LIMITS.bytes, optional: true });
      const incomplete = await readIncomplete(root, provider);
      return [provider, { ...(value ? { state: 'recorded', ...validate(value, provider) } : { state: 'missing' }),
        ...(incomplete ? { incomplete } : {}) }];
    } catch { return [provider, { state: 'unavailable', code: 'HEALTH_UNAVAILABLE' }]; }
  }));
  return Object.fromEntries(entries);
}
