import { createHash } from 'node:crypto';

const fields = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
function validate(value) {
  if (!value || !fields.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    || value.totalTokens !== value.inputTokens + value.outputTokens
    || value.cachedInputTokens + value.cacheWriteInputTokens > value.inputTokens
    || value.reasoningOutputTokens > value.outputTokens) throw new Error('Unsupported or inconsistent native token usage.');
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}
const equal = (a, b) => fields.every(key => a[key] === b[key]);

/** One live subscription, not persisted cache or upstream response identity.
 * A sample requires an observed baseline and exact cumulative/last agreement.
 * This accounts usage; it does not certify cache lifetime or warm completion. */
export function createCodexUsageCounter(threadId) {
  if (typeof threadId !== 'string' || !threadId) throw new Error('An exact native thread is required.');
  let baseline = null, failed = false;
  return {
    observe(event) {
      if (failed) throw new Error('Native usage continuity was lost; start a new read-only observation.');
      try {
        if (event?.threadId !== threadId || typeof event.turnId !== 'string' || !event.turnId)
          throw new Error('Native usage identity changed.');
        const total = validate(event.tokenUsage?.total), last = validate(event.tokenUsage?.last);
        if (!baseline) { baseline = { total, last }; return { state: 'baseline' }; }
        if (equal(total, baseline.total)) {
          if (!equal(last, baseline.last)) throw new Error('Repeated native totals changed their last-request usage.');
          return { state: 'duplicate' };
        }
        const delta = Object.fromEntries(fields.map(key => [key, total[key] - baseline.total[key]]));
        if (!equal(delta, last) || delta.totalTokens <= 0) throw new Error('Native usage is reset, incomplete or not one request.');
        baseline = { total, last };
        return { state: 'sample', sampleId: createHash('sha256').update(JSON.stringify([threadId, event.turnId, total])).digest('hex'),
          provenance: 'native-cumulative-delta', upstreamResponseIdAvailable: false, usage: last };
      } catch (error) { failed = true; throw error; }
    },
  };
}

/** Do not interpret owner discovery as draft safety or a tool-denial lease. */
export function codexCacheAdmission(owner) {
  return { supported: false, automaticDispatch: false, ownerAvailable: owner?.status === 'ready',
    blockers: [...(owner?.status === 'ready' ? [] : [owner?.reason ?? 'native-owner-unavailable']),
      'native-composer-state-unavailable', 'native-warm-turn-tool-denial-unavailable'],
    ttlControl: 'not-exposed', cacheLifetime: 'not-native-verified',
    requiresSeparateConsentForWeakerMode: true };
}
