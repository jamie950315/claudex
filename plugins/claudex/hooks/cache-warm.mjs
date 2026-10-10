// This client observes only native metadata. The broker owns policy and budgets.
import { parseWarmLimits, WARM_LIMIT_HELP } from './cache-warm-display.mjs';

const same = (a, b) => a?.sessionId === b?.sessionId && a?.cwd === b?.cwd;
const count = value => Number.isSafeInteger(value) && value >= 0;
const token = () => `warm-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
const defaults = Object.freeze({ ttl: '1h', maxMinutes: 60, maxRefreshes: 3, maxReadTokens: null, maxOutputTokens: 256 });
export const CACHE_TTL_PREFERENCE_KEY = 'cache-ttl-preference';
export const CACHE_TTL_LAST_KEY = 'cache-ttl-last-choice';

export function cacheTtlPreference(value) {
  if (value === undefined || value === null) return { version: 1, mode: 'session' };
  if (value?.version !== 1 || !['session', 'remember', 'default'].includes(value.mode)
    || Object.keys(value).some(key => !['version', 'mode', 'ttl', 'revision'].includes(key))
    || (value.mode === 'session' ? value.ttl !== undefined : !['1h', '5m'].includes(value.ttl))
    || (value.mode === 'remember' ? typeof value.revision !== 'string' || !/^warm-[a-zA-Z0-9-]{1,80}$/.test(value.revision) : value.revision !== undefined))
    throw new Error('Saved cache TTL preference is invalid; no native setting was changed.');
  return { version: 1, mode: value.mode, ...(value.mode === 'session' ? {} : { ttl: value.ttl }),
    ...(value.mode === 'remember' ? { revision: value.revision } : {}) };
}
const preferenceEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Native 2.1.286 frames an idle plugin submission before turn.start. Accept the
// exact native envelope, never a substring or a mid-turn delivery. The pending
// one-use intent, epoch, context and deadline are independently required below.
export function isCacheWarmTurnText(text, prompt, pluginName) {
  return text === prompt || text === `The ${pluginName} plugin sent a message:\n${prompt}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`;
}

export function cacheWarmTtl({ ttl, force5m, setting, preference = '1h' } = {}) {
  if (force5m === '1' || force5m === 'true') return { ttlMs: 300000, ttlSource: 'native-setting' };
  const value = ['5m', '1h'].includes(ttl) ? ttl : setting;
  // Pure resolver only. Confirmation separately synchronizes the real native
  // setting before arming. Never overrun a known shorter native lifetime.
  if (value === '5m') return { ttlMs: 300000, ttlSource: 'native-setting' };
  if (preference === '5m') return { ttlMs: 300000, ttlSource: 'configured-window' };
  if (value === '1h') return { ttlMs: 3600000, ttlSource: 'native-setting' };
  return { ttlMs: 3600000, ttlSource: 'configured-window' };
}

export function assertNativeCacheTtlChange(state, desired) {
  if (!['1h', '5m'].includes(desired)) throw new Error('Native cache TTL must be 1h or 5m.');
  if (state.force5m && desired !== '5m') throw new Error('FORCE_PROMPT_CACHING_5M prevents selecting 1h; no native setting was changed.');
  if (state.policyLocked && state.policyValue !== desired)
    throw new Error('Managed native cache TTL policy prevents this change.');
}

export function parseCacheWarmBounds(words = []) {
  const result = { ...defaults }, seen = new Set();
  for (const word of words) {
    if (word.startsWith('maxReadTokens=')) throw new Error('Read-token limits have been removed; omit maxReadTokens.');
    if (word.startsWith('ttl=')) {
      const value = word.slice(4);
      if (seen.has('ttl') || !['1h', '5m'].includes(value)) throw new Error('Use ttl=1h or ttl=5m exactly once.');
      seen.add('ttl'); result.ttl = value; continue;
    }
    const match = /^(maxMinutes|maxRefreshes|maxOutputTokens)=([1-9][0-9]*)$/.exec(word);
    if (!match || seen.has(match[1]) || !Number.isSafeInteger(Number(match[2]))) throw new Error('Use unique maxMinutes, maxRefreshes, maxOutputTokens positive integer bounds.');
    seen.add(match[1]); result[match[1]] = Number(match[2]);
  }
  if (result.maxMinutes > 1440 || result.maxRefreshes > 100 || result.maxOutputTokens > 100000)
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
  async function readPreference(host) {
    const preference = cacheTtlPreference(await host.readTtlPreference());
    if (preference.mode !== 'remember') return preference;
    const last = await host.readLastTtlChoice(preference.revision);
    if (last !== undefined && last !== null && (typeof last !== 'object'
      || typeof last.revision !== 'string' || !['1h', '5m'].includes(last.ttl)))
      throw new Error('Saved last TTL choice is invalid; no native setting was changed.');
    return last?.revision === preference.revision ? { ...preference, ttl: last.ttl } : preference;
  }
  async function savePreference(host, preference) {
    await host.writeTtlPreference(preference);
    if (!preferenceEqual(await readPreference(host), preference)) throw new Error('Cache TTL preference readback failed; the saved preference may have changed.');
  }
  async function admissible(b, epoch, fingerprint) {
    if (!await safeContext(b, epoch) || b.phase !== 'idle' || !b.enabled || b.suspended) return false;
    const config = await b.host.cacheConfiguration(b.ttlPreference);
    const draft = await b.host.readPrompt();
    return current(b, epoch) && b.phase === 'idle' && config.fingerprint === fingerprint
      && typeof draft?.text === 'string' && draft.text.length === 0;
  }
  async function schedule(b, reply, epoch) {
    if (!current(b, epoch) || b.suspended || b.configuring) return;
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
    if (b.checking || b.configuring) return;
    b.checking = true;
    try { await tickOnce(b); } finally { b.checking = false; }
  }
  async function tickOnce(b) {
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
      suspended: binding.suspended, instanceId: binding.instanceId, sessionId: binding.context.sessionId,
      ttlRestore: binding.ttlRestore } : { enabled: false }; },
    async start(host, { restore = false } = {}) {
      const ticket = ++generation;
      if (binding) { cancel(binding); binding.ended = true; }
      binding = null; confirmation = null;
      if (await host.worker()) return;
      const context = await host.context();
      if (ticket !== generation) return;
      binding = { host, context, instanceId: token(), epoch: 0, sequence: 0, phase: 'idle', enabled: false, ttlPreference: '1h',
        ended: false, suspended: false, timer: null, pending: null, turn: null, sample: null, reason: 'disabled',
        ttlRestore: { state: 'not-requested' } };
      // Only the native session-start path restores an explicitly saved choice.
      // Lazy command binding, inspection and /clear must never apply preferences.
      if (restore) {
        const b = binding, epoch = b.epoch;
        b.restoring = true;
        let applyAttempted = false;
        const guard = async () => {
          if (!await safeContext(b, epoch) || b.phase !== 'idle' || b.configuring)
            throw new Error('Native activity changed during startup TTL restoration.');
        };
        try {
          const preference = await readPreference(host);
          await guard();
          if (preference.mode === 'session') { b.ttlRestore = { state: 'session-only' }; return; }
          const nativeBefore = await host.checkCacheTtl(preference.ttl);
          await guard();
          if (!preferenceEqual(await readPreference(host), preference)) throw new Error('TTL preference changed during startup.');
          await guard(); applyAttempted = true;
          const result = await host.applyCacheTtl(preference.ttl, nativeBefore.value, guard);
          await guard();
          if (result?.value !== preference.ttl || result?.scope !== 'current-process') throw new Error('Native cache TTL readback failed.');
          b.ttlPreference = preference.ttl;
          b.ttlRestore = { state: 'applied', preference, nativeCacheSync: result };
        } catch (error) {
          b.ttlRestore = { state: 'failed', nativeMayHaveChanged: applyAttempted, error: error.message };
        } finally { b.restoring = false; }
      }
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
    async sessionCommand(host, words, origin) {
      if (!words.length) words = ['status'];
      if (!['status', 'on', 'off', 'confirm'].includes(words[0]))
        throw new Error(`Use /claudex:warm on [5m|1h] [${WARM_LIMIT_HELP}], off, status, or confirm TOKEN.`);
      // This shortcut never changes the shared startup preference, including
      // remember-last. Preserve the native origin; do not manufacture a user.
      words = words.map((word, index) => index > 0 && words[0] === 'on' && ['5m', '1h'].includes(word) ? `ttl=${word}` : word);
      if (words[0] !== 'on') return this.command(host, words, origin, undefined, { sessionOnly: true });
      // The user's own limits become the existing bounds. The refresh interval
      // follows the TTL this command will apply: its own, else the saved one.
      const ttlWord = words.find(word => word.startsWith('ttl='));
      const ttl = ttlWord ? ttlWord.slice(4) : (await readPreference(host)).ttl ?? '1h';
      const limited = parseWarmLimits(words.slice(1), { intervalMinutes: ttl === '5m' ? 4 : 55, now: await host.now() });
      words = ['on', ...limited.rest, ...Object.entries(limited.bounds).map(([key, value]) => `${key}=${value}`)];
      // The explicit session command is the user's opt-in. Reuse the internal
      // one-use configuration transaction without a second composer submission.
      const context = await host.context();
      if (!binding || !same(binding.context, context)) await this.start(host);
      const b = binding, epoch = b?.epoch;
      if (!b || !same(b.context, context)) throw new Error('Native session context changed; run the command again.');
      const preview = await this.command(host, words, origin, context, { sessionOnly: true });
      const id = preview.confirm.split(' ').at(-1);
      if (!await safeContext(b, epoch)) {
        if (confirmation?.id === id) confirmation = null;
        throw new Error('Native session context changed; run the command again.');
      }
      const result = await this.command(host, ['confirm', id], origin, context, { sessionOnly: true });
      return { ...result, state: result.local?.enabled === true ? 'enabled' : 'disabled' };
    },
    async command(host, words, origin, expectedContext, { sessionOnly = false } = {}) {
      if (await host.worker()) throw new Error('Managed worker cache warming is disabled.');
      if (!binding || !same(binding.context, await host.context())) await this.start(host);
      const b = binding;
      if (!b) throw new Error('Native session context is unavailable.');
      if (expectedContext && !same(b.context, expectedContext)) throw new Error('Native panel context changed; reopen the cache settings.');
      if ((words[0] === 'status' || words[0] === 'preference') && words.length === 1) return { local: this.snapshot(),
        ttlPreference: await readPreference(host),
        nativeCache: await host.readCacheTtl(), ...await call(b, 'list') };
      // Never let model/plugin-authored commands opt another session into inference.
      if (!['composer', 'bridge', 'sdk', 'claudex-panel'].includes(origin?.kind)) throw new Error('Cache warming requires an explicit native user command.');
      if (words[0] === 'discard' && words.length === 1) { confirmation = null; return { state: 'preview-discarded' }; }
      if (words[0] === 'off' && words.length === 1) {
        cancel(b); b.epoch++; b.pending = null; b.enabled = false; confirmation = null;
        return call(b, 'configure', { enabled: false, instanceId: b.instanceId, requestId: token() });
      }
      if (words[0] === 'on' || words[0] === 'preference' || words[0] === 'ttl') {
        const preferenceBefore = await readPreference(host);
        const preferenceOnly = words[0] === 'preference';
        const ttlOnly = words[0] === 'ttl';
        if (ttlOnly && (words.length !== 2 || !['1h', '5m'].includes(words[1]))) throw new Error('Use warm ttl 1h|5m.');
        let preference;
        if (preferenceOnly) {
          if (words[1] === 'session' && words.length === 2) preference = { version: 1, mode: 'session' };
          else if (['remember', 'default'].includes(words[1]) && words.length === 3 && /^ttl=(1h|5m)$/.test(words[2]))
            preference = { version: 1, mode: words[1], ttl: words[2].slice(4), ...(words[1] === 'remember' ? { revision: token() } : {}) };
          else throw new Error('Use warm preference session|remember ttl=1h|5m|default ttl=1h|5m.');
        }
        const bounds = parseCacheWarmBounds(preferenceOnly || ttlOnly ? [] : words.slice(1)), now = await host.now();
        if (preferenceOnly) bounds.ttl = preference.ttl ?? null;
        else if (ttlOnly) bounds.ttl = words[1];
        else if (!words.slice(1).some(word => word.startsWith('ttl='))) bounds.ttl = preferenceBefore.ttl ?? '1h';
        confirmation = null;
        const nativeBefore = bounds.ttl ? await host.checkCacheTtl(bounds.ttl) : await host.readCacheTtl();
        confirmation = { id: token(), b, epoch: b.epoch, expiresAt: now + 120000, bounds, preference, preferenceBefore, settingsOnly: preferenceOnly || ttlOnly, sessionOnly };
        if (ttlOnly) return { state: 'confirmation-required', sessionId: b.context.sessionId, cwd: b.context.cwd,
          ttl: bounds.ttl, ttlPreference: preferenceBefore, nativeBefore: nativeBefore.value,
          effects: 'Apply the native main-cache TTL to this process and future children without enabling warming. Stops local warming. Remember mode saves this choice; a fixed default is unchanged. One-hour cache writes may cost more. Global settings and the subagent TTL variable are unchanged.',
          expiresAt: confirmation.expiresAt, confirm: `/claudex warm confirm ${confirmation.id}` };
        if (preferenceOnly) return { state: 'confirmation-required', sessionId: b.context.sessionId, cwd: b.context.cwd,
          ttlPreference: preference, previousPreference: preferenceBefore, nativeBefore: nativeBefore.value,
          effects: 'Save a plugin-wide preference for future loaded primary sessions sharing this native plugin store. Remember tracks subsequent confirmed Claudex TTL choices; default restores a fixed TTL. Session disables restoration without reverting the current TTL. This confirmation stops local warming and never enables inference. Native policy restrictions still apply; global settings and the subagent TTL variable are unchanged. Other running sessions are not changed. One-hour cache writes may cost more.',
          expiresAt: confirmation.expiresAt, confirm: `/claudex warm confirm ${confirmation.id}` };
        return { state: 'confirmation-required', sessionId: b.context.sessionId, cwd: b.context.cwd, ...bounds,
          ttlPreference: preferenceBefore,
          cacheWindow: { ttlMs: bounds.ttl === '1h' ? 3600000 : 300000, ttlSource: 'native-setting',
            refreshBeforeExpiryMs: bounds.ttl === '1h' ? 300000 : 60000 },
          nativeCacheChange: { scope: 'current-process', before: nativeBefore.value, after: bounds.ttl,
            variable: 'CLAUDE_CODE_PROMPT_CACHE_TTL', affectsSubagentTtl: false, writesGlobalSettings: false },
          observedCachedPrefixTokens: b.sample ? b.sample.cacheReadTokens + b.sample.cacheWriteTokens : null,
          nativeOutputCapUnchanged: true,
          savesTtlPreference: !sessionOnly && preferenceBefore.mode === 'remember',
          effects: 'Confirming sets the real native main-cache TTL for this process and future children, then enables real plugin-origin OK turns that consume quota and remain in history. '
            + (sessionOnly ? 'This session-only command never changes saved startup preferences or remembered TTL choices. Other running sessions are unchanged. ' : 'Remember mode also saves this TTL for future sessions; default mode keeps its fixed startup TTL. ')
            + 'One-hour cache writes can cost more than five-minute writes. Global settings and the subagent TTL variable are unchanged. Model and effort are inherited. Token bounds stop future refreshes, not a hard per-request cap. Turning warming off does not undo the native TTL choice.',
          expiresAt: confirmation.expiresAt, confirm: `${sessionOnly ? '/claudex:warm' : '/claudex warm'} confirm ${confirmation.id}` };
      }
      if (words[0] === 'confirm' && words.length === 2) {
        const prepared = confirmation; confirmation = null;
        if (!prepared || prepared.id !== words[1] || prepared.b !== b || prepared.epoch !== b.epoch || prepared.sessionOnly !== sessionOnly)
          throw new Error('Cache warming confirmation expired or its native context changed.');
        if (b.phase !== 'idle' || b.pending || b.dispatch || b.checking || b.configuring || b.restoring || b.turn?.attemptId)
          throw new Error('Wait for the current native turn before changing the native cache TTL.');
        // Own the configuration boundary before any awaited native reads. Even a
        // timer callback already queued by the host must not claim a warm turn.
        b.configuring = true; cancel(b);
        let nativeSync, applyAttempted = false, saveAttempted = false, configureEpoch = prepared.epoch, reply;
        const guard = async () => {
          if (!await safeContext(b, configureEpoch) || b.phase !== 'idle' || b.pending || b.dispatch || b.turn?.attemptId)
            throw new Error('The native context or current native turn changed during TTL synchronization.');
        };
        try {
          if (await host.now() >= prepared.expiresAt) throw new Error('Cache warming confirmation expired.');
          await guard();
          if (!preferenceEqual(await readPreference(host), prepared.preferenceBefore)) throw new Error('TTL preference changed; confirm the new preference again.');
          const nativeBefore = prepared.bounds.ttl ? await host.checkCacheTtl(prepared.bounds.ttl) : await host.readCacheTtl();
          await guard();
          const reset = prepared.settingsOnly || nativeBefore.value !== prepared.bounds.ttl || nativeBefore.environmentValue !== prepared.bounds.ttl
            || b.ttlPreference !== prepared.bounds.ttl;
          if (reset) {
            const wasEnabled = b.enabled;
            b.enabled = false; b.epoch++; b.sample = null; b.sampleFingerprint = null; b.publishedSampleId = null;
            configureEpoch = b.epoch;
            if (!prepared.settingsOnly || wasEnabled) await call(b, 'configure', { enabled: false, instanceId: b.instanceId, requestId: `${prepared.id}:pause` });
          }
          await guard();
          if (prepared.bounds.ttl) {
            applyAttempted = true;
            nativeSync = await host.applyCacheTtl(prepared.bounds.ttl, nativeBefore.value, guard);
            if (nativeSync?.value !== prepared.bounds.ttl || nativeSync?.scope !== 'current-process')
              throw new Error('Native cache TTL readback did not match the requested value.');
            b.ttlPreference = prepared.bounds.ttl;
          }
          await guard();
          const saved = prepared.preference ?? (!prepared.sessionOnly && prepared.preferenceBefore.mode === 'remember'
            ? { ...prepared.preferenceBefore, ttl: prepared.bounds.ttl } : null);
          if (saved) {
            if (!preferenceEqual(await readPreference(host), prepared.preferenceBefore)) throw new Error('TTL preference changed before save; confirm again.');
            await guard(); saveAttempted = true;
            if (prepared.preference) await savePreference(host, saved);
            else {
              // Never rewrite the mode from a remember update. A stale session's
              // last-choice write belongs only to its preference revision and
              // cannot undo a newer default/session/remember selection.
              await host.writeLastTtlChoice({ revision: saved.revision, ttl: saved.ttl });
              if (!preferenceEqual(await readPreference(host), saved)) throw new Error('TTL preference changed during remember update; inspect status.');
            }
            await guard();
          }
          if (prepared.settingsOnly) {
            b.reason = 'disabled'; b.suspended = false;
            return { state: prepared.preference ? 'preference-saved' : 'ttl-applied', ttlPreference: saved ?? prepared.preferenceBefore,
              nativeCacheSync: nativeSync ?? null, local: this.snapshot() };
          }
          // Explicit confirmation first registers this exact live instance. Default-off
          // starts and status reads never create a broker observer or policy.
          const initialSample = b.sample;
          const bound = await call(b, 'observe', { ...fields(b), sequence: ++b.sequence, phase: b.phase,
            ...(initialSample ? { sample: initialSample } : {}) });
          if (bound?.observed !== true) throw new Error('The native cache-warming observer could not be bound.');
          await guard();
          if (initialSample) b.publishedSampleId = initialSample.id;
          reply = await call(b, 'configure', { enabled: true, ...prepared.bounds, instanceId: b.instanceId, requestId: prepared.id });
          await guard();
          b.enabled = reply?.policy?.enabled === true; b.suspended = false;
        } catch (error) {
          b.enabled = false; fault(b, 'native-ttl-sync-or-enable-failed');
          throw new Error(`Local warming is stopped; broker activation is not confirmed. ${applyAttempted ? 'The native TTL may have changed and was not rolled back. ' : ''}${saveAttempted ? 'The saved preference may have changed; inspect status. ' : ''}${error.message}`);
        } finally { b.configuring = false; }
        await observe(b, b.sample); return { ...reply, nativeCacheSync: nativeSync, local: this.snapshot() };
      }
      throw new Error('Use /claudex warm status|ttl 1h|5m|preference [session|remember ttl=1h|5m|default ttl=1h|5m]|on [ttl=1h|5m maxMinutes=N maxRefreshes=N maxOutputTokens=N]|confirm TOKEN|off.');
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
      const epoch = b.epoch, startedAt = await b.host.now(), config = await b.host.cacheConfiguration(b.ttlPreference);
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
