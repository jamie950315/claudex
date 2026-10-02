const same = (a, b) => a?.sessionId === b?.sessionId && a?.cwd === b?.cwd;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** Shared manual/automatic dispatch. Only receipt publication may be recovered. */
export async function deliverNativeWake(api, source, target, messageId, current = () => true) {
  if (await api.worker()) return { state: 'disabled', reason: 'managed-worker' };
  const tools = await api.tools();
  if (!tools.some(tool => tool.name === 'SendMessage')) return { state: 'waiting', reason: 'missing-SendMessage' };
  if (!current() || !same(await api.context(), source)) return { state: 'waiting', reason: 'context-changed' };
  if (same(source, target) || source.sessionId === target.sessionId) return { state: 'waiting', reason: 'another-Mod-session-required' };
  const call = (op, more = {}) => api.bridge({ version: 1, op, context: source, target, messageId, ...more });
  let claim;
  try { claim = await call('wake-claim'); }
  catch (error) {
    if (error.code === 'MOD_TARGET_UNAVAILABLE') return { state: 'waiting', reason: 'target-unavailable' };
    throw error;
  }
  if (claim?.claimed !== true) return { state: 'handled', reason: 'claimed-elsewhere' };
  if (!uuid.test(claim.claimId ?? '') || claim.messageId !== messageId)
    return { state: 'uncertain', reason: 'invalid-claim', messageId };
  let status = 'uncertain', reason = 'pre_dispatch_stopped', nativeReason = '';
  try {
    if (!current() || !same(await api.context(), source)) reason = 'context_changed';
    else {
      const guard = await call('wake-check', { claimId: claim.claimId });
      if (guard?.ready !== true) throw new Error('Native dispatch readiness was not confirmed');
      if (typeof claim.context !== 'string' || !claim.context.trim() || claim.context.length > 8192) throw new Error('Invalid native peer context');
      if (!current() || !same(await api.context(), source)) reason = 'context_changed';
      else {
        reason = 'native_exception';
        const result = await api.sendSession({ to: { sessionId: target.sessionId }, text: claim.context });
        if (result?.isDelivered === true) { status = 'accepted'; reason = 'queued'; }
        else if (result?.isDelivered === false) {
          status = 'rejected'; reason = 'native_rejected';
          nativeReason = typeof result.reason === 'string' ? result.reason.slice(0, 300) : 'Native recipient refused delivery.';
        }
      }
    }
  } catch { /* An unknown native call is never resent. */ }
  try { await call('wake-receipt', { claimId: claim.claimId, status, reason }); }
  catch { return { state: 'uncertain', reason: 'receipt-unconfirmed', messageId, nativeOutcome: status }; }
  return { state: status, reason, nativeReason, messageId };
}

/** One event-backed broker wait at a time, with bounded pre-claim connection recovery. */
export function createNativeWakePump({ enabled = false } = {}) {
  let epoch = 0, active = false, running = false, timer, failures = 0, api;
  let state = { status: enabled ? 'not-started' : 'disabled', lastOutcome: null };
  const ignored = new Set();
  const deferred = new Set();
  const show = value => { state = { ...state, ...value }; api?.redraw(); };
  function schedule(ms) { timer?.cancel(); if (active) timer = api.after(ms, () => { void tick(); }); }
  async function tick() {
    if (!active || running) return;
    running = true; const ticket = epoch, host = api;
    let delay = 100;
    try {
      if (await host.worker()) { stop(); show({ status: 'managed-worker' }); return; }
      const source = await host.context();
      const tools = await host.tools();
      if (!active || ticket !== epoch) return;
      if (!tools.some(tool => tool.name === 'SendMessage')) { show({ status: 'missing-SendMessage' }); delay = 30000; return; }
      show({ status: 'waiting-for-authorized-message' });
      const result = await host.bridge({ version: 1, op: 'wake-next', context: source, excludeIds: [...new Set([...deferred, ...ignored])].slice(0, 64) });
      if (!active || ticket !== epoch || !same(await host.context(), source)) return;
      failures = 0;
      if (result.state === 'disabled' || result.state === 'stopping') { show({ status: result.state }); delay = 30000; return; }
      const message = result.messages?.find(item => !ignored.has(item.messageId) && !deferred.has(item.messageId));
      if (!message) { deferred.clear(); return; }
      const outcome = await deliverNativeWake(host, source, message.target, message.messageId, () => active && ticket === epoch);
      // Claimed/uncertain messages are never automatically retried, even across timer ticks.
      if (outcome.state !== 'waiting') {
        ignored.add(message.messageId);
        if (ignored.size > 64) ignored.delete(ignored.values().next().value);
      } else { deferred.add(message.messageId); if (deferred.size > 64) deferred.delete(deferred.values().next().value); }
      if (ticket === epoch) show({ status: outcome.state, lastOutcome: outcome });
    } catch (error) {
      if (ticket === epoch) {
        if (error.code === 'APP_STOPPED') { show({ status: 'paused-by-app' }); delay = 30000; }
        else if (['UNSAFE_ROOT', 'UNSAFE_FILE', 'INVALID_RECEIPT', 'JOURNAL_FULL'].includes(error.code)) {
          stop(); show({ status: `blocked-${error.code}`, lastOutcome: state.lastOutcome });
        } else { show({ status: 'connection-or-receipt-recovery' }); delay = [1000, 5000, 15000, 30000][Math.min(failures++, 3)]; }
      }
    } finally {
      running = false;
      if (active) schedule(ticket === epoch ? delay : 0);
    }
  }
  function stop() { active = false; epoch++; timer?.cancel(); timer = null; }
  return {
    get state() { return state; }, stop,
    start(host) { stop(); api = host; if (!enabled) return; active = true; ignored.clear(); deferred.clear(); if (!running) schedule(0); },
  };
}
