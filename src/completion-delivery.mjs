import { dirname, join } from 'node:path';
import { privateRead } from './claude-mod-storage.mjs';
import { modWakeStatus } from './mod-wake-broker.mjs';

/** Content-free capability inventory. Broker availability is never recipient
 * readiness; only explicit task continuation checks inspect an exact route. */
export async function completionDeliveryCapability(hub) {
  let watcher;
  try {
    const raw = await privateRead(join(dirname(hub.root), 'watcher-status.json'), { optional: true, maxBytes: 1024 * 1024 });
    if (raw !== null) watcher = JSON.parse(raw);
  } catch { /* Unsafe/unavailable status cannot certify native trust. */ }
  const now = Date.now();
  const current = watcher?.running === true && Number.isSafeInteger(watcher.updatedAt)
    && watcher.updatedAt <= now + 5000 && watcher.updatedAt > now - 90000;
  const origin = current ? watcher.hookStatus?.notificationOrigin : null;
  const codex = origin?.codex, claude = origin?.claude;
  const originHooks = {
    provenance: 'watcher-hook-status',
    codex: { configured: codex?.configured === true, trusted: codex?.trusted === true,
      state: !codex ? 'unknown' : codex.configured && codex.trusted ? 'ready' : 'waiting' },
    claude: { configured: claude?.configured === true, enabled: claude?.enabled === true,
      state: !claude ? 'unknown' : claude.configured && claude.enabled ? 'ready' : 'waiting' },
  };
  originHooks.state = originHooks.codex.state === 'ready' && originHooks.claude.state === 'ready' ? 'ready'
    : !origin ? 'unknown' : 'waiting';
  originHooks.nextStep = !origin ? 'wait-for-current-hook-inspection'
    : !codex?.configured || !claude?.configured ? 'run-setup-to-install-origin-hooks'
      : !codex.trusted ? 'review-exact-PostToolUse-hook-in-Codex-hooks'
        : !claude.enabled ? 'enable-Claude-hooks' : 'check-task-origin-proof';
  const route = hub.state.nativeWakeRoute ?? 'mod-self', observed = modWakeStatus(hub);
  let receiver;
  if (route === 'mod-self') {
    const enabled = observed.receiver.bothEnabledCount > 0;
    const allowed = observed.versions.some(value => value.enabledAllowCount > 0 || value.enabledDefaultCount > 0);
    receiver = { state: enabled && allowed ? 'observed' : 'waiting',
      reason: !observed.liveObserverCount ? 'no-live-receiver' : !enabled ? 'receiver-opt-ins-disabled'
        : allowed ? 'loaded-receiver-observed' : 'recipient-native-policy-unverified',
      nextStep: !observed.liveObserverCount ? 'open-recipient-session-and-load-Mod'
        : !enabled ? 'explicitly-enable-nativeWake-and-selfWake'
          : allowed ? 'check-task-exact-recipient' : 'check-recipient-native-inbound-policy' };
  } else if (route === 'mod') receiver = {
    state: observed.liveObserverCount ? 'observed' : 'waiting', reason: 'exact-sender-and-recipient-required',
    nextStep: 'check-task-exact-recipient-and-SendMessage-capability' };
  else receiver = { state: 'unknown', reason: 'renderer-readiness-unverified', nextStep: 'verify-loaded-chat-wake-adapter' };
  return { diagnosticOnly: true, deliveryGuaranteed: false,
    selectedRoute: { claude: route, codex: 'native-owner' }, originHooks,
    recipientReadiness: { claude: receiver, codex: { state: 'unknown', reason: 'exact-recipient-required',
      nextStep: 'check-task-native-owner-with-checkNotification' } },
    nextStep: originHooks.state !== 'ready' ? originHooks.nextStep
      : receiver.state !== 'observed' ? receiver.nextStep : 'check-task-exact-recipient',
    intermediateAlertsDefault: false };
}

export function taskCompletionDelivery(capability, task, continuation) {
  const n = task.notification;
  return { ...capability, originBinding: !n ? 'notifications-off' : n.origin ? 'verified'
    : n.challengeExpiresAt <= Date.now() ? 'expired' : 'awaiting-native-proof',
    ...(continuation ? { recipient: { state: continuation.nextAction === 'await-notification' ? 'observed'
      : continuation.nextAction === 'read-result' ? 'read-result' : 'waiting', reason: continuation.reason },
      nextStep: continuation.nextAction === 'read-result' ? 'read-task-result'
        : continuation.nextAction === 'await-notification' ? 'await-completion-notification'
          : continuation.nextStep ?? 'continue-monitoring-with-claudex_wait' } : {}),
  };
}
