// Shared wire validation must remain independent of broker/runtime imports so
// the standalone Mod transport can load without the broker implementation.
export function notificationPolicy(value) {
  if (value === undefined) return { mode: 'off' };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['mode', 'expiresInMs'].includes(key))
    || !['off', 'queue', 'wake'].includes(value.mode)
    || value.expiresInMs !== undefined && (!Number.isSafeInteger(value.expiresInMs)
      || value.expiresInMs < 1000 || value.expiresInMs > 3600000))
    throw Object.assign(new Error('Notifications require off, queue or wake and a bounded expiry.'),
      { code: 'CLAUDEX_INVALID_NOTIFICATION_POLICY' });
  return value.mode === 'off' ? { mode: 'off' } : { mode: value.mode, expiresInMs: value.expiresInMs ?? 600000 };
}
