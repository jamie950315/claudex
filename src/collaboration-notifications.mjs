import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import { dirname } from 'node:path';
import { readAppStopState } from './app-stop-state.mjs';
import { modDeliveryDiagnosis } from './mod-wake-broker.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'uncertain']);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const states = new WeakMap();
// Non-serializable, internal-only dispatch fence. Wire callers cannot supply it.
export const NOTIFICATION_FENCE = Symbol('claudex-notification-fence');
const stateFor = hub => {
  if (!states.has(hub)) states.set(hub, { queued: false, running: null });
  return states.get(hub);
};
const pending = task => task.notification?.origin && terminal.has(task.status)
  && task.notification.suppressedRevision !== task.revision
  && !task.notification.deliveries.some(delivery => delivery.revision === task.revision);
const sameOrigin = (a, b) => a?.provider === b?.provider && a?.sessionId === b?.sessionId
  && a?.cwd === b?.cwd && a?.toolUseId === b?.toolUseId && a?.turnId === b?.turnId;
function notificationLimit(state, notification, now = Date.now()) {
  if (notification.deliveries.length >= 16) return 'task-notification-limit';
  const recent = Object.values(state.tasks).flatMap(item => item.notification?.origin?.provider === notification.origin.provider
    && item.notification.origin.sessionId === notification.origin.sessionId ? item.notification.deliveries : [])
    .filter(delivery => delivery.createdAt > now - 60000).length;
  return recent >= 16 ? 'origin-rate-limit' : null;
}
const stopped = async hub => {
  const stop = await readAppStopState(dirname(hub.root));
  return hub.closed || stop?.stopped || stop?.resuming;
};

export function notificationPolicy(value) {
  if (value === undefined) return { mode: 'off' };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['mode', 'expiresInMs'].includes(key))
    || !['off', 'queue', 'wake'].includes(value.mode)
    || value.expiresInMs !== undefined && (!Number.isSafeInteger(value.expiresInMs)
      || value.expiresInMs < 1000 || value.expiresInMs > 3600000))
    fail('CLAUDEX_INVALID_NOTIFICATION_POLICY', 'Notifications require off, queue or wake and a bounded expiry.');
  return value.mode === 'off' ? { mode: 'off' } : { mode: value.mode, expiresInMs: value.expiresInMs ?? 600000 };
}

export function createTaskNotification(policy, requestKey, now = Date.now()) {
  return { policy, requestKey, challenge: randomBytes(32).toString('hex'), challengeExpiresAt: now + 300000,
    origin: null, deliveries: [], suppressedRevision: null };
}

export function notificationPresentation(task) {
  const value = task.notification;
  if (!value) return { mode: 'off' };
  return { mode: value.policy.mode, expiresInMs: value.policy.expiresInMs,
    bindingStatus: value.origin ? 'verified' : value.challengeExpiresAt <= Date.now() ? 'expired' : 'awaiting-native-proof',
    origin: structuredClone(value.origin), deliveries: structuredClone(value.deliveries),
    pendingVerification: value.originHint ? { attempts: value.originHint.attempts,
      lastAttemptAt: value.originHint.lastAttemptAt, error: value.originHint.error } : null,
    suppressedRevision: value.suppressedRevision, suppressionReason: value.suppressionReason ?? null };
}

/** Explicit read-only preflight for a caller considering ending its current turn.
 * This is a snapshot, never a dispatch lease or a guarantee of future delivery. */
export async function inspectNotificationContinuation(hub, task) {
  const result = (nextAction, reason, evidence = null) => ({ nextAction, reason, evidence,
    checkedAt: Date.now(), diagnosticOnly: true, deliveryGuaranteed: false });
  if (terminal.has(task.status)) return result('read-result', 'task-terminal');
  const n = task.notification;
  if (!n || n.policy.mode === 'off') return result('wait', 'notifications-off');
  if (n.policy.mode !== 'wake') return result('wait', 'queue-does-not-wake');
  if (!n.origin) return result('wait', n.challengeExpiresAt <= Date.now() ? 'origin-expired' : 'awaiting-native-proof');
  const limit = notificationLimit(hub.state, n);
  if (limit) return result('wait', limit);
  if (await stopped(hub)) return result('wait', 'app-stopped');
  const route = n.origin.provider === 'claude' ? hub.state.nativeWakeRoute ?? 'renderer' : 'native-owner';
  const chat = (await hub.chatMailbox.list()).find(value => value.provider === n.origin.provider
    && value.sessionId === n.origin.sessionId && value.cwd === n.origin.cwd);
  if (!chat || chat.phase === 'ended') return result('wait', !chat ? 'origin-not-registered' : 'waiting-for-resume');
  let observation;
  if (n.origin.provider === 'codex') {
    if (!hub.chatWake || !hub.chatWakeProbe || !hub.nativeChatDiscovery) return result('wait', 'wake-probe-unavailable');
    let handle;
    try {
      const targets = await hub.nativeChatDiscovery({ sessionId: n.origin.sessionId });
      if (!targets.some(value => value.sessionId === n.origin.sessionId && value.cwd === n.origin.cwd
        && !value.archived && !value.titleError && typeof value.title === 'string' && value.title.trim()))
        return result('wait', 'origin-unmapped');
      // Unlike prepareCodexChatWake, this must never open a window or load a chat.
      handle = await hub.chatWakeProbe({ sessionId: n.origin.sessionId, timeoutMs: 1500 });
      observation = handle?.status === 'ready' ? result('await-notification', 'native-owner-observed', 'native-owner')
        : result('wait', 'native-owner-unavailable');
    } catch { observation = result('wait', 'native-owner-unavailable'); }
    finally { handle?.close?.(); }
  } else if (['mod', 'mod-self'].includes(route)) {
    const diagnosis = await modDeliveryDiagnosis(hub, { targetProvider: 'claude', targetSessionId: n.origin.sessionId,
      wakeRoute: route, state: 'queued' });
    observation = ['receiver-observed', 'sender-observed'].includes(diagnosis?.reason)
      ? result('await-notification', diagnosis.reason, 'mod-self-reported')
      : result('wait', diagnosis?.reason ?? 'receiver-unavailable');
  } else observation = result('wait', 'renderer-readiness-unverified');
  // Metadata/probe awaits must not authorize yielding on a stale task or route.
  const current = hub.state.tasks[task.id];
  if (current && terminal.has(current.status)) return result('read-result', 'task-terminal');
  if (!current || current.revision !== task.revision || !sameOrigin(current.notification?.origin, n.origin)
    || (n.origin.provider === 'claude' && (hub.state.nativeWakeRoute ?? 'renderer') !== route))
    return result('wait', 'task-or-route-changed');
  if (await stopped(hub)) return result('wait', 'app-stopped');
  const latest = (await hub.chatMailbox.list()).find(value => value.provider === n.origin.provider
    && value.sessionId === n.origin.sessionId && value.cwd === n.origin.cwd);
  if (!latest || latest.phase === 'ended') return result('wait', 'waiting-for-resume');
  const final = hub.state.tasks[task.id];
  if (hub.closed) return result('wait', 'app-stopped');
  if (final && terminal.has(final.status)) return result('read-result', 'task-terminal');
  if (!final || final.revision !== task.revision || !sameOrigin(final.notification?.origin, n.origin)
    || (n.origin.provider === 'claude' && (hub.state.nativeWakeRoute ?? 'renderer') !== route))
    return result('wait', 'task-or-route-changed');
  const finalLimit = notificationLimit(hub.state, final.notification);
  if (finalLimit) return result('wait', finalLimit);
  return observation;
}

export function validateTaskNotification(task, requests) {
  const n = task.notification;
  if (n === undefined) return;
  notificationPolicy(n.policy);
  if (task.parentId !== null || n.policy.mode === 'off' || !/^[a-f0-9]{64}$/.test(n.challenge ?? '')
    || !Number.isSafeInteger(n.challengeExpiresAt) || !requests[n.requestKey]
    || requests[n.requestKey].result?.taskId !== task.id || requests[n.requestKey].result?.originChallenge !== n.challenge
    || !Array.isArray(n.deliveries) || n.deliveries.length > 16
    || n.deliveries.some(d => !Number.isSafeInteger(d.revision) || !['dispatching', 'queued', 'expired', 'uncertain', 'failed'].includes(d.state)
      || !Number.isSafeInteger(d.createdAt) || !Number.isSafeInteger(d.expiresAt) || typeof d.requestId !== 'string')
    || n.origin && (!['codex', 'claude'].includes(n.origin.provider) || !uuid.test(n.origin.sessionId ?? '')
      || typeof n.origin.cwd !== 'string' || !n.origin.cwd.startsWith('/') || typeof n.origin.toolUseId !== 'string')
    || n.originHint && (!uuid.test(n.originHint.sessionId ?? '') || !['codex', 'claude'].includes(n.originHint.provider)
      || typeof n.originHint.cwd !== 'string' || !n.originHint.cwd.startsWith('/') || typeof n.originHint.toolUseId !== 'string'
      || !Number.isSafeInteger(n.originHint.attempts) || n.originHint.attempts < 1 || n.originHint.attempts > 3
      || !Number.isSafeInteger(n.originHint.lastAttemptAt)))
    fail('CLAUDEX_NOTIFICATION_STORAGE', 'Malformed notification evidence was preserved.');
}

/** Hook inputs only locate evidence. The independent native read is authority. */
export async function bindTaskOrigin(hub, envelope, actor) {
  const p = envelope.params;
  if (actor.task || Object.keys(p).some(key => !['taskId', 'sessionId', 'cwd', 'toolUseId', 'turnId'].includes(key))
    || !uuid.test(p.taskId ?? '') || !uuid.test(p.sessionId ?? '') || typeof p.cwd !== 'string'
    || !p.cwd.startsWith('/') || p.cwd.length > 4096 || /[\0\r\n]/.test(p.cwd)
    || typeof p.toolUseId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(p.toolUseId)
    || p.turnId !== undefined && (typeof p.turnId !== 'string' || p.turnId.length > 256))
    fail('CLAUDEX_ORIGIN_REFUSED', 'Origin binding requires an external controller and exact native identity hints.');
  const task = hub.state.tasks[p.taskId], n = task?.notification;
  if (!task || task.parentId !== null || task.returnTo !== actor.peer || !n || typeof hub.originVerifier !== 'function')
    fail('CLAUDEX_ORIGIN_UNAVAILABLE', 'This task has no eligible native origin notification request.');
  const requested = { provider: actor.peer, sessionId: p.sessionId, cwd: p.cwd, toolUseId: p.toolUseId,
    ...(p.turnId === undefined ? {} : { turnId: p.turnId }) };
  if (n.origin) {
    if (!sameOrigin(n.origin, requested)) fail('CLAUDEX_ORIGIN_CONFLICT', 'The task already has a different verified origin.');
    return { bound: true, origin: structuredClone(n.origin), replayed: true };
  }
  if (n.challengeExpiresAt <= Date.now() || await stopped(hub))
    fail('CLAUDEX_ORIGIN_EXPIRED', 'Origin verification expired or the broker is stopped.');
  const receipt = hub.state.requests[n.requestKey];
  if (n.originHint && sameOrigin(n.originHint, requested) && n.originHint.attempts >= 3)
    return { bound: false, reason: 'native-proof-attempts-exhausted' };
  let proof;
  try {
    proof = await hub.originVerifier({ ...requested, expectedFingerprint: receipt.fingerprint,
      expectedReceipt: structuredClone(receipt.result) });
  } catch (error) {
    if (error?.code !== 'ORIGIN_PROOF_UNAVAILABLE') throw error;
    return hub.mutate(async state => {
      const current = state.tasks[p.taskId]?.notification;
      if (hub.actor(envelope, state).task || !current || current.origin || current.challenge !== n.challenge
        || current.challengeExpiresAt <= Date.now() || await stopped(hub))
        fail('CLAUDEX_ORIGIN_EXPIRED', 'Origin hint no longer applies.');
      const previous = current.originHint;
      current.originHint = { ...requested, attempts: Math.min(3, sameOrigin(previous, requested) ? previous.attempts + 1 : 1),
        lastAttemptAt: Date.now(), error: 'ORIGIN_PROOF_UNAVAILABLE' };
      return { bound: false, reason: 'awaiting-native-evidence', attempts: current.originHint.attempts };
    });
  }
  if (!sameOrigin(proof, requested) || typeof proof.source !== 'string' || proof.source.length > 100
    || !Number.isSafeInteger(proof.verifiedAt) || proof.verifiedAt < 0)
    fail('CLAUDEX_ORIGIN_REFUSED', 'Native proof did not match the requested origin.');
  // No transcript, arguments, result payload or arbitrary verifier fields persist.
  const origin = { ...requested, source: proof.source, verifiedAt: proof.verifiedAt };
  return hub.mutate(async state => {
    const current = state.tasks[p.taskId]?.notification;
    if (hub.actor(envelope, state).task || !current || current.challenge !== n.challenge
      || current.challengeExpiresAt <= Date.now() || await stopped(hub))
      fail('CLAUDEX_ORIGIN_EXPIRED', 'Origin verification no longer applies.');
    if (current.origin && !sameOrigin(current.origin, origin)) fail('CLAUDEX_ORIGIN_CONFLICT', 'The task origin changed.');
    current.origin ??= origin;
    delete current.originHint;
    return { bound: true, origin: structuredClone(current.origin) };
  });
}

/** Only native lifecycle events retry missing proof, never native input/dispatch. */
export async function recheckTaskOrigins(hub, envelope, actor) {
  const p = envelope.params;
  if (actor.task || Object.keys(p).some(key => !['sessionId', 'cwd', 'event'].includes(key))
    || !uuid.test(p.sessionId ?? '') || typeof p.cwd !== 'string' || !p.cwd.startsWith('/')
    || p.cwd.length > 4096 || /[\0\r\n]/.test(p.cwd)
    || !['SessionStart', 'UserPromptSubmit', 'Stop'].includes(p.event))
    fail('CLAUDEX_ORIGIN_REFUSED', 'Origin recheck requires an exact native lifecycle hint.');
  if (await stopped(hub)) return { checked: 0, state: 'stopped' };
  const tasks = Object.values(hub.state.tasks).filter(task => {
    const n = task.notification, hint = n?.originHint;
    return !n?.origin && hint?.provider === actor.peer && hint.sessionId === p.sessionId && hint.cwd === p.cwd
      && hint.attempts < 3 && n.challengeExpiresAt > Date.now();
  }).sort((a, b) => a.notification.originHint.lastAttemptAt - b.notification.originHint.lastAttemptAt).slice(0, 4);
  const results = await Promise.all(tasks.map(async task => {
    const hint = task.notification.originHint;
    try {
      return { taskId: task.id, ...await bindTaskOrigin(hub, { ...envelope, method: 'origin_bind', params: {
        taskId: task.id, sessionId: hint.sessionId, cwd: hint.cwd, toolUseId: hint.toolUseId,
        ...(hint.turnId === undefined ? {} : { turnId: hint.turnId }),
      } }, actor) };
    } catch (error) {
      await hub.mutate(state => {
        const current = state.tasks[task.id].notification;
        if (!current.origin && sameOrigin(current.originHint, hint)) {
          current.originHint.attempts = 3;
          current.originHint.error = error?.code === 'ORIGIN_PROOF_INVALID' ? 'ORIGIN_PROOF_INVALID' : 'ORIGIN_PROOF_UNAVAILABLE';
        }
      });
      return { taskId: task.id, bound: false, reason: 'native-proof-refused' };
    }
  }));
  return { checked: results.length, results };
}

/** Resume no ambiguous dispatch. An interrupted intent stays uncertain forever. */
export function recoverNotifications(state) {
  for (const task of Object.values(state.tasks)) for (const delivery of task.notification?.deliveries ?? []) {
    if (delivery.state === 'dispatching') { delivery.state = 'uncertain'; delivery.reason = 'broker-restarted-during-dispatch'; }
  }
}

async function publish(hub) {
  // Terminal revisions coalesce until selected. Bound each pass and each origin.
  for (let sent = 0; sent < 16 && !hub.closed; sent++) {
    if (await stopped(hub)) return 'held';
    const next = await hub.mutate(state => {
      const task = Object.values(state.tasks).find(pending);
      if (!task) return null;
      const n = task.notification, now = Date.now();
      const limit = notificationLimit(state, n, now);
      if (limit) {
        n.suppressedRevision = task.revision;
        n.suppressionReason = limit;
        return { suppressed: true };
      }
      const expiresAt = task.updatedAt + n.policy.expiresInMs;
      const delivery = { revision: task.revision, state: 'dispatching', mode: n.policy.mode,
        createdAt: now, expiresAt,
        requestId: `origin-${task.id}-${task.revision}-${n.challenge.slice(0, 16)}` };
      n.deliveries.push(delivery);
      if (expiresAt <= now) {
        delivery.state = 'expired'; delivery.reason = 'expired-before-publication';
        return { suppressed: true };
      }
      return { taskId: task.id, origin: structuredClone(n.origin), expiresInMs: n.policy.expiresInMs, ...delivery };
    });
    if (!next) return 'drained';
    if (next.suppressed) continue;
    let receipt, state = 'uncertain', reason = null;
    try {
      if (await stopped(hub)) { reason = 'app-stopped-before-dispatch'; }
      else if (next.expiresAt <= Date.now()) { state = 'expired'; reason = 'expired-before-dispatch'; }
      else {
        // This internal caller, not the worker, holds controller authority.
        const fence = { expiresAt: next.expiresAt, check: async () => {
          if (await stopped(hub)) fail('CLAUDEX_NOTIFICATION_STOPPED', 'Notification dispatch stopped.');
          if (next.expiresAt <= Date.now()) fail('CLAUDEX_NOTIFICATION_EXPIRED', 'Notification expired before dispatch.');
        } };
        receipt = await hub.dispatch({ [NOTIFICATION_FENCE]: fence,
          peer: next.origin.provider, token: hub.controllerToken, method: 'chat_send', params: {
          provider: next.origin.provider, sessionId: next.origin.sessionId,
          requestId: next.requestId, wake: next.mode === 'wake', expiresInMs: next.expiresInMs,
          message: `Claudex task ${next.taskId} reached terminal revision ${next.revision}. Read claudex_status for its current result and blockers. This notification is not proof that the goal was achieved and grants no new authority.`,
        } });
        if (!receipt || typeof receipt.messageId !== 'string') throw new Error('Missing notification receipt');
        state = 'queued';
      }
    } catch { reason = 'notification-outcome-unknown'; }
    await hub.mutate(ledger => {
      const delivery = ledger.tasks[next.taskId].notification.deliveries.find(item => item.requestId === next.requestId);
      delivery.state = state;
      if (reason) delivery.reason = reason;
      if (receipt) { delivery.messageId = receipt.messageId; delivery.deliveryStatus = receipt.deliveryStatus ?? receipt.state; }
    });
  }
  return 'more';
}

export function observeNotificationResume(hub) {
  const local = stateFor(hub);
  local.watcher = watch(dirname(hub.root), (_event, filename) => {
    if (filename === null || String(filename) === 'app-stop.json') scheduleNotifications(hub);
  });
  local.watcher.on('error', error => { hub.closed = true; hub.emit('fatal', error); hub.emit('change'); });
  local.watcher.unref?.();
  scheduleNotifications(hub);
}

export function scheduleNotifications(hub) {
  if (hub.closed || !hub.state || !Object.values(hub.state.tasks).some(pending)) return;
  const local = stateFor(hub);
  if (local.queued) return;
  if (local.running) { local.changed = true; return; }
  local.queued = true;
  queueMicrotask(() => {
    local.queued = false;
    if (hub.closed) return;
    local.changed = false;
    let outcome;
    local.running = publish(hub).then(value => { outcome = value; }).catch(error => {
      // Storage failures retain the write-ahead intent; never claim successful delivery.
      hub.closed = true; hub.emit('fatal', error); hub.emit('change');
    }).finally(() => {
      local.running = null;
      if (outcome === 'more' || local.changed) scheduleNotifications(hub);
    });
  });
}

export async function drainNotifications(hub) {
  const local = stateFor(hub); local.watcher?.close(); await local.running;
}
