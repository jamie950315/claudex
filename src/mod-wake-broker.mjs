import { context, fields, identity, sameContext, validateWakeOutcome, validateModObservation, ModError } from './claude-mod-protocol.mjs';
import { peerContext } from './chat-mailbox.mjs';

export const MOD_OBSERVATION_TTL = 60000;
const observations = new WeakMap();
function records(hub, now = Date.now()) {
  let values = observations.get(hub);
  if (!values) { values = new Map(); observations.set(hub, values); }
  for (const [key, value] of values) if (value.expiresAt <= now) values.delete(key);
  return values;
}
function observe(hub, source, input) {
  const observation = validateModObservation(input), now = Date.now(), values = records(hub, now);
  const key = `${source.sessionId}:${observation.observerId}`, previous = values.get(key);
  if (previous && (!sameContext(previous.context, source) || observation.sequence <= previous.sequence
    || previous.lifecycle === 'ended')) return { observed: false, reason: 'superseded-observation' };
  if (!previous && values.size >= 64) throw new ModError('MOD_OBSERVATION_CAPACITY', 'The bounded native observation inventory is full.');
  const value = { ...observation, context: source, lastSeenAt: now, expiresAt: now + MOD_OBSERVATION_TTL,
    provenance: 'mod-self-reported', diagnosticOnly: true };
  values.set(key, value);
  return { observed: true, expiresAt: value.expiresAt, diagnosticOnly: true };
}
export function modSessionObservation(hub, target) {
  if (hub.closed) return null;
  return [...records(hub).values()].filter(value => sameContext(value.context, target) && value.lifecycle === 'loaded')
    .reverse().sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0] ?? null;
}
/** Read-time diagnosis never claims a message, renews proof, or authorizes dispatch. */
export async function modDeliveryDiagnosis(hub, message) {
  if (message.targetProvider !== 'claude' || !['mod', 'mod-self'].includes(message.wakeRoute) || message.state !== 'queued') return null;
  if (hub.closed || hub.state.nativeWakeRoute !== message.wakeRoute) return {
    reason: hub.closed ? 'broker-stopping' : 'route-inactive', observedAt: Date.now(), receiver: null, diagnosticOnly: true,
    note: 'The captured message route is not active; no fallback or replay is authorized.',
  };
  const targetChat = (await hub.chatMailbox.list()).find(chat => chat.provider === 'claude' && chat.sessionId === message.targetSessionId);
  const target = targetChat ? { sessionId: targetChat.sessionId, cwd: targetChat.cwd } : null;
  let reason = null;
  try {
    const mapped = await hub.claudeWakeManifest?.verify(message.targetSessionId);
    if (!target || !mapped || mapped.cwd !== target.cwd) reason = 'target-unmapped';
  } catch { reason = 'target-unmapped'; }
  const observation = target ? modSessionObservation(hub, target) : null;
  if (!reason && hub.closed) reason = 'broker-stopping';
  if (!reason && targetChat.phase === 'ended') reason = 'waiting-for-resume';
  if (!reason && message.wakeRoute === 'mod-self') {
    reason = !observation ? 'no-live-receiver' : !observation.nativeWake ? 'native-wake-disabled'
      : !observation.selfWake ? 'self-delivery-disabled'
      : ['hold', 'refuse'].includes(observation.inboundPolicy) ? `native-inbound-${observation.inboundPolicy}`
      : observation.inboundPolicy === 'unknown' ? 'native-policy-unknown' : 'receiver-observed';
  }
  if (!reason) {
    const senders = [...records(hub).values()].filter(value => value.lifecycle === 'loaded'
      && value.context.sessionId !== message.targetSessionId && value.nativeWake);
    reason = !senders.length ? 'no-live-receiver' : !senders.some(value => value.capabilities.sendMessage)
      ? 'missing-SendMessage' : 'sender-observed';
  }
  return { reason, observedAt: Date.now(), receiver: observation, diagnosticOnly: true,
    note: 'Observations do not prove dispatch readiness, recipient ACK, or work completion.' };
}

/** Controller-only routing. No native invocation is started by a wait or route change. */
export async function dispatchModWake(hub, envelope, actor) {
  const { method, params } = envelope;
  if (actor.task) throw new Error('Only an external controller may use native Mod delivery.');
  if (method === 'native_wake') {
    fields(params, ['route']);
    if (params.route !== undefined) {
      if (hub.closed || !['mod', 'mod-self', 'renderer'].includes(params.route)) throw new Error('Invalid native wake route or stopping broker.');
      await hub.mutate(state => { state.nativeWakeRoute = params.route; });
      hub.emit('chat-wake');
    }
    return { route: hub.state.nativeWakeRoute ?? 'renderer', waitingModClients: hub.modWaiters,
      note: 'Route changes affect new messages only. Unknown dispatches never fall back or replay.' };
  }
  if (actor.peer !== 'claude') throw new Error('Native Mod endpoint is unavailable.');
  const source = context(params.source);
  if (method === 'mod_wake_observe') {
    fields(params, ['source', 'observation'], ['source', 'observation']);
    if (hub.closed) return { observed: false, reason: 'broker-stopping' };
    return observe(hub, source, params.observation);
  }
  if (!hub.claudeWakeManifest) throw new Error('Native Mod endpoint is unavailable.');
  if (method === 'mod_wake_wait') {
    fields(params, ['source', 'excludeIds', 'timeoutMs', 'self', 'observation'], ['source']);
    if (params.self !== undefined && typeof params.self !== 'boolean') throw new Error('Invalid self-delivery capability.');
    const excluded = params.excludeIds ?? [], timeout = params.timeoutMs ?? 20000;
    if (!Array.isArray(excluded) || excluded.length > 64) throw new Error('Invalid excluded message list.');
    excluded.forEach(id => identity(id, true));
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 20000 || hub.modWaiters >= 64)
      throw new Error('Invalid Mod wait bounds or waiter capacity reached.');
    if (params.observation !== undefined && !hub.closed) observe(hub, source, params.observation);
    const snapshot = async () => {
      if (hub.closed) return { state: 'stopping', messages: [] };
      const route = hub.state.nativeWakeRoute ?? 'renderer';
      if (!['mod', 'mod-self'].includes(route) || route === 'mod-self' && params.self !== true) return { state: 'disabled', messages: [] };
      const pending = await hub.chatMailbox.pendingWakes(), chats = await hub.chatMailbox.list();
      const messages = pending.filter(m => m.wakeRoute === route && (route === 'mod-self' ? m.targetSessionId === source.sessionId : m.targetSessionId !== source.sessionId) && !excluded.includes(m.messageId))
        .slice(0, 64).map(m => {
          const chat = chats.find(c => c.provider === 'claude' && c.sessionId === m.targetSessionId);
          return { messageId: m.messageId, route, target: { sessionId: m.targetSessionId, cwd: chat.cwd }, expiresAt: m.expiresAt };
        });
      return { state: messages.length ? 'pending' : 'waiting', messages };
    };
    hub.modWaiters++;
    try {
      if (timeout === 0) return await snapshot();
      return await new Promise((resolve, reject) => {
        let done = false, checking = false, again = false;
        const finish = (error, value) => {
          if (done) return; done = true; clearTimeout(timer);
          hub.off('chat-wake', check); hub.off('change', check); envelope.signal?.removeEventListener('abort', aborted);
          error ? reject(error) : resolve(value);
        };
        const aborted = () => {
          if (params.observation) {
            const values = records(hub), key = `${source.sessionId}:${params.observation.observerId}`;
            if (values.get(key)?.sequence === params.observation.sequence) values.delete(key);
          }
          finish(null, { state: 'disconnected', messages: [] });
        };
        const check = async () => {
          if (done) return;
          if (checking) { again = true; return; }
          checking = true;
          const reading = snapshot(); hub.modReads.add(reading);
          try { const value = await reading; if (value.state !== 'waiting') finish(null, value); }
          catch (error) { finish(error); }
          finally { hub.modReads.delete(reading); checking = false; if (again && !done) { again = false; void check(); } }
        };
        const timer = setTimeout(() => finish(null, { state: 'waiting', messages: [] }), timeout);
        hub.on('chat-wake', check); hub.on('change', check); envelope.signal?.addEventListener('abort', aborted, { once: true });
        if (envelope.signal?.aborted) aborted(); else void check();
      });
    } finally { hub.modWaiters--; }
  }
  fields(params, ['source', 'target', 'messageId', 'claimId', 'status', 'reason', 'route'], ['source', 'target', 'messageId']);
  const route = params.route ?? 'mod';
  if (!['mod', 'mod-self'].includes(route)) throw new Error('Invalid native Mod route.');
  const target = context(params.target); identity(params.messageId, true);
  const verifyTarget = async () => {
    try {
      const mapped = await hub.claudeWakeManifest.verify(target.sessionId);
      if (mapped.cwd !== target.cwd) throw new Error('Directory changed');
      return mapped;
    } catch {
      const error = new Error('The exact recipient metadata is unavailable or changed. No new dispatch is permitted.');
      error.code = 'MOD_TARGET_UNAVAILABLE'; throw error;
    }
  };
  const message = await hub.chatMailbox.status(params.messageId);
  if (message.wakeRoute !== route || message.targetProvider !== 'claude' || message.targetSessionId !== target.sessionId
    || message.wakeRequested !== true || (route === 'mod-self' ? !sameContext(source, target) : source.sessionId === target.sessionId)) throw new Error('Native Mod message identity/route mismatch.');
  if (method === 'mod_wake_claim') {
    if (hub.closed || hub.state.nativeWakeRoute !== route) return { claimed: false };
    await verifyTarget();
    if (hub.closed || hub.state.nativeWakeRoute !== route) return { claimed: false };
    const claim = await hub.chatMailbox.claimWake(params.messageId, { route, source });
    hub.emit('chat-wake');
    return claim ? { claimed: true, messageId: claim.messageId, claimId: claim.wake.claimId, context: claim.context } : { claimed: false };
  }
  identity(params.claimId, true);
  if (!message.wake?.source || !sameContext(message.wake.source, source) || message.wake.claimId !== params.claimId)
    throw new Error('Native Mod claim owner changed.');
  if (method === 'mod_wake_check' || method === 'mod_wake_receive') {
    const states = method === 'mod_wake_receive' && route === 'mod-self' ? ['dispatching', 'submitted'] : ['dispatching'];
    if (method === 'mod_wake_receive' && route !== 'mod-self') throw new Error('Self receipt requires its explicit route.');
    if (hub.closed || hub.state.nativeWakeRoute !== route || !states.includes(message.wake.state)
      || message.expiresAt <= Date.now()) throw new Error('Native Mod dispatch no longer authorized.');
    await verifyTarget();
    const latest = await hub.chatMailbox.status(params.messageId);
    if (hub.closed || hub.state.nativeWakeRoute !== route || !states.includes(latest.wake?.state)
      || latest.wake.claimId !== params.claimId || !sameContext(latest.wake.source, source)
      || latest.expiresAt <= Date.now()) throw new Error('Native Mod dispatch no longer authorized.');
    const ownContext = method === 'mod_wake_receive'
      ? await hub.chatMailbox.receiveSelfWake(params.messageId, { claimId: params.claimId, source })
      : route === 'mod-self' ? peerContext(latest) : undefined;
    if (hub.closed || hub.state.nativeWakeRoute !== route) throw new Error('Native Mod dispatch no longer authorized.');
    return { ready: true, ...(ownContext === undefined ? {} : { context: ownContext }) };
  }
  if (method === 'mod_wake_receipt') {
    validateWakeOutcome(params.status, params.reason);
    if (params.status === 'submitted' && route !== 'mod-self') throw new Error('Only self inbox writes can be submitted.');
    const result = await hub.chatMailbox.finishWake(params.messageId, { claimId: params.claimId, state: params.status,
      detail: `Native Mod: ${params.reason}. Queue acceptance, recipient ACK and work completion are separate.` });
    hub.emit('chat-wake'); return result;
  }
  throw new Error('Unsupported native Mod operation.');
}
