// This client observes only native metadata. The broker owns policy and budgets.
const same = (a, b) => a?.sessionId === b?.sessionId && a?.cwd === b?.cwd;
const count = value => Number.isSafeInteger(value) && value >= 0;
const token = () => `warm-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
const defaults = Object.freeze({ maxMinutes: 60, maxRefreshes: 3, maxReadTokens: 250000, maxOutputTokens: 256 });

// Native 2.1.286 frames an idle plugin submission before turn.start. Accept the
// exact native envelope, never a substring or a mid-turn delivery. The pending
// one-use intent, epoch, context and deadline are independently required below.
export function isCacheWarmTurnText(text, prompt, pluginName) {
  return text === prompt || text === `The ${pluginName} plugin sent a message:\n${prompt}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`;
}

export function cacheWarmTtl({ ttl, force5m, setting } = {}) {
  if (force5m === '1' || force5m === 'true') return { ttlMs: 300000, ttlSource: 'native-setting' };
  const value = ttl || setting;
  if (value === '5m' || value === '1h') return { ttlMs: value === '1h' ? 3600000 : 300000, ttlSource: 'native-setting' };
  return { ttlMs: 300000, ttlSource: 'conservative-minimum' };
}

export function parseCacheWarmBounds(words = []) {
  const result = { ...defaults }, seen = new Set();
  for (const word of words) {
    const match = /^(maxMinutes|maxRefreshes|maxReadTokens|maxOutputTokens)=([1-9][0-9]*)$/.exec(word);
    if (!match || seen.has(match[1]) || !Number.isSafeInteger(Number(match[2]))) throw new Error('Use unique maxMinutes, maxRefreshes, maxReadTokens, maxOutputTokens positive integer bounds.');
    seen.add(match[1]); result[match[1]] = Number(match[2]);
  }
  if (result.maxMinutes > 1440 || result.maxRefreshes > 100 || result.maxReadTokens > 10000000 || result.maxOutputTokens > 100000)
    throw new Error('Cache warming bounds exceed the supported limits.');
  return result;
}

export function createCacheWarmClient() {
  let binding = null, generation = 0, confirmation = null;
  const cancel = b => { b?.timer?.cancel(); if (b) b.timer = null; };
  const current = (b, epoch = b?.epoch) => binding === b && b?.epoch === epoch && !b.ended;
  const call = (b, action, params = {}) => b.host.bridge({ version: 1, op: 'cache-warm', action,
    context: b.context, params: { ...(action === 'configure' ? { provider: 'claude' } : {}), ...b.context, ...params } });
  const fields = b => ({ instanceId: b.instanceId, epoch: b.epoch });
  function fault(b, reason) { cancel(b); b.suspended = true; b.reason = reason; }
  async function safeContext(b, epoch) {
    return current(b, epoch) && !await b.host.worker() && same(await b.host.context(), b.context) && current(b, epoch);
  }
  async function admissible(b, epoch, fingerprint) {
    if (!await safeContext(b, epoch) || b.phase !== 'idle' || !b.enabled || b.suspended) return false;
    const config = await b.host.cacheConfiguration();
    const draft = await b.host.readPrompt();
    return current(b, epoch) && b.phase === 'idle' && config.fingerprint === fingerprint
      && typeof draft?.text === 'string' && draft.text.length === 0;
  }
  async function schedule(b, reply, epoch) {
    if (!current(b, epoch) || b.suspended) return;
    cancel(b); b.reason = reply?.reason ?? null;
    if (Object.hasOwn(reply ?? {}, 'policy')) b.enabled = reply.policy?.enabled === true;
    if (!b.enabled || b.phase !== 'idle' || !b.sample || !Number.isFinite(reply?.nextAt)) return;
    const now = await b.host.now();
    if (!current(b, epoch)) return;
    // No sleep catch-up: even an overdue timer must pass the broker's expiry gate.
    b.timer = b.host.after(Math.max(0, reply.nextAt - now), async () => {
      try { await tick(b); } catch { fault(b, 'transport-unavailable'); }
    });
  }
  async function observe(b, sample) {
    // A stopped policy forbids another dispatch, not accounting for native
    // responses already in flight (including native max-token recovery).
    if (b.ended || ((!b.enabled || b.suspended) && !b.turn?.attemptId)) return;
    const epoch = b.epoch, sequence = ++b.sequence;
    const freshSample = sample && sample.id !== b.publishedSampleId ? sample : null;
    const reply = await call(b, 'observe', { ...fields(b), sequence, phase: b.phase,
      ...(freshSample ? { sample: freshSample } : {}), ...(b.turn?.attemptId ? { attemptId: b.turn.attemptId } : {}) });
    if (freshSample) b.publishedSampleId = freshSample.id;
    if (sequence === b.sequence) await schedule(b, reply, epoch);
  }
  async function tick(b) {
    cancel(b);
    const epoch = b.epoch, fingerprint = b.sampleFingerprint;
    if (!await admissible(b, epoch, fingerprint)) { if (current(b, epoch)) b.reason = 'native-busy-draft-or-configuration-changed'; return; }
    const claim = await call(b, 'claim', fields(b));
    if (claim?.claimed !== true) { await schedule(b, claim, epoch); return; }
    const attempt = claim.attempt;
    if (!attempt || typeof attempt.id !== 'string' || typeof attempt.prompt !== 'string'
      || !attempt.prompt.trim() || attempt.prompt.length > 4096 || !Number.isFinite(attempt.expiresAt)) {
      fault(b, 'invalid-claim'); return;
    }
    let outcome = 'rejected';
    try {
      if (!await admissible(b, epoch, fingerprint)) return;
      const checked = await call(b, 'check', { ...fields(b), attemptId: attempt.id });
      if (checked?.ready !== true || !await admissible(b, epoch, fingerprint)
        || await b.host.now() >= attempt.expiresAt || !current(b, epoch)) return;
      b.pending = { id: attempt.id, text: attempt.prompt, epoch, fingerprint, expiresAt: attempt.expiresAt, admitted: false };
      b.dispatch = b.pending;
      // Set uncertainty before crossing native submission. Never retry this call.
      outcome = 'uncertain';
      b.pending.submissionStarted = true;
      const result = await b.host.submitPrompt({ text: attempt.prompt });
      if (typeof result?.drop === 'string') outcome = 'rejected';
      else if (typeof result?.text === 'string' && result.origin?.kind === 'plugin' && result.origin.name === b.host.pluginName)
        outcome = 'submitted';
    } catch { outcome = 'uncertain'; }
    finally {
      b.dispatch = null;
      try { await call(b, 'receipt', { instanceId: b.instanceId, epoch, attemptId: attempt.id, outcome }); }
      catch { outcome = 'uncertain'; }
      if (outcome !== 'submitted') { b.pending = null; fault(b, outcome); }
    }
  }
  return {
    snapshot() { return binding ? { enabled: binding.enabled, reason: binding.reason, phase: binding.phase,
      suspended: binding.suspended, instanceId: binding.instanceId, sessionId: binding.context.sessionId } : { enabled: false }; },
    async start(host) {
      const ticket = ++generation;
      if (binding) { cancel(binding); binding.ended = true; }
      binding = null; confirmation = null;
      if (await host.worker()) return;
      const context = await host.context();
      if (ticket !== generation) return;
      binding = { host, context, instanceId: token(), epoch: 0, sequence: 0, phase: 'idle', enabled: false,
        ended: false, suspended: false, timer: null, pending: null, turn: null, sample: null, reason: 'disabled' };
    },
    async stop() {
      generation++; confirmation = null;
      const b = binding; binding = null;
      if (!b) return;
      cancel(b); b.ended = true; b.epoch++; b.pending = null;
      if (b.enabled) { try { await call(b, 'observe', { ...fields(b), sequence: ++b.sequence, phase: 'ended' }); } catch {} }
    },
    invalidate() {
      const b = binding; if (!b) return;
      cancel(b); b.epoch++; b.pending = null; b.sample = null; confirmation = null;
      b.reason = 'native-configuration-changed';
    },
    async command(host, words, origin) {
      if (await host.worker()) throw new Error('Managed worker cache warming is disabled.');
      if (!binding || !same(binding.context, await host.context())) await this.start(host);
      const b = binding;
      if (!b) throw new Error('Native session context is unavailable.');
      if (words[0] === 'status' && words.length === 1) return { local: this.snapshot(), ...await call(b, 'list') };
      // Never let model/plugin-authored commands opt another session into inference.
      if (!['composer', 'bridge', 'sdk'].includes(origin?.kind)) throw new Error('Cache warming requires an explicit native user command.');
      if (words[0] === 'off' && words.length === 1) {
        cancel(b); b.epoch++; b.pending = null; b.enabled = false; confirmation = null;
        return call(b, 'configure', { enabled: false, instanceId: b.instanceId, requestId: token() });
      }
      if (words[0] === 'on') {
        const bounds = parseCacheWarmBounds(words.slice(1)), now = await host.now();
        const config = await host.cacheConfiguration();
        confirmation = { id: token(), b, epoch: b.epoch, expiresAt: now + 120000, bounds };
        return { state: 'confirmation-required', sessionId: b.context.sessionId, cwd: b.context.cwd, ...bounds,
          cacheWindow: { ...config.ttl, refreshBeforeExpiryMs: config.ttl.ttlMs === 3600000 ? 300000 : 60000 },
          observedCachedPrefixTokens: b.sample ? b.sample.cacheReadTokens + b.sample.cacheWriteTokens : null,
          nativeOutputCapUnchanged: true,
          effects: 'Real plugin-origin OK turns in this conversation consume subscription quota and remain in history. Existing model and effort are inherited. Output bounds stop future refreshes after observed usage; they are not a hard per-request output cap.',
          expiresAt: confirmation.expiresAt, confirm: `/claudex warm confirm ${confirmation.id}` };
      }
      if (words[0] === 'confirm' && words.length === 2) {
        const prepared = confirmation; confirmation = null;
        if (!prepared || prepared.id !== words[1] || prepared.b !== b || prepared.epoch !== b.epoch
          || await host.now() >= prepared.expiresAt || !await safeContext(b, prepared.epoch)) throw new Error('Cache warming confirmation expired or its native context changed.');
        // Explicit confirmation first registers this exact live instance. Default-off
        // starts and status reads never create a broker observer or policy.
        const initialSample = b.phase === 'idle' ? b.sample : null;
        const bound = await call(b, 'observe', { ...fields(b), sequence: ++b.sequence, phase: b.phase,
          ...(initialSample ? { sample: initialSample } : {}) });
        if (bound?.observed !== true || !await safeContext(b, prepared.epoch)) throw new Error('The native cache-warming observer could not be bound.');
        if (initialSample) b.publishedSampleId = initialSample.id;
        const reply = await call(b, 'configure', { enabled: true, ...prepared.bounds, instanceId: b.instanceId, requestId: prepared.id });
        if (!current(b, prepared.epoch)) return { state: 'context-changed' };
        b.enabled = reply?.policy?.enabled === true; b.suspended = false;
        await observe(b, b.sample); return { ...reply, local: this.snapshot() };
      }
      throw new Error('Use /claudex warm status|on [maxMinutes=N maxRefreshes=N maxReadTokens=N maxOutputTokens=N]|confirm TOKEN|off.');
    },
    async prompt(e) {
      const b = binding; if (!b) return null;
      const own = e.origin?.kind === 'plugin' && e.origin.name === b.host.pluginName;
      const pending = b.pending;
      if (own && b.dispatch && e.text === b.dispatch.text) {
        if (!pending || pending !== b.dispatch) return { drop: 'Cache warming was revoked before native admission.' };
        if (!await admissible(b, pending.epoch, pending.fingerprint) || await b.host.now() >= pending.expiresAt
          || b.pending !== pending || !current(b, pending.epoch)) return { drop: 'Cache warming was revoked by native activity or a changed context.' };
        pending.admitted = true; return null;
      }
      cancel(b); b.epoch++; b.pending = null;
      // Any competing submission revokes the current timer before it can run.
      b.phase = 'busy';
      if (b.enabled) { try { await observe(b); } catch { fault(b, 'observation-unavailable'); } }
      return null;
    },
    async turnStart(e) {
      const b = binding; if (!b) return;
      const pending = b.pending;
      // Native 2.1.286 skips the originating plugin's prompt.submit hook as
      // re-entry. Admission cannot depend on seeing that skipped hook. Bind only
      // our one-use dispatch to an exact unchanged epoch/text/context before its
      // deadline. Every observed competing submission clears this pending intent.
      const epoch = b.epoch;
      let own = false;
      if (pending?.submissionStarted && pending.epoch === epoch && isCacheWarmTurnText(e.text, pending.text, b.host.pluginName)) {
        const validContext = await safeContext(b, epoch);
        const now = await b.host.now();
        // A newer prompt/turn can arrive while native context is being read.
        // A stale callback must never overwrite that newer turn or its usage.
        if (!current(b, epoch) || b.pending !== pending) return;
        own = validContext && now < pending.expiresAt;
      }
      if (!current(b, epoch)) return;
      cancel(b); b.epoch++; b.phase = 'busy'; b.pending = null;
      b.turn = { id: e.turnId, attemptId: own ? pending.id : null, responses: 0 };
      if (pending && !own) fault(b, 'native-turn-attribution-unavailable');
      if (b.enabled) { try { await observe(b); } catch { fault(b, 'observation-unavailable'); } }
    },
    async stepStart(e) {
      const b = binding;
      if (!b || e.agentId || b.turn?.id !== e.turnId) return null;
      const epoch = b.epoch, startedAt = await b.host.now(), config = await b.host.cacheConfiguration();
      if (!current(b, epoch)) return null;
      return { b, epoch, turn: b.turn, startedAt, config, effort: e.effort ?? null, index: e.index };
    },
    async stepEnd(ticket, result) {
      if (!ticket || !current(ticket.b, ticket.epoch) || ticket.b.turn !== ticket.turn) return;
      const { b, turn, config } = ticket, u = result?.usage;
      if (!u || typeof u.model !== 'string' || !u.model || typeof ticket.effort !== 'string' || !ticket.effort
        || ![u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].every(count)) {
        b.sample = null; if (turn.attemptId) fault(b, 'native-usage-unavailable'); return;
      }
      const sample = { id: `${turn.id}:${ticket.index}`, startedAt: ticket.startedAt, completedAt: await b.host.now(),
        model: u.model, effort: ticket.effort, ...config.ttl, inputTokens: u.input_tokens,
        cacheReadTokens: u.cache_read_input_tokens, cacheWriteTokens: u.cache_creation_input_tokens,
        outputTokens: u.output_tokens, stopReason: result.stopReason,
        ...(turn.attemptId ? { attemptId: turn.attemptId } : {}) };
      if (!current(b, ticket.epoch)) return;
      b.sample = sample; b.sampleFingerprint = config.fingerprint; turn.responses++;
      // Count every native request, including recovery; never collect its text.
      if (b.enabled || turn.attemptId) { try { await observe(b, sample); } catch { fault(b, 'observation-unavailable'); } }
    },
    async turnComplete(e) {
      const b = binding; if (!b || e.agentId || b.turn?.id !== e.turnId) return;
      const turn = b.turn;
      b.phase = 'idle';
      if (e.reason !== 'answer' || !b.turn.responses) {
        // An idle observation normally retains the completed request from this
        // epoch. A failed/aborted turn must explicitly retire that evidence.
        b.sample = null; b.epoch++;
      }
      if (b.enabled || turn.attemptId) { try { await observe(b, b.sample); } catch { fault(b, 'observation-unavailable'); } }
      if (b.turn === turn) b.turn = null;
    },
    deniesTool(e) { return !e.agentId && Boolean(binding?.turn?.attemptId); },
  };
}
