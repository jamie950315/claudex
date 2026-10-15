import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { CacheWarmManager } from './cache-warm.mjs';
import { createCodexUsageCounter } from './codex-cache-usage.mjs';
import { createCodexCacheNative } from './codex-cache-native.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const risks = 'Best-effort only: no composer-draft inspection and no per-turn tool prohibition. Existing native model, effort and permissions are inherited. Real OK turns consume plan usage and remain in history. Cache reads have no token limit. The output-token budget stops future refreshes; it is not a hard output cap. The 30-minute evidence window is a local scheduling assumption, not a configurable or verified native TTL. Busy, missed deadlines, tool activity and uncertain delivery stop warming; uncertain input is never resent.';
function identity(p) {
  if (!UUID.test(p?.sessionId ?? '') || typeof p.cwd !== 'string' || !isAbsolute(p.cwd)
    || resolve(p.cwd) !== p.cwd || /[\x00-\x1f\x7f]/u.test(p.cwd) || p.cwd.length > 4096)
    throw new Error('Exact native Codex session UUID and absolute cwd are required.');
}
function bounds(p) {
  if (p.bestEffort !== true) throw new Error('Explicit best-effort consent is required.');
  if (p.maxReadTokens !== undefined && p.maxReadTokens !== null
    && (!Number.isSafeInteger(p.maxReadTokens) || p.maxReadTokens < 1 || p.maxReadTokens > 100000000))
    throw new Error('Invalid Codex cache-warm maxReadTokens.');
  if (p.fixedEnd !== undefined && p.fixedEnd !== true) throw new Error('Invalid Codex cache-warm fixedEnd.');
  if (p.compact !== undefined && typeof p.compact !== 'boolean') throw new Error('Invalid Codex cache-warm compact.');
  const value = { refreshMinutes: p.refreshMinutes ?? 25, maxMinutes: p.maxMinutes ?? 60,
    maxRefreshes: p.maxRefreshes ?? 3, maxReadTokens: null, maxOutputTokens: p.maxOutputTokens ?? 256,
    ...(p.fixedEnd ? { fixedEnd: true } : {}), ...(p.compact === undefined ? {} : { compact: p.compact }) };
  for (const [key, max] of Object.entries({ refreshMinutes: 25, maxMinutes: 10080, maxRefreshes: 500, maxOutputTokens: 1000000 }))
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > max) throw new Error(`Invalid Codex cache-warm ${key}.`);
  return value;
}

/** Broker-owned native observer and finite scheduler. No external usage reports
 * or dispatch claims are accepted. Status never starts a native connection. */
export class CodexCacheWarmer {
  constructor({ root, stopped = async () => false, onUserMessage, compactAfterWarm, native = createCodexCacheNative({ syncRoot: dirname(root) }), now = Date.now,
    after = (ms, callback) => { const timer = setTimeout(callback, ms); timer.unref?.(); return { cancel: () => clearTimeout(timer) }; } }) {
    this.manager = new CacheWarmManager({ root, provider: 'codex', stopped, now, onUserMessage, compactAfterWarm });
    Object.assign(this, { stopped, native, now, after });
    this.bindings = new Map(); this.nativeReasons = new Map(); this.previews = new Map(); this.serial = Promise.resolve(); this.closed = false; this.failure = null;
  }
  async initialize() { await this.manager.initialize(); return this; }
  enqueue(fn) { const work = this.serial.catch(() => {}).then(fn); this.serial = work; return work; }
  background(fn, phase) {
    const work = this.enqueue(fn).catch(() => this.providerFailure(phase));
    this.serial = work; return work;
  }
  async providerFailure(phase) {
    this.closed = true;
    this.failure ??= { code: 'CACHE_WARM_PROVIDER_FAILED', reason: 'native-service-failed', phase };
    this.previews.clear();
    for (const b of this.bindings.values()) {
      b.enabled = false; b.retired = true; this.cancel(b); b.expiry?.cancel(); b.completion?.cancel();
    }
    // Revocation is visible even if durable publication or native cleanup fails.
    // In-flight attempts become uncertain, never fresh dispatch candidates.
    const results = await Promise.allSettled([this.manager.close(this.failure),
      ...[...this.bindings.values()].map(b => Promise.resolve().then(() => b.handle?.close()))]);
    this.failure.cleanupFailed = results.some(result => result.status === 'rejected');
    this.bindings.clear();
  }
  valid(b) { return !this.closed && !b.retired && this.bindings.get(b.sessionId) === b; }
  fields(b) { return { sessionId: b.sessionId, cwd: b.cwd, instanceId: b.instanceId, epoch: b.epoch }; }
  cancel(b) { b.timer?.cancel(); b.timer = null; }
  async detach(b) {
    if (b.retired) return;
    this.cancel(b); b.expiry?.cancel(); b.completion?.cancel(); b.retired = true;
    this.nativeReasons.delete(b.sessionId); this.nativeReasons.set(b.sessionId, b.reason);
    if (this.nativeReasons.size > 64) this.nativeReasons.delete(this.nativeReasons.keys().next().value);
    try { await b.handle?.close(); }
    finally {
      await this.manager.observe({ ...this.fields(b), sequence: ++b.sequence, phase: 'ended' });
      if (this.bindings.get(b.sessionId) === b) this.bindings.delete(b.sessionId);
    }
  }
  async list(params = {}) {
    if (params.sessionId !== undefined || params.cwd !== undefined) identity(params);
    const result = await this.manager.list();
    const match = value => params.sessionId === undefined || value.sessionId === params.sessionId && value.cwd === params.cwd;
    return { ...result, bestEffort: true, limitations: risks,
      providerStatus: { ...result.providerStatus, closed: this.closed || result.providerStatus.closed,
        ...(this.failure ?? {}), bindings: this.bindings.size },
      usageProvenance: 'native-request-and-cumulative-delta', modelEvidence: 'configured-thread-settings', upstreamResponseIds: false,
      policies: result.policies.filter(match).map(p => ({ ...p, nativeReason: this.bindings.get(p.sessionId)?.reason ?? this.nativeReasons.get(p.sessionId) ?? p.reason })),
      attempts: result.attempts.filter(match) };
  }
  async prepare(params, actor) {
    identity(params); const limits = bounds(params);
    if (this.closed || await this.stopped()) throw new Error('Claudex is stopped; warming cannot be prepared.');
    for (const [id, p] of this.previews) if (p.expiresAt <= this.now()) this.previews.delete(id);
    if (this.previews.size >= 64) throw new Error('Cache-warm preview capacity reached.');
    const state = await this.native.inspect(params);
    if (this.closed || await this.stopped()) throw new Error('Claudex stopped during native inspection.');
    if (this.previews.size >= 64) throw new Error('Cache-warm preview capacity reached.');
    const preview = { confirmationId: randomUUID(), sessionId: params.sessionId, cwd: params.cwd,
      ...limits, bestEffort: true, expiresAt: this.now() + 120000, native: state, risks };
    this.previews.set(preview.confirmationId, { ...preview, actor });
    return { ...preview, state: 'confirmation-required', inferenceStarted: false };
  }
  async confirm(params, actor) {
    return this.enqueue(async () => {
      const p = this.previews.get(params.confirmationId);
      if (!p || p.actor !== actor) throw new Error('Cache-warm confirmation is missing, consumed or belongs to another controller.');
      if (params.sessionId !== undefined || params.cwd !== undefined) {
        identity(params);
        if (params.sessionId !== p.sessionId || params.cwd !== p.cwd)
          throw new Error('Cache-warm confirmation belongs to another native chat.');
      }
      this.previews.delete(params.confirmationId);
      if (params.bestEffort !== true || this.now() >= p.expiresAt || this.closed || await this.stopped()) throw new Error('Cache-warm confirmation expired or explicit consent is missing.');
      if (this.manager.pending(p.sessionId)) throw new Error('A native attempt still awaits evidence; inspect it before re-enabling.');
      const state = await this.native.inspect(p);
      if (state.fingerprint !== p.native.fingerprint) throw new Error('Native configuration or owner changed; prepare again.');
      if (!this.bindings.has(p.sessionId) && this.bindings.size >= 64) throw new Error('Native cache-warm binding capacity reached.');
      const old = this.bindings.get(p.sessionId);
      if (old) await this.detach(old);
      this.bindingClock = Math.max(this.now(), (this.bindingClock ?? -1) + 1);
      const b = { sessionId: p.sessionId, cwd: p.cwd, instanceId: `warm-${this.bindingClock}-${randomUUID()}`, epoch: 0, sequence: 0,
        fingerprint: state.fingerprint, model: state.model, effort: state.effort, phase: state.phase,
        counter: createCodexUsageCounter(p.sessionId), samples: [], enabled: false, reason: 'awaiting-evidence', turn: null };
      this.bindings.set(b.sessionId, b);
      this.nativeReasons.delete(b.sessionId);
      try {
        b.handle = await this.native.connect(p, event => {
          if (!this.valid(b)) return;
          b.queued = (b.queued ?? 0) + 1;
          if (b.queued > 256) { b.overflow = true; return; }
          void this.background(async () => {
            b.queued--;
            if (!this.valid(b)) return;
            try { if (b.overflow) throw new Error('native-event-capacity'); await this.event(b, event); }
            catch (error) { await this.fail(b, error.message, true); }
          }, 'native-events');
        });
        if (b.handle.state.fingerprint !== p.native.fingerprint || this.now() >= p.expiresAt || this.closed || await this.stopped())
          throw new Error('Native binding changed or confirmation expired.');
        b.phase = b.handle.state.phase; b.turn = b.handle.initialTurn;
        await this.observe(b);
        const reply = await this.manager.configure({ provider: 'codex', ...this.fields(b), ...bounds(p), bestEffort: true,
          enabled: true, requestId: `codex-confirm:${p.confirmationId}` });
        b.enabled = reply.policy.enabled;
        b.reason = reply.reason;
        this.expire(b, reply.policy.until);
        b.handle.listen();
        if (Number.isFinite(reply.nextAt)) this.schedule(b, reply.nextAt);
        return { ...reply, bestEffort: true, risks, awaitingFreshUsage: false };
      } catch (error) { await this.detach(b); throw error; }
    });
  }
  async off(params) {
    identity(params);
    for (const [id, preview] of this.previews) if (preview.sessionId === params.sessionId && preview.cwd === params.cwd) this.previews.delete(id);
    const live = this.bindings.get(params.sessionId);
    if (live && live.cwd !== params.cwd) throw new Error('Native directory changed.');
    // Revoke in-memory admission before waiting for an in-flight native preflight.
    if (live) { live.enabled = false; this.cancel(live); }
    return this.enqueue(async () => {
      const b = this.bindings.get(params.sessionId);
      if (b && b.cwd !== params.cwd) throw new Error('Native directory changed.');
      const reply = await this.manager.configure({ provider: 'codex', ...params, enabled: false });
      if (b) { b.enabled = false; b.reason = 'disabled'; this.cancel(b); b.expiry?.cancel(); if (!b.attempt) await this.detach(b); }
      return reply;
    });
  }
  async fail(b, reason, uncertain = false) {
    this.cancel(b); b.enabled = false; b.reason = reason;
    await this.manager.configure({ provider: 'codex', sessionId: b.sessionId, cwd: b.cwd, enabled: false });
    // Keep an already dispatched turn's accounting until completion, even after off.
    if (!b.attempt || uncertain) await this.detach(b);
  }
  async observe(b, sample, phase = b.phase) {
    const result = await this.manager.observe({ ...this.fields(b), sequence: ++b.sequence, phase,
      ...(sample ? { sample } : {}), ...(b.attempt ? { attemptId: b.attempt.id } : {}) });
    if (result.observed !== true) throw new Error(`native-observation-refused:${result.reason}`);
    return result;
  }
  sample(b, event) {
    const firstRequest = b.attempt?.kind === 'prime' && b.warmTurnId === event.turnId
      && b.turn?.id === event.turnId && b.turn.observedStart === true;
    const result = b.counter.observe({ threadId: b.sessionId, turnId: event.turnId, tokenUsage: event.tokenUsage }, { firstRequest });
    if (result.state !== 'sample') return;
    if (!b.turn || b.turn.id !== event.turnId || !Number.isSafeInteger(b.turn.startedAt)) throw new Error('native-turn-evidence-unavailable');
    if (b.samples.length >= 64) throw new Error('native-response-capacity');
    const u = result.usage;
    b.samples.push({ id: result.sampleId, startedAt: b.turn.startedAt, completedAt: event.at,
      model: b.model, effort: b.effort, ttlMs: 1800000, ttlSource: 'configured-window',
      inputTokens: u.inputTokens, cacheReadTokens: u.cachedInputTokens, cacheWriteTokens: u.cacheWriteInputTokens,
      outputTokens: u.outputTokens, stopReason: 'end_turn', ...(b.attempt ? { attemptId: b.attempt.id } : {}) });
  }
  // The schedule is over whatever the outcome; an uncertain compaction is never repeated.
  async finishCompaction(b, attemptId, outcome) {
    b.compacting = null; this.cancel(b); b.completion?.cancel(); b.completion = null;
    b.enabled = false; b.reason = outcome === 'compacted' ? 'compacted' : outcome === 'rejected' ? 'compact-skipped' : 'native-uncertain';
    try { await this.manager.receipt({ ...this.fields(b), attemptId, outcome }); }
    finally { await this.detach(b); }
  }
  async event(b, e) {
    if (b.compacting) {
      // Only this observer's own compaction is followed here: its native turn
      // from start to completion, with the compaction itself reported in between.
      const c = b.compacting;
      if (e.type === 'compacted') c.seen = true;
      else if (e.type === 'invalidated') await this.finishCompaction(b, c.attemptId, 'uncertain');
      else if (e.type === 'start') { if (c.turnId === undefined) c.turnId = e.turnId; else await this.finishCompaction(b, c.attemptId, 'uncertain'); }
      else if (e.type === 'complete') await this.finishCompaction(b, c.attemptId,
        e.turnId === c.turnId && e.status === 'completed' && c.seen ? 'compacted' : 'uncertain');
      return;
    }
    if (e.type === 'invalidated') return this.fail(b, e.reason, true);
    if (e.type === 'start') {
      if (b.turn?.id === e.turnId && b.phase === 'busy') {
        if (b.turn.startedAt !== e.startedAt) return this.fail(b, 'native-turn-start-changed', true);
        return;
      }
      this.cancel(b);
      if (b.attempt && b.warmTurnId !== e.turnId) return this.fail(b, 'competing-native-turn', true);
      b.epoch++; b.phase = 'busy'; b.samples = []; b.toolSeen = false;
      b.turn = { id: e.turnId, startedAt: e.startedAt, observedStart: true, usage: false };
      await this.observe(b); return;
    }
    if (e.type === 'tool') {
      if (b.attempt && b.warmTurnId === e.turnId) { b.toolSeen = true; await this.fail(b, 'native-tool-activity', false); }
      return;
    }
    if (e.type === 'usage') { if (b.turn?.id === e.turnId) b.turn.usage = true; this.sample(b, e); return; }
    if (e.type !== 'complete') return;
    if (!b.turn || b.turn.id !== e.turnId) return this.fail(b, 'native-completion-identity-changed', true);
    b.completion?.cancel(); b.completion = null;
    const own = Boolean(b.attempt);
    // Our initial warm turn can resolve prompt settings too. A whole observed
    // model turn without a snapshot establishes the change-only runtime case;
    // an intercepted enrollment command with no request establishes nothing.
    if (b.handle.settingsReady !== true && b.turn.observedStart && b.turn.usage)
      b.handle.acceptUnreportedSettings?.();
    if (!b.samples.length) {
      if (own) return this.fail(b, 'native-usage-unavailable', true);
      b.phase = 'idle'; b.turn = null; b.reason = 'awaiting-evidence';
      const reply = await this.observe(b);
      b.reason = reply.reason;
      if (Number.isFinite(reply.nextAt)) this.schedule(b, reply.nextAt);
      return;
    }
    const samples = own ? b.samples : b.samples.slice(-1);
    for (const sample of samples) await this.observe(b, { ...sample,
      stopReason: e.status !== 'completed' ? 'aborted' : own && b.toolSeen ? 'tool_use' : 'end_turn' }, 'busy');
    b.phase = 'idle';
    const reply = await this.observe(b);
    b.attempt = null; b.warmTurnId = null; b.turn = null; b.samples = [];
    b.enabled = b.enabled && reply.policy?.enabled === true;
    b.reason = reply.reason;
    // With no further warm request, the one compaction at the end may be due.
    const at = Number.isFinite(reply.nextAt) ? reply.nextAt : reply.compactAt;
    if (!b.enabled || !Number.isFinite(at)) { await this.detach(b); return; }
    // A message of the user's own may have restarted the limit.
    if (reply.policy.until !== b.until) this.expire(b, reply.policy.until);
    this.schedule(b, at);
  }
  expire(b, until) {
    b.expiry?.cancel(); b.until = until;
    b.expiry = this.after(Math.max(0, until - this.now()), () => {
      void this.background(async () => {
        // The compaction that follows the limit can be due after its end time.
        if (!this.valid(b) || b.compacting || await this.manager.compactionAt(this.fields(b)) !== null) return;
        return this.fail(b, 'duration-limit', false);
      }, 'expiry');
    });
  }
  schedule(b, nextAt) {
    this.cancel(b);
    b.timer = this.after(Math.max(0, nextAt - this.now()), () => {
      void this.background(async () => {
        if (!this.valid(b) || !b.enabled) return;
        try { await this.tick(b); } catch (error) { await this.fail(b, error.message, true); }
      }, 'schedule');
    });
  }
  async tick(b) {
    this.cancel(b);
    if (await this.stopped()) return this.fail(b, 'app-stopped');
    const state = await b.handle.inspect();
    if (!this.valid(b) || !b.enabled) return;
    if (state.phase !== 'idle' || state.fingerprint !== b.fingerprint) return this.fail(b, 'native-busy-or-configuration-changed');
    const claim = await this.manager.claim(this.fields(b));
    if (!claim.claimed) {
      if (Number.isFinite(claim.compactAt)) { if (this.now() >= claim.compactAt) await this.compact(b, state); else this.schedule(b, claim.compactAt); }
      else if (claim.reason === 'not-due' && claim.nextAt) this.schedule(b, claim.nextAt);
      else await this.fail(b, claim.reason);
      return;
    }
    b.attempt = claim.attempt;
    let owner, outcome = 'rejected';
    try {
      owner = await b.handle.preflight();
      if (owner.status !== 'ready' || owner.ownerClientId !== state.ownerClientId) throw new Error('native-owner-unavailable');
      const checked = await this.manager.check({ ...this.fields(b), attemptId: claim.attempt.id });
      if (!checked.ready) throw new Error(checked.reason);
      outcome = 'uncertain';
      const result = await owner.dispatch({ messageId: `cache-warm:${claim.attempt.id}`, text: claim.attempt.prompt,
        beforeDispatch: async () => {
          const fresh = await b.handle.inspect();
          const stopped = await this.stopped();
          if (!this.valid(b) || !b.enabled || stopped || this.now() >= checked.expiresAt
            || fresh.phase !== 'idle' || fresh.fingerprint !== b.fingerprint) throw new Error('native-dispatch-fence');
        } });
      if (result.status === 'accepted' && typeof result.turnId === 'string' && result.turnId) {
        outcome = 'submitted'; b.warmTurnId = result.turnId;
        b.completion = this.after(180000, () => {
          void this.background(() => this.valid(b) && this.fail(b, 'native-completion-timeout', true), 'completion');
        });
      } else if (['busy', 'rejected', 'unavailable'].includes(result.status)) outcome = 'rejected';
    } finally {
      owner?.close?.();
      await this.manager.receipt({ ...this.fields(b), attemptId: claim.attempt.id, outcome });
      if (outcome !== 'submitted') { b.attempt = null; await this.fail(b, `native-${outcome}`); }
    }
  }
  // The limit is used up: ask the Desktop owner to compact once while the
  // last request's assumed cache window still holds. Not a prompt or a turn of ours.
  async compact(b, state) {
    const claim = await this.manager.claim({ ...this.fields(b), kind: 'compact' });
    if (!claim.claimed) return this.fail(b, claim.reason);
    const attemptId = claim.attempt.id;
    let owner, outcome = 'rejected';
    try {
      owner = await b.handle.preflight();
      if (owner.status !== 'ready' || owner.ownerClientId !== state.ownerClientId) throw new Error('native-owner-unavailable');
      const checked = await this.manager.check({ ...this.fields(b), attemptId });
      if (!checked.ready) throw new Error(checked.reason);
      outcome = 'uncertain';
      const result = await owner.compact({ beforeDispatch: async () => {
        const fresh = await b.handle.inspect();
        const stopped = await this.stopped();
        if (!this.valid(b) || !b.enabled || stopped || this.now() >= checked.expiresAt
          || fresh.phase !== 'idle' || fresh.fingerprint !== b.fingerprint) throw new Error('native-dispatch-fence');
        // From here the native compaction is this observer's own evidence.
        b.handle.expectCompaction(); b.compacting = { attemptId };
      } });
      if (result.status === 'accepted') {
        outcome = 'accepted';
        b.completion = this.after(600000, () => {
          void this.background(() => this.valid(b) && b.compacting?.attemptId === attemptId
            && this.finishCompaction(b, attemptId, 'uncertain'), 'compaction');
        });
      } else if (['busy', 'rejected', 'unavailable'].includes(result.status)) outcome = 'rejected';
    } catch { /* The outcome set before the failing step stands. */ }
    finally {
      owner?.close?.();
      if (outcome !== 'accepted') await this.finishCompaction(b, attemptId, outcome);
    }
  }
  async close() {
    this.closed = true; this.previews.clear();
    for (const b of this.bindings.values()) { this.cancel(b); b.expiry?.cancel(); b.completion?.cancel(); }
    await this.serial.catch(() => {});
    for (const b of this.bindings.values()) await this.detach(b);
    await this.manager.close();
  }
}
