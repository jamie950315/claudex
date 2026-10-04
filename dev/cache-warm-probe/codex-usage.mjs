export { createCodexUsageCounter } from '../../src/codex-cache-usage.mjs';

/** Do not interpret owner discovery as draft safety or a tool-denial lease. */
export function codexCacheAdmission(owner) {
  return { supported: false, automaticDispatch: false, ownerAvailable: owner?.status === 'ready',
    blockers: [...(owner?.status === 'ready' ? [] : [owner?.reason ?? 'native-owner-unavailable']),
      'native-composer-state-unavailable', 'native-warm-turn-tool-denial-unavailable'],
    ttlControl: 'not-exposed', cacheLifetime: 'not-native-verified',
    requiresSeparateConsentForWeakerMode: true };
}
