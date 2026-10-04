import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { privateDir, privateJSON, writeReceipt } from './claude-mod-storage.mjs';

export const CACHE_WARM_PROMPT = 'Cache-retention maintenance only. Reply with exactly OK. Do not call tools, continue previous work, or make any changes.';
const MAX_POLICIES = 64, MAX_ATTEMPTS = 2048, MAX_BYTES = 2 * 1024 * 1024;
const OUTPUT_RESERVATION = 128;
const READ_OVERHEAD = 256;
const live = new Set(['reserved', 'dispatching', 'submitted']);
const clone = value => structuredClone(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const word = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/u.test(value);
const error = (code, message) => Object.assign(new Error(message), { code });
function requireValue(value, message = 'Invalid cache-warming input.') {
  if (!value) throw error('CACHE_WARM_INVALID', message);
}
function identity(value) {
  requireValue(value && /^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId ?? '')
    && typeof value.cwd === 'string' && isAbsolute(value.cwd) && resolve(value.cwd) === value.cwd
    && value.cwd.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value.cwd));
  return value.sessionId;
}
function bindingIdentity(value) {
  identity(value); requireValue(word(value.instanceId));
}
function sampleValue(value, now, provider) {
  requireValue(value && word(value.id) && word(value.model) && word(value.effort)
    && integer(value.startedAt) && integer(value.completedAt) && value.completedAt >= value.startedAt
    && value.completedAt <= now && (provider === 'codex'
      ? value.ttlMs === 1800000 && value.ttlSource === 'configured-window'
      : [300000, 3600000].includes(value.ttlMs))
    && value.completedAt - value.startedAt < value.ttlMs
    && ['native-setting', 'conservative-minimum', 'configured-window'].includes(value.ttlSource)
    && (value.ttlSource !== 'conservative-minimum' || value.ttlMs === 300000)
    && ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].every(key => integer(value[key]))
    && integer(value.cacheReadTokens + value.cacheWriteTokens + READ_OVERHEAD)
    && word(value.stopReason) && (value.attemptId === undefined || word(value.attemptId)));
  return Object.fromEntries(['id', 'startedAt', 'completedAt', 'model', 'effort', 'ttlMs', 'ttlSource',
    'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'stopReason',
    ...(value.attemptId === undefined ? [] : ['attemptId'])].map(key => [key, value[key]]));
}
const prefix = sample => sample.cacheReadTokens + sample.cacheWriteTokens;
const windowMs = (sample, policy) => policy?.ttlPreference === '5m' ? Math.min(sample.ttlMs, 300000) : sample.ttlMs;
const expires = (sample, policy) => sample.startedAt + windowMs(sample, policy);
const nextAt = (sample, policy) => policy?.provider === 'codex'
  ? sample.startedAt + policy.refreshMinutes * 60000
  : expires(sample, policy) - (windowMs(sample, policy) === 300000 ? 60000 : 300000);
const successful = sample => ['end_turn', 'stop_sequence'].includes(sample.stopReason);
function validate(state, provider) {
  requireValue(state?.version === 1 && Array.isArray(state.policies) && state.policies.length <= MAX_POLICIES
    && Array.isArray(state.attempts) && state.attempts.length <= MAX_ATTEMPTS
    && Array.isArray(state.requests) && state.requests.length <= MAX_ATTEMPTS, 'Invalid cache-warming journal.');
  const ids = new Set(), attempts = new Set();
  for (const p of state.policies) {
    identity(p);
    requireValue(p.provider === provider && !ids.has(p.sessionId) && integer(p.generation, 1)
      && typeof p.enabled === 'boolean' && integer(p.until) && integer(p.updatedAt)
      && integer(p.maxRefreshes, 1, 100) && integer(p.maxReadTokens, 1, 100000000)
      && integer(p.maxOutputTokens, 1, 1000000) && integer(p.maxMinutes, 1, 1440)
      && (p.model === null || word(p.model)) && (p.effort === null || word(p.effort))
      && (p.ttlMs === null || (provider === 'codex' ? p.ttlMs === 1800000 : [300000, 3600000].includes(p.ttlMs)))
      && (provider === 'codex'
        ? p.ttlPreference === undefined && integer(p.refreshMinutes, 1, 25)
          && typeof p.bestEffort === 'boolean' && (!p.enabled || p.bestEffort)
        : p.ttlPreference === undefined || ['1h', '5m'].includes(p.ttlPreference)));
    ids.add(p.sessionId);
  }
  for (const a of state.attempts) {
    bindingIdentity(a);
    requireValue(ids.has(a.sessionId) && word(a.id) && !attempts.has(a.id) && integer(a.generation, 1)
      && integer(a.epoch) && integer(a.createdAt) && integer(a.expiresAt) && a.expiresAt > a.createdAt
      && integer(a.nextAt) && integer(a.reservedReadTokens, 1) && integer(a.reservedOutputTokens, 1)
      && integer(a.requiredPrefixTokens, 1) && a.reservedReadTokens >= a.requiredPrefixTokens
      && word(a.sampleId) && word(a.model) && word(a.effort)
      && ['reserved', 'dispatching', 'submitted', 'rejected', 'uncertain', 'revoked', 'verified', 'failed'].includes(a.state)
      && (a.authorizedAt === undefined || integer(a.authorizedAt))
      && (a.actual === undefined || ['cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'outputTokens'].every(key => integer(a.actual[key])))
      && (a.responseIds === undefined || Array.isArray(a.responseIds) && a.responseIds.length <= 64
        && a.responseIds.every(word) && new Set(a.responseIds).size === a.responseIds.length)
      && (a.cacheVerified === undefined || provider === 'codex' && typeof a.cacheVerified === 'boolean'
        && (!a.cacheVerified || integer(a.authorizedAt) && a.responseIds?.length > 0 && a.actual !== undefined)));
    attempts.add(a.id);
  }
  const requests = new Set();
  for (const r of state.requests) {
    requireValue(word(r.requestId) && !requests.has(r.requestId) && ids.has(r.sessionId)
      && typeof r.payload === 'string' && r.payload.length <= 8192 && integer(r.generation, 1));
    requests.add(r.requestId);
  }
  return state;
}

/** Broker-owned bounded intent ledger. Native observations are ephemeral and
 * never restore a dispatch lease after restart. No method performs inference. */
export class CacheWarmManager {
  constructor({ root, provider = 'claude', now = Date.now, stopped = async () => false }) {
    requireValue(typeof root === 'string' && isAbsolute(root) && resolve(root) === root);
    requireValue(['claude', 'codex'].includes(provider), 'Unsupported cache-warming provider.');
    this.provider = provider;
    this.root = root; this.path = join(root, provider === 'codex' ? 'codex-cache-warm.json' : 'cache-warm.json'); this.now = now; this.stopped = stopped;
    this.state = { version: 1, policies: [], attempts: [], requests: [] };
    this.bindings = new Map(); this.retired = new Map(); this.serial = Promise.resolve();
    this.closed = false; this.initialized = false; this.exists = false;
  }
  async initialize() {
    return this.transaction(async () => {
      if (this.initialized) return this;
      try { await privateDir(this.root); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; this.initialized = true; return this; }
      const saved = await privateJSON(this.path, { optional: true, maxBytes: MAX_BYTES });
      if (saved) {
        this.state = validate(saved, this.provider); this.exists = true;
        let changed = false;
        for (const a of this.state.attempts) if (live.has(a.state)) {
          a.state = a.state === 'reserved' ? 'revoked' : 'uncertain'; a.reason = 'broker-restarted'; changed = true;
          const p = this.policy(a.sessionId); p.enabled = false; p.reason = 'broker-restarted';
        }
        if (changed) await this.save();
      }
      this.initialized = true; return this;
    });
  }
  transaction(operation) {
    const work = this.serial.catch(() => {}).then(operation);
    this.serial = work; return work;
  }
  async save() {
    try {
      validate(this.state, this.provider);
      await privateDir(this.root, true);
      await writeReceipt(this.path, this.state, { exclusive: !this.exists }); this.exists = true;
    } catch (cause) {
      // Never authorize from an in-memory state whose durable publication failed.
      this.closed = true;
      throw cause;
    }
  }
  policy(id) { return this.state.policies.find(p => p.sessionId === id); }
  attempts(id, generation) { return this.state.attempts.filter(a => a.sessionId === id && (generation === undefined || a.generation === generation)); }
  pending(id) { return this.attempts(id).find(a => live.has(a.state)); }
  binding(input) {
    const b = this.bindings.get(input.sessionId);
    return b && b.cwd === input.cwd && b.instanceId === input.instanceId ? b : null;
  }
  totals(p) {
    const rows = this.attempts(p.sessionId, p.generation);
    return { refreshes: rows.length,
      readTokens: rows.reduce((sum, a) => sum + (a.actual?.cacheReadTokens ?? (['rejected', 'revoked'].includes(a.state) ? 0 : a.reservedReadTokens)), 0),
      outputTokens: rows.reduce((sum, a) => sum + (a.actual?.outputTokens ?? (['rejected', 'revoked'].includes(a.state) ? 0 : a.reservedOutputTokens)), 0) };
  }
  reason(p, b, due = false) {
    if (this.closed) return 'broker-stopping';
    if (!p?.enabled) return p?.reason ?? 'disabled';
    if (this.now() >= p.until) return 'duration-limit';
    if (!b || b.cwd !== p.cwd) return 'awaiting-native-binding';
    if (b.phase !== 'idle') return b.phase === 'ended' ? 'native-ended' : 'busy';
    if (!b.sample) return 'awaiting-evidence';
    if (!successful(b.sample)) return 'native-output-not-complete';
    if (!prefix(b.sample)) return 'no-cache-prefix';
    if (this.now() >= expires(b.sample, p)) return 'cache-expired';
    if (this.pending(p.sessionId)) return 'attempt-pending';
    const totals = this.totals(p);
    if (totals.refreshes >= p.maxRefreshes) return 'refresh-limit';
    if (totals.readTokens + prefix(b.sample) + READ_OVERHEAD > p.maxReadTokens) return 'read-budget';
    if (totals.outputTokens + OUTPUT_RESERVATION > p.maxOutputTokens) return 'output-budget';
    if (due && this.now() < nextAt(b.sample, p)) return 'not-due';
    return null;
  }
  presentation(p) {
    const b = this.bindings.get(p.sessionId), reason = this.reason(p, b);
    return { ...clone(p), status: reason ?? 'scheduled', reason: reason ?? 'scheduled', bound: Boolean(b && b.cwd === p.cwd),
      phase: b?.phase ?? null, native: { phase: b?.phase ?? 'unbound' }, totals: this.totals(p),
      sample: b?.sample ? clone(b.sample) : null,
      nextAt: !reason && b?.sample ? nextAt(b.sample, p) : null,
      effectiveTtlMs: b?.sample ? windowMs(b.sample, p) : null,
      budgetKind: 'admission-reservation-not-a-native-token-cap' };
  }
  result(p, more = {}) {
    const policy = p ? this.presentation(p) : null;
    return { policy, nextAt: policy?.nextAt ?? null, reason: policy?.reason ?? 'disabled', ...more };
  }
  async list() {
    return this.transaction(() => {
      const result = { providers: { claude: 'native-mod-only', codex: this.provider === 'codex' ? 'experimental-best-effort' : 'unsupported' },
        policies: this.state.policies.map(p => this.presentation(p)), attempts: [],
        attemptCount: this.state.attempts.length, attemptsTruncated: false };
      let bytes = Buffer.byteLength(JSON.stringify(result));
      for (const attempt of this.state.attempts.slice(-64).reverse()) {
        const size = Buffer.byteLength(JSON.stringify(attempt)) + 1;
        if (bytes + size > 768 * 1024) break;
        result.attempts.unshift(clone(attempt)); bytes += size;
      }
      result.attemptsTruncated = result.attempts.length < result.attemptCount;
      return result;
    });
  }
  async configure(input) {
    if (input?.provider !== this.provider) throw error('CACHE_WARM_UNSUPPORTED', 'Cache-warming provider does not match this ledger.');
    identity(input); requireValue(typeof input.enabled === 'boolean');
    requireValue(!input.enabled || word(input.requestId), 'Enabling requires a unique requestId.');
    requireValue(input.requestId === undefined || word(input.requestId));
    requireValue(input.ttl === undefined || ['1h', '5m'].includes(input.ttl), 'Cache-warming ttl must be 1h or 5m.');
    if (this.provider === 'codex') {
      requireValue(!input.enabled || input.bestEffort === true, 'Codex warming requires explicit bestEffort acceptance.');
      requireValue(input.bestEffort === undefined || typeof input.bestEffort === 'boolean');
      requireValue(input.ttl === undefined, 'Codex native TTL configuration is not supported.');
      requireValue(integer(input.refreshMinutes ?? 25, 1, 25), 'Codex refreshMinutes must be an integer from 1 to 25.');
    }
    const { maxMinutes = 60, maxRefreshes = 3, maxReadTokens = 250000, maxOutputTokens = 256 } = input;
    requireValue(integer(maxMinutes, 1, 1440) && integer(maxRefreshes, 1, 100)
      && integer(maxReadTokens, 1, 100000000) && integer(maxOutputTokens, 1, 1000000));
    const stopped = input.enabled ? await this.stopped() : false;
    return this.transaction(async () => {
      requireValue(!this.closed || !input.enabled, 'Cache-warming broker is stopping.');
      const payload = JSON.stringify({ provider: this.provider, sessionId: input.sessionId, cwd: input.cwd, enabled: input.enabled,
        maxMinutes, maxRefreshes, maxReadTokens, maxOutputTokens, ...(input.ttl === undefined ? {} : { ttl: input.ttl }),
        ...(this.provider === 'codex' ? { bestEffort: input.bestEffort === true, refreshMinutes: input.refreshMinutes ?? 25 } : {}) });
      const saved = input.requestId && this.state.requests.find(r => r.requestId === input.requestId);
      if (saved) {
        requireValue(saved.payload === payload, 'Cache-warming requestId was reused with different parameters.');
        return this.result(this.policy(saved.sessionId), { replayed: true });
      }
      if (stopped) throw error('CACHE_WARM_STOPPED', 'Claudex is stopped or resuming; warming cannot be enabled.');
      if (input.requestId && this.state.requests.length >= MAX_ATTEMPTS)
        throw error('CACHE_WARM_CAPACITY', 'Cache-warming request receipt capacity is exhausted.');
      const b = this.bindings.get(input.sessionId);
      if (input.enabled && (!b || b.cwd !== input.cwd || b.phase === 'ended'))
        throw error('CACHE_WARM_NOT_BOUND', 'Enable warming from an existing loaded native session.');
      let p = this.policy(input.sessionId);
      if (!p && this.state.policies.length >= MAX_POLICIES) throw error('CACHE_WARM_CAPACITY', 'Cache-warming policy capacity is exhausted.');
      if (input.enabled && this.pending(input.sessionId) && this.pending(input.sessionId).state !== 'reserved')
        throw error('CACHE_WARM_PENDING', 'A native attempt still awaits final evidence; do not start another.');
      for (const a of this.attempts(input.sessionId)) if (a.state === 'reserved') { a.state = 'revoked'; a.reason = 'policy-changed'; }
      const value = { provider: this.provider, sessionId: input.sessionId, cwd: input.cwd, enabled: input.enabled,
        generation: (p?.generation ?? 0) + 1,
        ...(this.provider === 'codex' ? { bestEffort: input.bestEffort === true, refreshMinutes: input.refreshMinutes ?? 25 } : { ttlPreference: input.ttl ?? '1h' }),
        maxMinutes, maxRefreshes, maxReadTokens, maxOutputTokens,
        until: this.now() + maxMinutes * 60000, updatedAt: this.now(), reason: input.enabled ? null : 'disabled',
        model: b?.sample?.model ?? null, effort: b?.sample?.effort ?? null, ttlMs: b?.sample?.ttlMs ?? null };
      // Disabling revokes authorization without erasing this enrollment's
      // bounds/accounting. Only a newly confirmed enable starts a new budget.
      if (p && !input.enabled) Object.assign(p, { enabled: false, updatedAt: this.now(), reason: 'disabled' });
      else if (p) Object.assign(p, value); else { p = value; this.state.policies.push(p); }
      if (input.requestId) this.state.requests.push({ requestId: input.requestId, sessionId: p.sessionId, generation: p.generation, payload });
      await this.save(); return this.result(p, { replayed: false });
    });
  }
  async observe(input) {
    bindingIdentity(input); requireValue(integer(input.sequence, 1) && integer(input.epoch)
      && ['idle', 'busy', 'ended'].includes(input.phase));
    const sample = input.sample === undefined ? null : sampleValue(input.sample, this.now(), this.provider);
    requireValue(!sample || input.phase !== 'ended');
    requireValue(input.attemptId === undefined || word(input.attemptId));
    requireValue(!input.attemptId || !sample?.attemptId || input.attemptId === sample.attemptId);
    const ownAttemptId = input.attemptId ?? sample?.attemptId;
    return this.transaction(async () => {
      if (this.closed) return { observed: false, reason: 'broker-stopping' };
      const old = this.bindings.get(input.sessionId), retired = this.retired.get(input.sessionId) ?? new Set();
      if (retired.has(input.instanceId) || old && old.instanceId === input.instanceId
        && (input.sequence <= old.sequence || input.epoch < old.epoch || old.cwd !== input.cwd))
        return { observed: false, reason: 'stale-observation' };
      if (!old && !this.retired.has(input.sessionId)
        && new Set([...this.bindings.keys(), ...this.retired.keys()]).size >= MAX_POLICIES)
        throw error('CACHE_WARM_CAPACITY', 'Native binding capacity is exhausted.');
      const replaced = old && old.instanceId !== input.instanceId;
      if (replaced) {
        if (retired.size >= 64) throw error('CACHE_WARM_CAPACITY', 'Retired native binding capacity is exhausted.');
        retired.add(old.instanceId); this.retired.set(input.sessionId, retired);
      }
      const repeated = Boolean(sample && old?.instanceId === input.instanceId && old.sample?.id === sample.id);
      if (repeated && JSON.stringify(sample) !== JSON.stringify(old.sample))
        return { observed: false, reason: 'changed-sample' };
      if (sample && !repeated && old?.instanceId === input.instanceId && old.sample
        && (sample.startedAt < old.sample.startedAt || sample.completedAt < old.sample.completedAt
          // Codex can deliver distinct exact usage deltas in one socket batch.
          // Its private service supplies their IDs and increasing observation
          // sequences; equal clock values alone must not discard those deltas.
          || this.provider !== 'codex' && sample.completedAt === old.sample.completedAt))
        return { observed: false, reason: 'stale-sample' };
      const b = { sessionId: input.sessionId, cwd: input.cwd, instanceId: input.instanceId,
        sequence: input.sequence, epoch: input.epoch, phase: input.phase,
        sample: sample ?? (!replaced && old?.epoch === input.epoch ? old.sample : null) };
      let changed = false;
      for (const a of this.attempts(input.sessionId)) {
        if (a.state === 'reserved' && (replaced || input.phase !== 'idle' || input.epoch !== a.epoch || sample && sample.id !== a.sampleId)) {
          a.state = 'revoked'; a.reason = 'native-activity-changed'; changed = true;
        }
        const own = ownAttemptId === a.id && a.instanceId === input.instanceId && a.authorizedAt !== undefined;
        if (['dispatching', 'submitted'].includes(a.state) && (replaced || input.phase === 'ended'
          || !own && (input.phase === 'busy' || input.epoch !== a.epoch || sample))) {
          a.state = 'uncertain'; a.reason = 'native-activity-changed'; changed = true;
          const p = this.policy(a.sessionId); p.enabled = false; p.reason = a.reason;
        }
        // Codex Turn.startedAt has second precision. Only the private native
        // service may attribute an own sample after matching the exact returned
        // turn ID; timestamps are an additional fence, never attribution proof.
        // Claude native observations retain their millisecond precision fence.
        const authorizedStart = this.provider === 'codex' ? Math.floor(a.authorizedAt / 1000) * 1000 : a.authorizedAt;
        if (sample && !repeated && own && ['dispatching', 'submitted', 'verified', 'failed'].includes(a.state) && a.instanceId === input.instanceId
          && sample.id !== a.sampleId && sample.startedAt >= authorizedStart && input.epoch > a.epoch) {
          const responseIds = a.responseIds ?? [];
          if (responseIds.includes(sample.id)) continue;
          if (responseIds.length >= 64) {
            a.state = 'failed'; a.reason = 'native-response-capacity'; changed = true;
            const p = this.policy(a.sessionId); p.enabled = false; p.reason = a.reason;
            continue;
          }
          a.responseIds = [...responseIds, sample.id];
          a.actual = Object.fromEntries(['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
            .map(k => [k, (a.actual?.[k] ?? 0) + sample[k]]));
          a.completedAt = sample.completedAt; a.responseId = sample.id;
          const verified = a.state !== 'failed' && successful(sample) && sample.model === a.model && sample.effort === a.effort
            && sample.cacheReadTokens >= a.requiredPrefixTokens;
          if (this.provider === 'codex' && verified) {
            // Per-request cache hits are candidates only. The private service
            // drains every exact usage delta before publishing the own idle
            // boundary for the successfully completed native turn.
            a.cacheVerified = true;
            a.reason = 'native-cache-hit-pending-completion';
          } else {
            a.state = verified ? 'verified' : 'failed';
            a.reason = verified ? 'native-cache-hit' : 'native-cache-verification-failed';
          }
          changed = true;
          const p = this.policy(a.sessionId), totals = this.totals(p);
          if (a.state === 'failed' || totals.readTokens > p.maxReadTokens || totals.outputTokens > p.maxOutputTokens) {
            p.enabled = false; p.reason = a.state === 'failed' ? a.reason : 'actual-budget-exceeded';
          }
        }
        if (this.provider === 'codex' && own && input.phase === 'idle' && input.epoch > a.epoch
          && ['dispatching', 'submitted'].includes(a.state) && a.cacheVerified && a.responseIds?.length) {
          a.state = 'verified'; a.reason = 'native-cache-hit'; changed = true;
        }
      }
      const p = this.policy(input.sessionId);
      if (p?.enabled && (replaced || input.phase === 'ended')) { p.enabled = false; p.reason = 'native-binding-changed'; changed = true; }
      // A normal coding turn may make several tool-use requests before its
      // final answer. These busy steps refresh usage evidence, not the timer;
      // they are not a failed warming attempt and must not revoke its opt-in.
      const ordinaryToolStep = !ownAttemptId && input.phase === 'busy' && sample?.stopReason === 'tool_use';
      if (p?.enabled && sample && ((!successful(sample) && !ordinaryToolStep) || !prefix(sample))) {
        p.enabled = false; p.reason = !successful(sample) ? 'native-output-not-complete' : 'no-cache-prefix'; changed = true;
      }
      if (p?.enabled && sample) {
        if (p.model === null) { p.model = sample.model; p.effort = sample.effort; p.ttlMs = sample.ttlMs; changed = true; }
        else if (p.model !== sample.model || p.effort !== sample.effort || p.ttlMs !== sample.ttlMs) {
          p.enabled = false; p.reason = 'native-configuration-changed'; changed = true;
        }
      }
      if (input.phase === 'ended') {
        if (retired.size >= 64) throw error('CACHE_WARM_CAPACITY', 'Retired native binding capacity is exhausted.');
        retired.add(input.instanceId); this.retired.set(input.sessionId, retired); this.bindings.delete(input.sessionId);
      } else this.bindings.set(input.sessionId, b);
      if (changed) await this.save();
      return this.result(p, { observed: true, bound: input.phase !== 'ended' });
    });
  }
  async claim(input) {
    bindingIdentity(input); requireValue(integer(input.epoch));
    // The awaited app-stop read must not keep observations/revocation from
    // running. Revalidate inside the serialized transaction after it returns.
    const stopped = await this.stopped();
    return this.transaction(async () => {
      const p = this.policy(input.sessionId), b = this.binding(input);
      const reason = stopped ? 'app-stopped' : !b || b.epoch !== input.epoch ? 'native-binding-changed' : this.reason(p, b, true);
      if (reason) return { claimed: false, reason, nextAt: p ? this.presentation(p).nextAt : null };
      if (this.state.attempts.length >= MAX_ATTEMPTS) throw error('CACHE_WARM_CAPACITY', 'Cache-warming attempt capacity is exhausted.');
      const a = { id: randomUUID(), sessionId: p.sessionId, cwd: p.cwd, instanceId: b.instanceId,
        epoch: b.epoch, generation: p.generation, createdAt: this.now(), nextAt: nextAt(b.sample, p),
        expiresAt: Math.min(expires(b.sample, p), p.until), sampleId: b.sample.id, model: b.sample.model, effort: b.sample.effort,
        state: 'reserved', requiredPrefixTokens: prefix(b.sample), reservedReadTokens: prefix(b.sample) + READ_OVERHEAD,
        reservedOutputTokens: OUTPUT_RESERVATION };
      this.state.attempts.push(a); await this.save();
      return { claimed: true, attempt: { id: a.id, prompt: CACHE_WARM_PROMPT, nextAt: a.nextAt, expiresAt: a.expiresAt } };
    });
  }
  async check(input) {
    bindingIdentity(input); requireValue(integer(input.epoch) && word(input.attemptId));
    const stopped = await this.stopped();
    return this.transaction(async () => {
      const a = this.state.attempts.find(a => a.id === input.attemptId), p = this.policy(input.sessionId), b = this.binding(input);
      if (!a || a.sessionId !== input.sessionId || a.cwd !== input.cwd || a.instanceId !== input.instanceId)
        return { ready: false, reason: 'attempt-identity-mismatch' };
      if (a.state !== 'reserved') return { ready: false, reason: 'attempt-already-consumed' };
      const reason = this.closed ? 'broker-stopping' : stopped ? 'app-stopped'
        : !p?.enabled || p.generation !== a.generation ? 'policy-changed'
          : !b || b.epoch !== a.epoch || input.epoch !== a.epoch || b.phase !== 'idle' || b.sample?.id !== a.sampleId ? 'native-activity-changed'
            : this.now() >= a.expiresAt || this.now() >= p.until ? 'attempt-expired' : null;
      if (reason) { a.state = 'revoked'; a.reason = reason; await this.save(); return { ready: false, reason }; }
      a.state = 'dispatching'; a.authorizedAt = this.now(); await this.save();
      return { ready: true, attemptId: a.id, expiresAt: a.expiresAt };
    });
  }
  async receipt(input) {
    bindingIdentity(input); requireValue(word(input.attemptId) && ['submitted', 'rejected', 'uncertain'].includes(input.outcome));
    return this.transaction(async () => {
      const a = this.state.attempts.find(a => a.id === input.attemptId);
      requireValue(a && a.sessionId === input.sessionId && a.cwd === input.cwd && a.instanceId === input.instanceId, 'Cache-warming receipt identity changed.');
      if (a.state === input.outcome || ['verified', 'failed', 'uncertain', 'revoked', 'rejected'].includes(a.state)) return clone(a);
      requireValue(a.state === 'dispatching' || a.state === 'reserved' && input.outcome === 'rejected', 'Cache-warming attempt was not authorized.');
      a.state = input.outcome; a.receivedAt = this.now();
      if (input.outcome !== 'submitted') { const p = this.policy(a.sessionId); p.enabled = false; p.reason = `native-${input.outcome}`; }
      await this.save(); return clone(a);
    });
  }
  async close() {
    this.closed = true;
    return this.transaction(async () => {
      let changed = false;
      for (const a of this.state.attempts) if (live.has(a.state)) {
        a.state = a.state === 'reserved' ? 'revoked' : 'uncertain'; a.reason = 'broker-stopped'; changed = true;
        const p = this.policy(a.sessionId); p.enabled = false; p.reason = a.reason;
      }
      this.bindings.clear(); if (changed) await this.save();
    });
  }
}
