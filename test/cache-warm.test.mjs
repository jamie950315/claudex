import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, chmod, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheWarmManager, CACHE_WARM_PROMPT } from '../src/cache-warm.mjs';

const identity = { sessionId: 'fixture-session', cwd: '/fixture/project', instanceId: 'instance-one' };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-warm-')));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  let time = 1000000, sequence = 0;
  const f = { root, tick(ms) { time += ms; }, now: () => time,
    sample(more = {}) { return { id: `response-${time}`, startedAt: time - 1000, completedAt: time,
      model: 'claude-sonnet-5-5', effort: 'medium', ttlMs: 300000, ttlSource: 'conservative-minimum',
      inputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 6000, outputTokens: 4, stopReason: 'end_turn', ...more }; } };
  f.manager = await new CacheWarmManager({ root, now: f.now, ...options }).initialize();
  f.observe = (more = {}) => f.manager.observe({ ...identity, sequence: ++sequence, epoch: 0, phase: 'idle', ...more });
  f.enable = (more = {}) => f.manager.configure({ ...identity, provider: 'claude', enabled: true, requestId: `enable-${time}`, ...more });
  f.claim = (more = {}) => f.manager.claim({ ...identity, epoch: 0, ...more });
  f.check = (attemptId, more = {}) => f.manager.check({ ...identity, epoch: 0, attemptId, ...more });
  f.receipt = (attemptId, outcome) => f.manager.receipt({ ...identity, attemptId, outcome });
  f.seed = async () => { await f.observe({ sample: f.sample() }); await f.enable(); f.tick(239000); };
  return f;
}

test('empty inspection is read-only, provider support and native binding are explicit', async t => {
  const f = await fixture(t);
  const list = await f.manager.list();
  assert.equal(list.providers.codex, 'unsupported'); assert.deepEqual(list.policies, []);
  await assert.rejects(readFile(join(f.root, 'cache-warm.json')), { code: 'ENOENT' });
  await assert.rejects(f.enable(), { code: 'CACHE_WARM_NOT_BOUND' });
  await assert.rejects(f.manager.configure({ ...identity, provider: 'codex', enabled: true }), { code: 'CACHE_WARM_UNSUPPORTED' });
  await f.observe();
  await assert.rejects(f.enable({ requestId: undefined }), /requestId/);
  const configured = await f.enable();
  assert.equal(configured.reason, 'scheduled'); assert.equal(configured.policy.native.phase, 'idle');
  assert.equal(configured.prime, true); assert.equal(configured.nextAt, f.now());
});

test('off preserves enrollment bounds and accounting instead of showing a new zero budget', async t => {
  const f = await fixture(t); await f.seed();
  const claimed = await f.claim(); await f.check(claimed.attempt.id);
  const before = (await f.manager.list()).policies[0];
  const stopped = await f.manager.configure({ ...identity, provider: 'claude', enabled: false, requestId: 'stop-preserves-budget' });
  assert.equal(stopped.policy.enabled, false);
  assert.equal(stopped.policy.generation, before.generation);
  assert.equal(stopped.policy.maxReadTokens, before.maxReadTokens);
  assert.deepEqual(stopped.policy.totals, before.totals);
  assert.equal((await f.check(claimed.attempt.id)).ready, false);
});

test('explicit enable primes missing or expired usage itself and then refreshes without a human turn', async t => {
  for (const expired of [false, true]) {
    const f = await fixture(t);
    await f.observe(expired ? { sample: f.sample() } : {});
    if (expired) f.tick(300000);
    const enabled = await f.enable();
    assert.equal(enabled.prime, true); assert.equal(enabled.nextAt, f.now());
    const { attempt } = await f.claim();
    assert.equal(attempt.kind, 'prime');
    assert.equal((await f.claim()).reason, 'attempt-pending');
    assert.equal((await f.check(attempt.id)).ready, true);
    assert.equal((await f.check(attempt.id)).ready, false);
    await f.receipt(attempt.id, 'submitted'); f.tick(1000);
    const result = await f.observe({ epoch: 1, attemptId: attempt.id, sample: f.sample({ cacheWriteTokens: 0, inputTokens: 6000 }) });
    assert.equal(result.policy.enabled, true); assert.equal(result.prime, false); assert.ok(result.nextAt > f.now());
    const entry = (await f.manager.list()).attempts[0];
    assert.equal(entry.state, 'verified'); assert.equal(entry.reason, 'native-cache-primed');
    assert.equal(entry.requiredPrefixTokens, 0); assert.equal(entry.model, null);
    assert.equal(entry.actual.inputTokens, 6000); assert.equal(entry.actual.cacheWriteTokens, 0);
    assert.deepEqual(result.policy.cacheResults, { count: 0, firstAt: null, lastAt: null });
    f.tick(result.nextAt - f.now());
    const next = await f.claim({ epoch: 1 }); assert.equal(next.claimed, true); assert.equal(next.attempt.kind, undefined);
  }
});

test('prime retains exact lifecycle, revocation, dispatch deadline and restart no-replay', async t => {
  for (const scenario of ['off', 'activity', 'expiry', 'restart']) {
    const f = await fixture(t); await f.observe(); await f.enable();
    const { attempt } = await f.claim();
    if (scenario === 'off') await f.manager.configure({ ...identity, provider: 'claude', enabled: false });
    if (scenario === 'activity') await f.observe({ epoch: 1, phase: 'busy' });
    if (scenario === 'expiry') f.tick(120000);
    if (scenario === 'restart') {
      await f.check(attempt.id); await f.receipt(attempt.id, 'submitted');
      f.manager = await new CacheWarmManager({ root: f.root, now: f.now }).initialize();
      assert.equal((await f.manager.list()).attempts[0].state, 'uncertain');
    }
    assert.equal((await f.check(attempt.id)).ready, false);
    assert.equal((await f.claim()).claimed, false);
  }
});

test('reservation and one-use authorization do not prove a hit; native own sample does', async t => {
  const f = await fixture(t); await f.seed();
  const claimed = await f.claim(); assert.equal(claimed.claimed, true);
  assert.equal(claimed.attempt.prompt, CACHE_WARM_PROMPT);
  const id = claimed.attempt.id;
  assert.equal((await f.claim()).reason, 'attempt-pending');
  assert.equal((await f.check(id)).ready, true);
  assert.equal((await f.check(id)).ready, false);
  await f.observe({ phase: 'busy', epoch: 1, attemptId: id });
  await f.receipt(id, 'submitted');
  let list = await f.manager.list();
  assert.equal(list.attempts[0].state, 'submitted'); assert.equal(list.policies[0].nextAt, null);
  assert.deepEqual(list.policies[0].cacheResults, { count: 0, firstAt: null, lastAt: null });
  f.tick(1000);
  const result = await f.observe({ epoch: 1, attemptId: id, sample: f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 80, attemptId: id }) });
  assert.equal(result.policy.enabled, true); assert.ok(result.nextAt > f.now());
  list = await f.manager.list();
  assert.equal(list.attempts[0].state, 'verified');
  assert.equal(list.attempts[0].reservedReadTokens, 6256);
  assert.equal(list.policies[0].totals.readTokens, 6000);
  assert.equal(list.policies[0].totals.outputTokens, 4);
  assert.deepEqual(list.policies[0].cacheResults, { count: 1, firstAt: f.now(), lastAt: f.now() });
  assert.equal((await f.receipt(id, 'submitted')).state, 'verified');
});

test('normal work revokes a reserved attempt, and receipt cannot reauthorize it', async t => {
  const f = await fixture(t); await f.seed();
  const { attempt } = await f.claim();
  await f.observe({ phase: 'busy', epoch: 1 });
  assert.equal((await f.check(attempt.id)).ready, false);
  assert.equal((await f.receipt(attempt.id, 'rejected')).state, 'revoked');
  assert.equal((await f.manager.list()).attempts.length, 1);
});

test('unrelated activity after native authorization preserves uncertainty and stops policy', async t => {
  const f = await fixture(t); await f.seed();
  const { attempt } = await f.claim(); await f.check(attempt.id);
  await f.observe({ phase: 'busy', epoch: 1 });
  await f.receipt(attempt.id, 'submitted');
  const list = await f.manager.list();
  assert.equal(list.attempts[0].state, 'uncertain'); assert.equal(list.policies[0].enabled, false);
});

test('cache misses refresh without claiming a hit; native failure and model changes still stop warming', async t => {
  // The preceding request re-read 3,000 tokens of older entries and wrote 3,000 of its own.
  const run = async change => {
    const f = await fixture(t);
    await f.observe({ sample: f.sample({ cacheReadTokens: 3000, cacheWriteTokens: 3000 }) }); await f.enable(); f.tick(239000);
    const { attempt } = await f.claim(); await f.check(attempt.id);
    assert.equal((await f.manager.list()).attempts[0].priorReadTokens, 3000);
    f.tick(1000);
    const result = await f.observe({ epoch: 1, attemptId: attempt.id,
      sample: f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 80, ...change }) });
    return { result, attempt: (await f.manager.list()).attempts[0] };
  };
  // Only what was cached before that request, or a prefix this request does not cover again.
  for (const change of [{ stopReason: 'max_tokens' }, { model: 'different-model' }]) {
    const { result, attempt } = await run(change);
    assert.equal(result.policy.enabled, false, JSON.stringify(change));
    assert.equal(attempt.state, 'failed');
  }
  for (const change of [{ cacheReadTokens: 3000 }, { cacheReadTokens: 2999, cacheWriteTokens: 3100 }, { cacheReadTokens: 5000, cacheWriteTokens: 900 }]) {
    const { result, attempt } = await run(change);
    assert.equal(result.policy.enabled, true); assert.equal(attempt.state, 'verified');
    assert.equal(attempt.reason, 'native-cache-refreshed');
  }
  // Claude Code re-reads all but the tail of the preceding request: its own entries are alive.
  for (const change of [{}, { cacheReadTokens: 5949, cacheWriteTokens: 155 }, { cacheReadTokens: 3001, cacheWriteTokens: 2999 }]) {
    const { result, attempt } = await run(change);
    assert.equal(attempt.state, 'verified', JSON.stringify(change)); assert.equal(result.policy.enabled, true);
  }
  // A journal written before this evidence was recorded keeps the whole-prefix rule.
  const f = await fixture(t); await f.seed();
  const { attempt } = await f.claim(); await f.check(attempt.id);
  const saved = JSON.parse(await readFile(join(f.root, 'cache-warm.json'), 'utf8')); delete saved.attempts[0].priorReadTokens;
  f.manager.state.attempts[0] = saved.attempts[0]; f.tick(1000);
  await f.observe({ epoch: 1, attemptId: attempt.id, sample: f.sample({ cacheReadTokens: 5999, cacheWriteTokens: 80 }) });
  assert.equal((await f.manager.list()).attempts[0].reason, 'native-cache-refreshed');
});

test('enable request idempotency never resets duration, counts, or budgets', async t => {
  const f = await fixture(t); await f.observe({ sample: f.sample() });
  const first = await f.enable({ requestId: 'same-request' });
  f.tick(50000);
  const second = await f.enable({ requestId: 'same-request' });
  assert.equal(second.replayed, true); assert.equal(second.policy.until, first.policy.until);
  assert.equal(second.policy.generation, first.policy.generation);
  await assert.rejects(f.enable({ requestId: 'same-request', maxRefreshes: 10 }), /different parameters/);
});

test('policy generation changes revoke preflight; disable remains available while app is stopped', async t => {
  let stopped = false;
  const f = await fixture(t, { stopped: async () => stopped }); await f.seed();
  const { attempt } = await f.claim(); stopped = true;
  await f.manager.configure({ ...identity, provider: 'claude', enabled: false });
  assert.equal((await f.check(attempt.id)).ready, false);
  await f.observe({ phase: 'ended', epoch: 1 });
  assert.equal((await f.manager.list()).policies[0].bound, false);
});

test('awaited stop inspection cannot hide a simultaneous policy revocation', async t => {
  let gate;
  const f = await fixture(t, { stopped: async () => gate ? gate.promise : false }); await f.seed();
  const { attempt } = await f.claim(); gate = deferred();
  const checking = f.check(attempt.id);
  await f.manager.configure({ ...identity, provider: 'claude', enabled: false });
  gate.resolve(false);
  assert.equal((await checking).ready, false);
});

test('app stop and absolute cache expiry refuse claims without catch-up bursts', async t => {
  let stopped = false;
  const f = await fixture(t, { stopped: async () => stopped }); await f.seed();
  stopped = true;
  assert.equal((await f.claim()).reason, 'app-stopped'); stopped = false;
  f.tick(61000);
  assert.equal((await f.claim()).reason, 'cache-expired');
  assert.equal((await f.manager.list()).attempts.length, 0);
});

test('app stop refuses enable but allows disable and evidence inspection', async t => {
  const f = await fixture(t, { stopped: async () => true }); await f.observe({ sample: f.sample() });
  await assert.rejects(f.enable(), { code: 'CACHE_WARM_STOPPED' });
  assert.equal((await f.manager.configure({ ...identity, provider: 'claude', enabled: false })).policy.enabled, false);
  assert.equal((await f.manager.list()).attempts.length, 0);
});

test('normal model changes invalidate the existing opt-in instead of silently warming another model', async t => {
  for (const change of [{ model: 'other-model' }, { effort: 'high' }, { ttlMs: 3600000, ttlSource: 'native-setting' }]) {
    const f = await fixture(t); await f.seed(); f.tick(1);
    const result = await f.observe({ epoch: 1, sample: f.sample(change) });
    assert.equal(result.policy.enabled, false); assert.equal(result.reason, 'native-configuration-changed');
  }
});

test('expired preflight is consumed without authorizing a late turn', async t => {
  const f = await fixture(t); await f.seed();
  const { attempt } = await f.claim(); f.tick(60000);
  const result = await f.check(attempt.id);
  assert.equal(result.ready, false); assert.equal(result.reason, 'attempt-expired');
  assert.equal((await f.manager.list()).attempts[0].state, 'revoked');
});

test('a full ledger refuses new allocation; a new enrollment drops only its own settled earlier attempts', async t => {
  const f = await fixture(t); await f.seed();
  const { attempt } = await f.claim();
  await f.receipt(attempt.id, 'rejected');
  const path = join(f.root, 'cache-warm.json'), state = JSON.parse(await readFile(path, 'utf8'));
  const other = { ...state.policies[0], sessionId: 'other-session', enabled: false }, base = state.attempts[0];
  const others = count => Array.from({ length: count }, (_, i) => ({ ...base, sessionId: other.sessionId, id: `other-${i}` }));
  const load = async attempts => {
    await writeFile(path, JSON.stringify({ ...state, attempts }), { mode: 0o600 });
    const m = await new CacheWarmManager({ root: f.root, now: f.now }).initialize();
    await m.observe({ ...identity, sequence: 1, epoch: 0, phase: 'idle', sample: f.sample() });
    return m;
  };
  state.policies[0].generation = 2; state.policies.push(other);
  // An uncertain outcome is evidence, not a settled record: it survives a new enrollment.
  let m = await load([{ ...base, id: 'own-uncertain', state: 'uncertain' }, { ...base, id: 'own-failed', state: 'failed' }]);
  await m.configure({ ...identity, provider: 'claude', enabled: true, requestId: 'uncertain-kept' });
  assert.deepEqual((await m.list()).attempts.map(a => a.id), ['own-uncertain']);
  state.policies[0].generation = 2;
  // A still-authorized conversation's records occupy capacity and are never dropped here.
  other.enabled = true; other.until = f.now() + 3600000;
  m = await load([...others(2046), { ...base, id: 'own-rejected' }, { ...base, id: 'own-verified', state: 'verified' }]);
  let listing = await m.list();
  assert.equal(listing.attemptCount, 2048); assert.equal(listing.attempts.length, 64); assert.equal(listing.attemptsTruncated, true);
  await m.configure({ ...identity, provider: 'claude', enabled: true, requestId: 'new-capacity-test' });
  assert.equal((await m.list()).attemptCount, 2046);
  f.tick(239000);
  assert.equal((await m.claim({ ...identity, epoch: 0 })).claimed, true);
  // A ledger full of records that may not be dropped refuses rather than making room.
  state.policies[0] = JSON.parse(await readFile(path, 'utf8')).policies[0];
  m = await load(others(2048)); f.tick(239000);
  await assert.rejects(m.claim({ ...identity, epoch: 0 }), { code: 'CACHE_WARM_CAPACITY' });
  // A crowded ledger also gives up a stopped, ended conversation's settled records.
  other.enabled = false; other.until = f.now() - 1; state.policies[0].enabled = false;
  m = await load([...others(1500), { ...base, sessionId: other.sessionId, id: 'other-uncertain', state: 'uncertain' }]);
  await m.configure({ ...identity, provider: 'claude', enabled: true, requestId: 'crowded-test' });
  assert.deepEqual((await m.list()).attempts.map(a => a.id), ['other-uncertain']);
  // The uncertain record keeps its policy; without it the whole conversation is retired.
  assert.equal((await m.list()).policies.length, 2);
  state.policies[0].enabled = false;
  state.requests = [{ requestId: 'other-old', sessionId: other.sessionId, generation: 1, payload: '{}' },
    { requestId: 'own-old', sessionId: identity.sessionId, generation: 1, payload: '{}' }];
  m = await load(others(1500));
  await m.configure({ ...identity, provider: 'claude', enabled: true, requestId: 'retired-test' });
  assert.deepEqual((await m.list()).policies.map(policy => policy.sessionId), [identity.sessionId]);
  assert.equal((await m.list()).attemptCount, 0);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).requests.map(r => r.requestId), ['own-old', 'retired-test']);
  // Many stopped conversations are retired by count too; running and unexpired ones stay.
  state.policies[0].enabled = false; state.requests = [];
  const extra = Array.from({ length: 40 }, (_, i) => ({ ...other, sessionId: `ended-${i}` }));
  state.policies.push(...extra, { ...other, sessionId: 'running', enabled: true }, { ...other, sessionId: 'unexpired', until: f.now() + 60000 });
  m = await load([]);
  await m.configure({ ...identity, provider: 'claude', enabled: true, requestId: 'count-test' });
  assert.deepEqual((await m.list()).policies.map(policy => policy.sessionId).sort(), [identity.sessionId, 'running', 'unexpired'].sort());
  state.policies.length = 2; state.requests = [];
  // A ledger that is not crowded keeps them for their status totals.
  state.policies[0].enabled = false;
  m = await load(others(10));
  await m.configure({ ...identity, provider: 'claude', enabled: true, requestId: 'roomy-test' });
  assert.equal((await m.list()).attemptCount, 10);
});

test('duration and admission output budgets prevent a native authorization', async t => {
  for (const [bounds, reason] of [
    [{ maxMinutes: 1 }, 'duration-limit'], [{ maxOutputTokens: 127 }, 'output-budget'],
  ]) {
    const f = await fixture(t); await f.observe({ sample: f.sample() }); await f.enable(bounds); f.tick(239000);
    assert.equal((await f.claim()).reason, reason);
  }
});

test('large prefixes and accumulated actual reads have no limit, including legacy finite journals', async t => {
  for (const provider of ['claude', 'codex']) {
    const f = await fixture(t, { provider });
    const sample = more => ({ ...(provider === 'codex' ? codexSample(f) : f.sample()), ...more,
      ...(provider === 'codex' ? { inputTokens: (more.cacheReadTokens ?? 0) + (more.cacheWriteTokens ?? 0) } : {}) });
    await f.observe({ sample: sample({ cacheWriteTokens: 300000 }) });
    const enabled = await f.enable({ provider, bestEffort: true, maxMinutes: 120, maxReadTokens: 1 });
    assert.equal(enabled.policy.maxReadTokens, null);
    const path = f.manager.path, saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.policies[0].maxReadTokens, null);
    // A historical finite value remains intact on disk but cannot restrict reads.
    saved.policies[0].maxReadTokens = 250000;
    const original = JSON.stringify(saved);
    await writeFile(path, original, { mode: 0o600 });
    f.manager = await new CacheWarmManager({ root: f.root, provider, now: f.now }).initialize();
    assert.equal((await f.manager.list()).policies[0].maxReadTokens, null);
    assert.equal((await f.manager.list()).policies[0].bound, false);
    assert.equal(await readFile(path, 'utf8'), original, 'Inspection does not rewrite legacy history.');
    await f.observe({ sample: sample({ cacheWriteTokens: 300000 }) });
    const interval = (provider === 'codex' ? 25 : 4) * 60000;
    for (let epoch = 0; epoch < 2; epoch++) {
      f.tick(interval - 1000);
      const { attempt, claimed } = await f.claim({ epoch }); assert.equal(claimed, true);
      const before = (await f.manager.list()).attempts.at(-1);
      assert.equal(before.reservedReadTokens, (epoch === 0 ? 300000 : 310000) + 256);
      assert.equal((await f.check(attempt.id, { epoch })).ready, true);
      f.tick(1000);
      const result = await f.observe({ epoch: epoch + 1, attemptId: attempt.id,
        sample: sample({ cacheReadTokens: 310000 + epoch * 10000, cacheWriteTokens: 0 }) });
      assert.equal(result.policy.enabled, true);
      assert.equal(result.policy.maxReadTokens, null);
    }
    const p = (await f.manager.list()).policies[0];
    assert.equal(p.totals.readTokens, 630000); assert.equal(p.totals.outputTokens, 8);
    f.tick(interval - 1000);
    assert.equal((await f.claim({ epoch: 2 })).claimed, true);
  }
});

test('unlimited read schema and legacy receipt replay never reactivate a stopped policy', async t => {
  for (const limit of [undefined, 250000, null]) {
    const f = await fixture(t); await f.observe({ sample: f.sample() });
    const input = { ...identity, provider: 'claude', enabled: true, requestId: 'legacy-read-receipt', maxReadTokens: limit };
    await f.manager.configure(input);
    await f.manager.configure({ ...identity, provider: 'claude', enabled: false });
    const path = f.manager.path, saved = JSON.parse(await readFile(path, 'utf8'));
    if (limit !== null) saved.policies[0].maxReadTokens = 250000;
    saved.policies[0].reason = 'read-budget';
    const original = JSON.stringify(saved);
    await writeFile(path, original, { mode: 0o600 });
    const restarted = await new CacheWarmManager({ root: f.root, now: f.now }).initialize();
    const replay = await restarted.configure(input);
    assert.equal(replay.replayed, true); assert.equal(replay.policy.enabled, false);
    assert.equal(replay.policy.maxReadTokens, null); assert.equal(replay.policy.bound, false);
    assert.equal(replay.policy.generation, saved.policies[0].generation);
    assert.equal(replay.policy.until, saved.policies[0].until);
    assert.equal(replay.policy.reason, 'read-budget');
    assert.equal(await readFile(path, 'utf8'), original);
    await assert.rejects(restarted.configure({ ...input, maxReadTokens: 500000 }), /different parameters/);
  }
});

test('actual usage can exceed admission reservation and disables the policy visibly', async t => {
  const f = await fixture(t); await f.observe({ sample: f.sample() }); await f.enable({ maxOutputTokens: 128 }); f.tick(239000);
  const { attempt } = await f.claim(); await f.check(attempt.id); f.tick(1000);
  await f.observe({ epoch: 1, attemptId: attempt.id, sample: f.sample({ cacheReadTokens: 6000, outputTokens: 129 }) });
  const list = await f.manager.list();
  assert.equal(list.policies[0].reason, 'actual-budget-exceeded');
  assert.equal(list.policies[0].totals.outputTokens, 129);
});

test('refresh count is exact and concurrent claims cannot duplicate dispatch', async t => {
  const f = await fixture(t); await f.observe({ sample: f.sample() }); await f.enable({ maxRefreshes: 1 }); f.tick(239000);
  const claims = await Promise.all([f.claim(), f.claim(), f.claim()]);
  assert.equal(claims.filter(c => c.claimed).length, 1);
  const id = claims.find(c => c.claimed).attempt.id; await f.check(id); f.tick(1000);
  await f.observe({ epoch: 1, attemptId: id, sample: f.sample({ cacheReadTokens: 6000 }) }); f.tick(239000);
  assert.equal((await f.claim({ epoch: 1 })).reason, 'refresh-limit');
});

test('restart drops observations, preserves pending uncertainty, and never replays', async t => {
  const f = await fixture(t); await f.seed();
  const { attempt } = await f.claim(); await f.check(attempt.id); await f.receipt(attempt.id, 'submitted');
  const restarted = await new CacheWarmManager({ root: f.root, now: f.now }).initialize();
  const list = await restarted.list();
  assert.equal(list.policies[0].bound, false); assert.equal(list.policies[0].enabled, false);
  assert.equal(list.attempts[0].state, 'uncertain');
  assert.equal((await restarted.check({ ...identity, epoch: 0, attemptId: attempt.id })).ready, false);
  assert.equal((await restarted.receipt({ ...identity, attemptId: attempt.id, outcome: 'submitted' })).state, 'uncertain');
});

test('stale observation, sample, and retired instance cannot renew a timer', async t => {
  const f = await fixture(t); await f.seed();
  assert.equal((await f.manager.observe({ ...identity, phase: 'idle', epoch: 0, sequence: 1 })).observed, false);
  await f.observe({ phase: 'ended', epoch: 1 });
  assert.equal((await f.observe({ phase: 'idle', epoch: 2 })).observed, false);
  assert.equal((await f.manager.list()).policies[0].enabled, false);
});

test('retired bindings release capacity while bounded tombstones fence old sessions and replaced instances', async t => {
  const f = await fixture(t), m = f.manager;
  const observe = (i, phase, sessionId = `retired-${i}`) => m.observe({ sessionId, cwd: identity.cwd,
    instanceId: `warm-${i}-fixture`, epoch: 0, sequence: phase === 'ended' ? 2 : 1, phase });
  for (let i = 1; i <= 160; i++) {
    assert.equal((await observe(i, 'idle')).observed, true);
    assert.equal((await observe(i, 'ended')).observed, true);
  }
  assert.equal(m.bindings.size, 0); assert.equal(m.retired.size, 64);
  assert.equal((await observe(1, 'idle')).reason, 'stale-observation');
  for (let i = 161; i <= 320; i++) assert.equal((await observe(i, 'idle', 'replaced')).observed, true);
  assert.equal(m.bindings.size, 1); assert.equal(m.retired.size, 64);
  assert.equal((await observe(161, 'idle', 'replaced')).reason, 'stale-observation');
  assert.equal(m.bindings.get('replaced').instanceId, 'warm-320-fixture');
  const status = await m.list();
  assert.equal(status.providerStatus.bindings, 1); assert.equal(status.providerStatus.retiredBindings, 64);
});

test('the retirement floor preserves active older bindings, rejects forgotten legacy callbacks, and keeps the live limit', async t => {
  const f = await fixture(t), m = f.manager;
  await f.observe();
  for (let i = 0; i < 70; i++) await m.observe({ sessionId: `old-${i}`, cwd: identity.cwd,
    instanceId: `legacy-${i}`, epoch: 0, sequence: 1, phase: 'ended' });
  assert.equal((await f.observe()).observed, true, 'An admitted legacy binding keeps its contract.');
  assert.equal((await m.observe({ sessionId: 'old-0', cwd: identity.cwd, instanceId: 'legacy-0',
    epoch: 1, sequence: 2, phase: 'idle' })).reason, 'stale-observation');
  for (let i = 1; i < 64; i++) await m.observe({ sessionId: `live-${i}`, cwd: identity.cwd,
    instanceId: `warm-${i}-live`, epoch: 0, sequence: 1, phase: 'idle' });
  await assert.rejects(m.observe({ sessionId: 'overflow', cwd: identity.cwd, instanceId: 'warm-100-live',
    epoch: 0, sequence: 1, phase: 'idle' }), { code: 'CACHE_WARM_CAPACITY' });
});

test('native-setting hour TTL uses a five-minute margin; malformed observations are rejected', async t => {
  const f = await fixture(t);
  const sample = f.sample({ ttlMs: 3600000, ttlSource: 'native-setting' });
  await f.observe({ sample }); const enabled = await f.enable({ maxMinutes: 120 });
  assert.equal(enabled.nextAt, sample.startedAt + 3300000);
  assert.equal((await f.claim()).reason, 'not-due');
  await assert.rejects(f.observe({ sample: f.sample({ ttlMs: 3600000 }) }), /Invalid/);
  await assert.rejects(f.observe({ sample: f.sample({ startedAt: f.now() - 300001 }) }), /Invalid/);
});

test('configured hour default and user-selected five-minute window have distinct deadlines', async t => {
  const f = await fixture(t);
  const sample = f.sample({ ttlMs: 3600000, ttlSource: 'configured-window' });
  await f.observe({ sample });
  const hour = await f.enable({ requestId: 'hour', maxMinutes: 120 });
  assert.equal(hour.policy.ttlPreference, '1h');
  assert.equal(hour.nextAt, sample.startedAt + 55 * 60000);
  const short = await f.enable({ requestId: 'five-minutes', ttl: '5m' });
  assert.equal(short.policy.ttlPreference, '5m');
  assert.equal(short.policy.effectiveTtlMs, 300000);
  assert.equal(short.nextAt, sample.startedAt + 4 * 60000);
  await assert.rejects(f.enable({ requestId: 'invalid-ttl', ttl: '30m' }), /ttl/);
  await assert.rejects(f.enable({ requestId: 'five-minutes', ttl: '1h' }), /different parameters/);
});

test('private journal rejects symlinks, hardlinks, permissive files, and malformed JSON', async t => {
  for (const kind of ['symlink', 'hardlink', 'mode', 'malformed']) {
    const f = await fixture(t), source = join(f.root, 'source.json'), path = join(f.root, 'cache-warm.json');
    await writeFile(source, kind === 'malformed' ? '{' : JSON.stringify({ version: 1, policies: [], attempts: [], requests: [] }), { mode: 0o600 });
    if (kind === 'symlink') await symlink(source, path);
    else if (kind === 'hardlink') await link(source, path);
    else { await writeFile(path, await readFile(source), { mode: kind === 'mode' ? 0o644 : 0o600 }); if (kind === 'mode') await chmod(path, 0o644); }
    await assert.rejects(new CacheWarmManager({ root: f.root }).initialize());
  }
});

test('a failed durable save closes dispatch even if native observations remain in memory', async t => {
  const f = await fixture(t); await f.seed();
  await chmod(join(f.root, 'cache-warm.json'), 0o644);
  await assert.rejects(f.claim());
  assert.equal((await f.claim()).claimed, false);
  assert.equal((await f.manager.list()).policies[0].reason, 'broker-stopping');
  const status = await f.manager.list();
  assert.equal(status.providerStatus.closed, true);
  assert.equal(status.providerStatus.reason, 'storage-failed');
  assert.equal(status.providerStatus.code, 'CACHE_WARM_STORAGE_FAILED');
  assert.equal(status.policies[0].enabled, false);
});

test('close consumes dispatch and leaves read-only status available without native bindings', async t => {
  const f = await fixture(t); await f.seed();
  const { attempt } = await f.claim(); await f.check(attempt.id); await f.manager.close();
  const list = await f.manager.list();
  assert.equal(list.attempts[0].state, 'uncertain'); assert.equal(list.policies[0].bound, false);
  await f.manager.configure({ ...identity, provider: 'claude', enabled: false });
  assert.equal((await f.check(attempt.id)).ready, false);
});

test('busy per-request samples charge every recovery once and never schedule another native turn', async t => {
  const f = await fixture(t); await f.seed();
  const { attempt } = await f.claim(); await f.check(attempt.id);
  await f.observe({ epoch: 1, phase: 'busy', attemptId: attempt.id }); f.tick(1000);
  const first = f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 20, stopReason: 'max_tokens', attemptId: attempt.id });
  await f.observe({ epoch: 1, phase: 'busy', sample: first });
  f.tick(1000);
  const second = f.sample({ cacheReadTokens: 6020, cacheWriteTokens: 20, attemptId: attempt.id });
  const result = await f.observe({ epoch: 1, phase: 'busy', sample: second });
  assert.equal(result.policy.enabled, false); assert.equal(result.nextAt, null);
  await f.observe({ epoch: 1, phase: 'idle', sample: second });
  const list = await f.manager.list();
  assert.equal(list.attempts[0].state, 'failed');
  assert.equal(list.attempts[0].actual.cacheReadTokens, 12020);
  assert.equal(list.attempts[0].actual.outputTokens, 8);
  assert.equal(list.attempts[0].responseIds.length, 2);
  assert.equal((await f.receipt(attempt.id, 'submitted')).state, 'failed');
});

test('a successful busy response only arms after idle and repeated final evidence cannot renew its clock', async t => {
  const f = await fixture(t); await f.seed();
  const { attempt } = await f.claim(); await f.check(attempt.id); f.tick(1000);
  const sample = f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 20, attemptId: attempt.id });
  const busy = await f.observe({ epoch: 1, phase: 'busy', sample });
  assert.equal(busy.reason, 'busy'); assert.equal(busy.nextAt, null);
  f.tick(1000);
  const idle = await f.observe({ epoch: 1, phase: 'idle' });
  const duplicate = await f.observe({ epoch: 1, phase: 'idle', sample });
  assert.equal(duplicate.observed, true); assert.equal(duplicate.nextAt, idle.nextAt);
  assert.equal(duplicate.policy.totals.outputTokens, 4);
  assert.equal((await f.observe({ epoch: 1, sample: { ...sample, outputTokens: 5 } })).reason, 'changed-sample');
});

test('normal busy tool-use requests preserve opt-in and only the final idle answer rearms', async t => {
  const f = await fixture(t); await f.seed();
  await f.observe({ phase: 'busy', epoch: 1 }); f.tick(1000);
  const toolStep = await f.observe({ phase: 'busy', epoch: 1,
    sample: f.sample({ stopReason: 'tool_use', cacheReadTokens: 6000, cacheWriteTokens: 100 }) });
  assert.equal(toolStep.policy.enabled, true); assert.equal(toolStep.nextAt, null);
  assert.equal(toolStep.reason, 'busy'); assert.equal(toolStep.policy.totals.refreshes, 0);
  f.tick(1000);
  const final = f.sample({ cacheReadTokens: 6100, cacheWriteTokens: 100 });
  const finishing = await f.observe({ phase: 'busy', epoch: 1, sample: final });
  assert.equal(finishing.policy.enabled, true); assert.equal(finishing.nextAt, null);
  const idle = await f.observe({ phase: 'idle', epoch: 1 });
  assert.equal(idle.policy.enabled, true); assert.equal(idle.nextAt, final.startedAt + 240000);
  assert.equal((await f.manager.list()).attemptCount, 0);
});

test('a warming tool-use response still fails and never borrows the ordinary-work exemption', async t => {
  const f = await fixture(t); await f.seed();
  const { attempt } = await f.claim(); await f.check(attempt.id); f.tick(1000);
  const result = await f.observe({ phase: 'busy', epoch: 1, attemptId: attempt.id,
    sample: f.sample({ stopReason: 'tool_use', cacheReadTokens: 6000 }) });
  assert.equal(result.policy.enabled, false); assert.equal(result.nextAt, null);
  assert.equal((await f.manager.list()).attempts[0].state, 'failed');
});

const codexSample = f => f.sample({ model: 'codex-fixture', ttlMs: 1800000, ttlSource: 'configured-window', inputTokens: 6000 });
const codexEnable = (f, more = {}) => f.enable({ provider: 'codex', bestEffort: true, ...more });

test('Codex partial cache reads never shrink the full request prefix or become a false hit', async t => {
  const f = await fixture(t, { provider: 'codex' });
  await f.observe(); await codexEnable(f);
  for (const [index, inputTokens, cacheReadTokens] of [[0, 10000, 0], [1, 11000, 1000], [2, 12000, 1000]]) {
    const { attempt } = await f.claim({ epoch: index });
    assert.equal(attempt.kind, index === 0 ? 'prime' : undefined);
    const saved = (await f.manager.list()).attempts.at(-1);
    assert.equal(saved.requiredPrefixTokens, index === 0 ? 0 : inputTokens - 1000);
    await f.check(attempt.id, { epoch: index }); await f.receipt(attempt.id, 'submitted'); f.tick(1000);
    const result = await f.observe({ epoch: index + 1, attemptId: attempt.id, sample: f.sample({
      model: 'codex-fixture', ttlMs: 1800000, ttlSource: 'configured-window', inputTokens, cacheReadTokens, cacheWriteTokens: 0 }) });
    assert.equal(result.policy.enabled, true);
    assert.equal((await f.manager.list()).attempts.at(-1).reason, index === 0 ? 'native-cache-primed' : 'native-cache-refreshed');
    if (index < 2) f.tick(result.nextAt - f.now());
  }
});

test('Codex ledgers require explicit best-effort consent and cannot configure a native TTL', async t => {
  const f = await fixture(t, { provider: 'codex' }); await f.observe({ sample: codexSample(f) });
  assert.equal((await f.manager.list()).providers.codex, 'experimental-best-effort');
  await assert.rejects(f.enable(), { code: 'CACHE_WARM_UNSUPPORTED' });
  await assert.rejects(codexEnable(f, { bestEffort: undefined }), /explicit bestEffort/);
  await assert.rejects(codexEnable(f, { bestEffort: false }), /explicit bestEffort/);
  await assert.rejects(codexEnable(f, { ttl: '1h' }), /native TTL/);
  for (const refreshMinutes of [0, 26, 1.5, '5'])
    await assert.rejects(codexEnable(f, { refreshMinutes }), /refreshMinutes/);
  await assert.rejects(f.observe({ sample: f.sample() }), /Invalid/);
  await assert.rejects(f.observe({ sample: { ...codexSample(f), ttlSource: 'native-setting' } }), /Invalid/);
  const enabled = await codexEnable(f, { requestId: 'codex-consent' });
  assert.equal(enabled.policy.bestEffort, true); assert.equal(enabled.policy.refreshMinutes, 25);
  assert.equal(enabled.policy.ttlPreference, undefined);
  await assert.rejects(codexEnable(f, { requestId: 'codex-consent', refreshMinutes: 5 }), /different parameters/);
  assert.equal((await codexEnable(f, { requestId: 'codex-consent' })).replayed, true);
});

test('Codex refresh deadline is selectable but the local evidence window always expires at thirty minutes', async t => {
  for (const refreshMinutes of [1, 20, 25]) {
    const f = await fixture(t, { provider: 'codex' }), sample = codexSample(f);
    await f.observe({ sample }); const result = await codexEnable(f, { refreshMinutes });
    assert.equal(result.nextAt, sample.startedAt + refreshMinutes * 60000);
    assert.equal(result.policy.effectiveTtlMs, 1800000);
    assert.equal((await f.claim()).reason, 'not-due');
    f.tick(refreshMinutes * 60000 - 1000);
    const { attempt } = await f.claim();
    assert.equal(attempt.expiresAt, sample.startedAt + 1800000);
    f.tick((30 - refreshMinutes) * 60000);
    assert.equal((await f.check(attempt.id)).reason, 'attempt-expired');
    assert.equal((await f.claim()).reason, 'cache-expired');
  }
});

test('Codex and Claude journals isolate identical session and request identities across restart', async t => {
  const f = await fixture(t); await f.observe({ sample: f.sample() }); await f.enable({ requestId: 'shared-id' });
  const claudePath = join(f.root, 'cache-warm.json'), original = await readFile(claudePath, 'utf8');
  const codex = await new CacheWarmManager({ root: f.root, provider: 'codex', now: f.now }).initialize();
  assert.deepEqual((await codex.list()).policies, []);
  await codex.observe({ ...identity, sequence: 1, epoch: 0, phase: 'idle', sample: codexSample(f) });
  await codex.configure({ ...identity, provider: 'codex', bestEffort: true, enabled: true, requestId: 'shared-id', refreshMinutes: 20 });
  assert.equal(await readFile(claudePath, 'utf8'), original);
  f.tick(1199000);
  const { attempt } = await codex.claim({ ...identity, epoch: 0 });
  assert.equal((await codex.check({ ...identity, epoch: 0, attemptId: attempt.id })).ready, true);
  assert.equal((await f.check(attempt.id)).reason, 'attempt-identity-mismatch');
  const restarted = await new CacheWarmManager({ root: f.root, provider: 'codex', now: f.now }).initialize();
  const listing = await restarted.list();
  assert.equal(listing.policies[0].enabled, false);
  assert.equal(listing.policies[0].refreshMinutes, 20, 'Existing selected intervals are not migrated to the new default.');
  assert.equal(listing.attempts[0].state, 'uncertain');
  assert.equal(await readFile(claudePath, 'utf8'), original);
  // A misplaced provider journal must fail closed, never be interpreted as the other provider.
  await writeFile(join(f.root, 'codex-cache-warm.json'), original, { mode: 0o600 });
  await assert.rejects(new CacheWarmManager({ root: f.root, provider: 'codex' }).initialize(), /Invalid/);
});

test('Codex one-use attempts retain actual output accounting after opt-out', async t => {
  const f = await fixture(t, { provider: 'codex' });
  await f.observe({ sample: codexSample(f) }); await codexEnable(f, { maxOutputTokens: 128 }); f.tick(1499000);
  const { attempt } = await f.claim(); assert.equal((await f.check(attempt.id)).ready, true);
  assert.equal((await f.check(attempt.id)).ready, false);
  const off = await f.manager.configure({ ...identity, provider: 'codex', enabled: false });
  assert.equal(off.policy.bestEffort, true); assert.equal(off.policy.refreshMinutes, 25);
  f.tick(1000);
  await f.observe({ epoch: 1, attemptId: attempt.id,
    sample: { ...codexSample(f), cacheReadTokens: 6000, outputTokens: 300 } });
  const listing = await f.manager.list();
  assert.equal(listing.policies[0].enabled, false);
  assert.equal(listing.policies[0].totals.outputTokens, 300);
  assert.equal(listing.attempts[0].state, 'verified');
});

test('legacy Claude journals and request payloads remain replay-compatible without TTL preferences', async t => {
  const f = await fixture(t); await f.observe({ sample: f.sample() }); await f.enable({ requestId: 'legacy-request' });
  const path = join(f.root, 'cache-warm.json'), saved = JSON.parse(await readFile(path, 'utf8'));
  delete saved.policies[0].ttlPreference;
  assert.equal(JSON.parse(saved.requests[0].payload).ttl, undefined);
  await writeFile(path, JSON.stringify(saved), { mode: 0o600 });
  const restarted = await new CacheWarmManager({ root: f.root, now: f.now }).initialize();
  const replayed = await restarted.configure({ ...identity, provider: 'claude', enabled: true, requestId: 'legacy-request' });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.policy.generation, saved.policies[0].generation);
  assert.equal(replayed.policy.until, saved.policies[0].until);
});

test('Codex second-precision turn start accounts exact own samples without relaxing Claude timestamps', async t => {
  for (const provider of ['codex', 'claude']) {
    const f = await fixture(t, { provider });
    await f.observe({ sample: provider === 'codex' ? codexSample(f) : f.sample() });
    if (provider === 'codex') await codexEnable(f); else await f.enable();
    f.tick(provider === 'codex' ? 1499123 : 239123);
    const { attempt } = await f.claim(); await f.check(attempt.id); await f.receipt(attempt.id, 'submitted');
    const authorizedAt = f.now(), startedAt = Math.floor(authorizedAt / 1000) * 1000;
    assert.ok(startedAt < authorizedAt); f.tick(1000);
    await f.observe({ epoch: 1, attemptId: attempt.id, sample: {
      ...(provider === 'codex' ? codexSample(f) : f.sample()), startedAt, cacheReadTokens: 6000,
    } });
    const entry = (await f.manager.list()).attempts[0];
    assert.equal(entry.state, provider === 'codex' ? 'verified' : 'submitted');
    assert.equal(entry.actual?.cacheReadTokens, provider === 'codex' ? 6000 : undefined);
  }
});

test('Codex own samples earlier than the authorized second remain outside accounting', async t => {
  const f = await fixture(t, { provider: 'codex' });
  await f.observe({ sample: codexSample(f) }); await codexEnable(f); f.tick(1499123);
  const { attempt } = await f.claim(); await f.check(attempt.id); await f.receipt(attempt.id, 'submitted');
  const startedAt = Math.floor(f.now() / 1000) * 1000 - 1; f.tick(1000);
  await f.observe({ epoch: 1, attemptId: attempt.id, sample: { ...codexSample(f), startedAt, cacheReadTokens: 6000 } });
  const entry = (await f.manager.list()).attempts[0];
  assert.equal(entry.state, 'submitted'); assert.equal(entry.actual, undefined);
});

test('Codex distinct exact samples in one timestamp batch are charged once; time regressions and rewrites are refused', async t => {
  const f = await fixture(t, { provider: 'codex' });
  await f.observe({ sample: codexSample(f) }); await codexEnable(f); f.tick(1499000);
  const { attempt } = await f.claim(); await f.check(attempt.id); f.tick(1000);
  const first = { ...codexSample(f), id: 'exact-delta-one', cacheReadTokens: 6000, attemptId: attempt.id };
  const second = { ...first, id: 'exact-delta-two', cacheReadTokens: 6020 };
  await f.observe({ epoch: 1, phase: 'busy', sample: first });
  const next = await f.observe({ epoch: 1, phase: 'busy', sample: second });
  assert.equal(next.observed, true); assert.equal(next.policy.totals.readTokens, 12020);
  assert.equal(next.policy.totals.outputTokens, 8);
  await f.observe({ epoch: 1, phase: 'busy', sample: second });
  assert.equal((await f.manager.list()).attempts[0].responseIds.length, 2);
  assert.equal((await f.observe({ epoch: 1, sample: { ...second, outputTokens: 9 } })).reason, 'changed-sample');
  assert.equal((await f.observe({ epoch: 1, sample: { ...second, id: 'older-completion', completedAt: second.completedAt - 1 } })).reason, 'stale-sample');
  assert.equal((await f.observe({ epoch: 1, sample: { ...second, id: 'older-start', startedAt: second.startedAt - 1 } })).reason, 'stale-sample');

  const claude = await fixture(t); const original = claude.sample();
  await claude.observe({ sample: original });
  assert.equal((await claude.observe({ sample: { ...original, id: 'different-same-time' } })).reason, 'stale-sample');
});

test('Codex cache hits remain candidates until exact own idle finalizes every response', async t => {
  for (const lastOutcome of ['success', 'tool_use', 'ended']) {
    const f = await fixture(t, { provider: 'codex' });
    await f.observe({ sample: codexSample(f) }); await codexEnable(f); f.tick(1499000);
    const { attempt } = await f.claim(); await f.check(attempt.id); await f.receipt(attempt.id, 'submitted'); f.tick(1000);
    const first = { ...codexSample(f), id: 'first-request', cacheReadTokens: 6000, attemptId: attempt.id };
    await f.observe({ epoch: 1, phase: 'busy', sample: first });
    let entry = (await f.manager.list()).attempts[0];
    assert.equal(entry.state, 'submitted'); assert.equal(entry.cacheVerified, true);
    assert.equal(entry.reason, 'native-cache-hit-pending-completion');
    if (lastOutcome === 'ended') {
      // A later rejected sample or lost completion is handled by ending the
      // binding, preserving uncertainty rather than an early verified hit.
      await f.observe({ epoch: 1, phase: 'ended' });
      assert.equal((await f.manager.list()).attempts[0].state, 'uncertain');
      continue;
    }
    await f.observe({ epoch: 1, phase: 'busy', sample: { ...first, id: 'second-request',
      cacheReadTokens: 6020, stopReason: lastOutcome === 'tool_use' ? 'tool_use' : 'end_turn' } });
    entry = (await f.manager.list()).attempts[0];
    assert.equal(entry.state, lastOutcome === 'tool_use' ? 'failed' : 'submitted');
    assert.equal(entry.actual.cacheReadTokens, 12020);
    await f.observe({ epoch: 1, phase: 'idle', attemptId: attempt.id });
    entry = (await f.manager.list()).attempts[0];
    assert.equal(entry.state, lastOutcome === 'tool_use' ? 'failed' : 'verified');
    assert.equal(entry.responseIds.length, 2);
  }
});

test('a message of the user ends the schedule only when that is the chosen setting', async t => {
  for (const mode of ['continue', 'stop']) {
    let setting = mode;
    const f = await fixture(t, { onUserMessage: () => setting });
    // Enrollment before any reply: the first turn only supplies the evidence,
    // including its tool-use steps.
    await f.observe(); await f.enable();
    await f.observe({ phase: 'busy', epoch: 1 });
    f.tick(1000); await f.observe({ phase: 'busy', epoch: 1, sample: f.sample({ stopReason: 'tool_use' }) });
    f.tick(1000); const first = await f.observe({ epoch: 1, sample: f.sample() });
    assert.equal(first.policy.enabled, true);
    // A warm request of its own never counts as the user's message.
    f.tick(239000);
    const claimed = await f.claim({ epoch: 1 }); assert.equal(claimed.claimed, true);
    await f.check(claimed.attempt.id, { epoch: 1 });
    await f.observe({ phase: 'busy', epoch: 2, attemptId: claimed.attempt.id }); await f.receipt(claimed.attempt.id, 'submitted');
    f.tick(1000);
    const warmed = await f.observe({ epoch: 2, attemptId: claimed.attempt.id,
      sample: f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 0, attemptId: claimed.attempt.id }) });
    assert.equal(warmed.policy.enabled, true);
    // Starting a turn changes nothing by itself; its first response is the message.
    assert.equal((await f.observe({ phase: 'busy', epoch: 3 })).policy.enabled, true);
    f.tick(1000);
    const next = await f.observe({ epoch: 3, sample: f.sample({ cacheReadTokens: 6000 }) });
    assert.equal(next.policy.enabled, mode === 'continue');
    assert.equal(next.reason, mode === 'continue' ? 'scheduled' : 'user-message');
    if (mode === 'continue') {
      assert.ok(next.nextAt > f.now());
      // The setting is read when the message arrives, so it applies to a running schedule.
      setting = 'stop'; f.tick(1000); await f.observe({ phase: 'busy', epoch: 4 });
      const later = await f.observe({ epoch: 4, sample: f.sample({ cacheReadTokens: 6000 }) });
      assert.equal(later.reason, 'user-message');
    } else assert.equal((await f.claim({ epoch: 3 })).claimed, false);
  }
});

test('the reply to a message of the user starts the whole limit over, unless the limit has run out', async t => {
  const warm = async (f, epoch) => {
    const claimed = await f.claim({ epoch }); assert.equal(claimed.claimed, true, claimed.reason);
    await f.check(claimed.attempt.id, { epoch });
    await f.observe({ phase: 'busy', epoch: epoch + 1, attemptId: claimed.attempt.id }); await f.receipt(claimed.attempt.id, 'submitted');
    f.tick(1000);
    return f.observe({ epoch: epoch + 1, attemptId: claimed.attempt.id,
      sample: f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 0, attemptId: claimed.attempt.id }) });
  };
  for (const fixedEnd of [false, true]) {
    const f = await fixture(t);
    await f.observe({ sample: f.sample() });
    const enabled = await f.enable({ maxMinutes: 60, maxRefreshes: 2, ...(fixedEnd ? { fixedEnd: true } : {}) });
    const until = enabled.policy.until; assert.equal(until, f.now() + 3600000);
    f.tick(239000);
    assert.equal((await warm(f, 0)).policy.totals.refreshes, 1);
    // The tool steps of the user's turn restart nothing; its reply does.
    f.tick(60000); await f.observe({ phase: 'busy', epoch: 2 });
    f.tick(1000);
    const step = await f.observe({ phase: 'busy', epoch: 2, sample: f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 0, stopReason: 'tool_use' }) });
    assert.equal(step.policy.until, until); assert.equal(step.policy.totals.refreshes, 1);
    f.tick(1000);
    const reply = await f.observe({ epoch: 2, sample: f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 0 }) });
    assert.equal(reply.policy.enabled, true); assert.equal(reply.reason, 'scheduled');
    assert.equal(reply.policy.totals.refreshes, 0); assert.equal(reply.policy.restartedAt, f.now());
    // A duration is counted again from the reply; a clock time stays.
    assert.equal(reply.policy.until, fixedEnd ? until : f.now() + 3600000);
    // The restart is durable and a valid journal.
    const saved = JSON.parse(await readFile(join(f.root, 'cache-warm.json'), 'utf8'));
    assert.equal(saved.policies[0].restartedAt, f.now()); assert.equal(saved.policies[0].fixedEnd, fixedEnd ? true : undefined);
    await new CacheWarmManager({ root: f.root, now: f.now }).initialize();
    // Both requests of the new count are available again.
    f.tick(239000); assert.equal((await warm(f, 2)).policy.totals.refreshes, 1);
    f.tick(239000);
    const used = await warm(f, 3);
    assert.equal(used.policy.totals.refreshes, 2); assert.equal(used.reason, 'refresh-limit');
    // A schedule that used up its requests has ended: a message does not revive it.
    f.tick(60000); await f.observe({ phase: 'busy', epoch: 5 }); f.tick(1000);
    const late = await f.observe({ epoch: 5, sample: f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 0 }) });
    assert.equal(late.reason, 'refresh-limit'); assert.equal(late.policy.totals.refreshes, 2);
    assert.equal(late.policy.until, used.policy.until);
    // A new enrollment clears the restart mark and the fixed end.
    const again = await f.enable({ maxMinutes: 30 });
    assert.equal(again.policy.restartedAt, undefined); assert.equal(again.policy.fixedEnd, undefined);
    // Out of time: nothing is extended.
    f.tick(1800000); await f.observe({ phase: 'busy', epoch: 6 }); f.tick(1000);
    const expired = await f.observe({ epoch: 6, sample: f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 0 }) });
    assert.equal(expired.reason, 'duration-limit'); assert.equal(expired.policy.until, again.policy.until);
  }
  await assert.rejects((async () => { const f = await fixture(t); await f.observe(); return f.enable({ fixedEnd: false }); })());
});

test('a schedule that reached its limit compacts once before its last cache window ends', async t => {
  const warm = async (f, epoch) => {
    const claimed = await f.claim({ epoch }); assert.equal(claimed.claimed, true, claimed.reason);
    await f.check(claimed.attempt.id, { epoch });
    await f.observe({ phase: 'busy', epoch: epoch + 1, attemptId: claimed.attempt.id }); await f.receipt(claimed.attempt.id, 'submitted');
    f.tick(1000);
    return f.observe({ epoch: epoch + 1, attemptId: claimed.attempt.id,
      sample: f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 0, attemptId: claimed.attempt.id }) });
  };
  const ended = async (options = {}, enable = {}) => {
    const f = await fixture(t, options);
    await f.observe({ sample: f.sample() }); await f.enable({ maxMinutes: 60, maxRefreshes: 1, ...enable });
    f.tick(239000);
    return { f, last: await warm(f, 0) };
  };
  {
    const { f, last } = await ended();
    // The last request's five-minute window started one second before its reply.
    const due = f.now() - 1000 + 240000;
    assert.equal(last.reason, 'refresh-limit'); assert.equal(last.nextAt, null);
    assert.equal(last.compactAt, due); assert.equal(last.policy.compactAtEnd, true); assert.equal(last.policy.compact, undefined);
    // Not before it is due, and an ordinary claim never becomes a compaction.
    assert.deepEqual(await f.claim({ epoch: 1, kind: 'compact' }), { claimed: false, reason: 'not-due' });
    f.tick(239000);
    const refused = await f.claim({ epoch: 1 });
    assert.equal(refused.claimed, false); assert.equal(refused.reason, 'refresh-limit'); assert.equal(refused.compactAt, due);
    const claimed = await f.claim({ epoch: 1, kind: 'compact' });
    assert.equal(claimed.claimed, true); assert.equal(claimed.attempt.kind, 'compact'); assert.equal(claimed.attempt.prompt, undefined);
    assert.equal(claimed.attempt.expiresAt, due + 60000);
    assert.equal((await f.claim({ epoch: 1, kind: 'compact' })).claimed, false);
    assert.equal((await f.check(claimed.attempt.id, { epoch: 1 })).ready, true);
    // A warm receipt cannot settle a compaction, nor the reverse.
    await assert.rejects(f.receipt(claimed.attempt.id, 'submitted'), /does not match/);
    const done = await f.receipt(claimed.attempt.id, 'compacted');
    assert.equal(done.state, 'verified'); assert.equal(done.reason, 'native-compacted');
    const policy = (await f.manager.list()).policies[0];
    assert.equal(policy.enabled, false); assert.equal(policy.reason, 'compacted'); assert.equal(policy.compactAt, null);
    // It is not a warm request, and the journal with it is valid.
    assert.equal(policy.totals.refreshes, 1);
    await new CacheWarmManager({ root: f.root, now: f.now }).initialize();
    assert.equal((await f.claim({ epoch: 1, kind: 'compact' })).reason, 'compact-unavailable');
  }
  // A skipped or uncertain compaction also ends the schedule and is never repeated.
  for (const [outcome, reason] of [['rejected', 'compact-skipped'], ['uncertain', 'native-uncertain']]) {
    const { f } = await ended(); f.tick(239000);
    const claimed = await f.claim({ epoch: 1, kind: 'compact' }); await f.check(claimed.attempt.id, { epoch: 1 });
    assert.equal((await f.receipt(claimed.attempt.id, outcome)).state, outcome);
    const policy = (await f.manager.list()).policies[0];
    assert.equal(policy.enabled, false); assert.equal(policy.reason, reason);
    assert.equal((await f.claim({ epoch: 1, kind: 'compact' })).claimed, false);
  }
  {
    // Never from an expired cache: the summary would be a full-price read.
    const { f } = await ended(); f.tick(300000);
    assert.equal((await f.claim({ epoch: 1, kind: 'compact' })).reason, 'compact-unavailable');
    assert.equal((await f.manager.list()).policies[0].compactAt, null);
  }
  {
    // The shared setting is read when the limit ends; the session's own choice wins over it.
    let setting = false;
    const { f, last } = await ended({ compactAfterWarm: () => setting });
    assert.equal(last.compactAt, null); assert.equal(last.policy.compactAtEnd, false);
    setting = true; assert.ok((await f.manager.list()).policies[0].compactAt);
    const off = await ended({ compactAfterWarm: () => true }, { compact: false });
    assert.equal(off.last.compactAt, null); assert.equal(off.last.policy.compact, false);
    off.f.tick(239000); assert.equal((await off.f.claim({ epoch: 1, kind: 'compact' })).claimed, false);
    const on = await ended({ compactAfterWarm: () => false }, { compact: true });
    assert.ok(on.last.compactAt); assert.equal(on.last.policy.compactAtEnd, true);
    // A new enrollment without the word follows the shared setting again.
    assert.equal((await on.f.enable({ requestId: 'again' })).policy.compact, undefined);
    await assert.rejects(on.f.enable({ requestId: 'bad', compact: 'on' }), /on or off/);
  }
  {
    // A message of the user after the limit ran out cancels the compaction.
    const { f } = await ended();
    f.tick(60000); await f.observe({ phase: 'busy', epoch: 2 }); f.tick(1000);
    const late = await f.observe({ epoch: 2, sample: f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 0 }) });
    assert.equal(late.policy.enabled, false); assert.equal(late.reason, 'refresh-limit'); assert.equal(late.compactAt, null);
    f.tick(239000); assert.equal((await f.claim({ epoch: 2, kind: 'compact' })).claimed, false);
  }
  {
    // A time limit the next request would overrun ends with the compaction too, after its end time.
    const f = await fixture(t);
    await f.observe({ sample: f.sample() }); await f.enable({ maxMinutes: 5, maxRefreshes: 3 });
    f.tick(239000); const last = await warm(f, 0);
    assert.equal(last.reason, 'scheduled'); assert.equal(last.compactAt, last.nextAt); assert.ok(last.compactAt > last.policy.until);
    f.tick(239000);
    assert.equal((await f.claim({ epoch: 1 })).reason, 'duration-limit');
    const claimed = await f.claim({ epoch: 1, kind: 'compact' }); assert.equal(claimed.claimed, true);
    assert.equal((await f.check(claimed.attempt.id, { epoch: 1 })).ready, true);
    // Native activity before the call revokes the reservation instead.
    const other = await ended(); other.f.tick(239000);
    const reserved = await other.f.claim({ epoch: 1, kind: 'compact' });
    await other.f.observe({ phase: 'busy', epoch: 2 });
    assert.deepEqual(await other.f.check(reserved.attempt.id, { epoch: 1 }), { ready: false, reason: 'attempt-already-consumed' });
  }
});
