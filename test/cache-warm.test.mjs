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
  assert.equal(configured.reason, 'awaiting-evidence'); assert.equal(configured.policy.native.phase, 'idle');
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
  f.tick(1000);
  const result = await f.observe({ epoch: 1, attemptId: id, sample: f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 80, attemptId: id }) });
  assert.equal(result.policy.enabled, true); assert.ok(result.nextAt > f.now());
  list = await f.manager.list();
  assert.equal(list.attempts[0].state, 'verified');
  assert.equal(list.attempts[0].reservedReadTokens, 6256);
  assert.equal(list.policies[0].totals.readTokens, 6000);
  assert.equal(list.policies[0].totals.outputTokens, 4);
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

test('fresh but partial cache hit, native max_tokens, or model change cannot certify warming', async t => {
  for (const change of [{ cacheReadTokens: 5999 }, { stopReason: 'max_tokens' }, { model: 'different-model' }]) {
    const f = await fixture(t); await f.seed();
    const { attempt } = await f.claim(); await f.check(attempt.id);
    f.tick(1000);
    const result = await f.observe({ epoch: 1, attemptId: attempt.id,
      sample: f.sample({ cacheReadTokens: 6000, cacheWriteTokens: 80, ...change }) });
    assert.equal(result.policy.enabled, false);
    assert.equal((await f.manager.list()).attempts[0].state, 'failed');
  }
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

test('bounded ledgers preserve history and refuse new allocation', async t => {
  const f = await fixture(t); await f.seed();
  const { attempt } = await f.claim();
  await f.receipt(attempt.id, 'rejected');
  const path = join(f.root, 'cache-warm.json'), state = JSON.parse(await readFile(path, 'utf8'));
  state.attempts = Array.from({ length: 2048 }, (_, i) => ({ ...state.attempts[0], id: `attempt-${i}` }));
  // Old generations occupy durable capacity but cannot spend a new opt-in budget.
  state.policies[0].generation = 2;
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  const m = await new CacheWarmManager({ root: f.root, now: f.now }).initialize();
  await m.observe({ ...identity, sequence: 1, epoch: 0, phase: 'idle', sample: f.sample() });
  await m.configure({ ...identity, provider: 'claude', enabled: true, requestId: 'new-capacity-test' });
  f.tick(239000);
  await assert.rejects(m.claim({ ...identity, epoch: 0 }), { code: 'CACHE_WARM_CAPACITY' });
  const listing = await m.list();
  assert.equal(listing.attemptCount, 2048); assert.equal(listing.attempts.length, 64); assert.equal(listing.attemptsTruncated, true);
});

test('duration and admission read/output budgets prevent a native authorization', async t => {
  for (const [bounds, reason] of [
    [{ maxMinutes: 1 }, 'duration-limit'], [{ maxReadTokens: 6000 }, 'read-budget'], [{ maxOutputTokens: 127 }, 'output-budget'],
  ]) {
    const f = await fixture(t); await f.observe({ sample: f.sample() }); await f.enable(bounds); f.tick(239000);
    assert.equal((await f.claim()).reason, reason);
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

const codexSample = f => f.sample({ model: 'codex-fixture', ttlMs: 1800000, ttlSource: 'configured-window' });
const codexEnable = (f, more = {}) => f.enable({ provider: 'codex', bestEffort: true, ...more });

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
  assert.equal(enabled.policy.bestEffort, true); assert.equal(enabled.policy.refreshMinutes, 20);
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
  await codex.configure({ ...identity, provider: 'codex', bestEffort: true, enabled: true, requestId: 'shared-id' });
  assert.equal(await readFile(claudePath, 'utf8'), original);
  f.tick(1199000);
  const { attempt } = await codex.claim({ ...identity, epoch: 0 });
  assert.equal((await codex.check({ ...identity, epoch: 0, attemptId: attempt.id })).ready, true);
  assert.equal((await f.check(attempt.id)).reason, 'attempt-identity-mismatch');
  const restarted = await new CacheWarmManager({ root: f.root, provider: 'codex', now: f.now }).initialize();
  const listing = await restarted.list();
  assert.equal(listing.policies[0].enabled, false);
  assert.equal(listing.attempts[0].state, 'uncertain');
  assert.equal(await readFile(claudePath, 'utf8'), original);
  // A misplaced provider journal must fail closed, never be interpreted as the other provider.
  await writeFile(join(f.root, 'codex-cache-warm.json'), original, { mode: 0o600 });
  await assert.rejects(new CacheWarmManager({ root: f.root, provider: 'codex' }).initialize(), /Invalid/);
});

test('Codex one-use attempts retain actual output accounting after opt-out', async t => {
  const f = await fixture(t, { provider: 'codex' });
  await f.observe({ sample: codexSample(f) }); await codexEnable(f, { maxOutputTokens: 128 }); f.tick(1199000);
  const { attempt } = await f.claim(); assert.equal((await f.check(attempt.id)).ready, true);
  assert.equal((await f.check(attempt.id)).ready, false);
  const off = await f.manager.configure({ ...identity, provider: 'codex', enabled: false });
  assert.equal(off.policy.bestEffort, true); assert.equal(off.policy.refreshMinutes, 20);
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
    f.tick(provider === 'codex' ? 1199123 : 239123);
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
  await f.observe({ sample: codexSample(f) }); await codexEnable(f); f.tick(1199123);
  const { attempt } = await f.claim(); await f.check(attempt.id); await f.receipt(attempt.id, 'submitted');
  const startedAt = Math.floor(f.now() / 1000) * 1000 - 1; f.tick(1000);
  await f.observe({ epoch: 1, attemptId: attempt.id, sample: { ...codexSample(f), startedAt, cacheReadTokens: 6000 } });
  const entry = (await f.manager.list()).attempts[0];
  assert.equal(entry.state, 'submitted'); assert.equal(entry.actual, undefined);
});

test('Codex distinct exact samples in one timestamp batch are charged once; time regressions and rewrites are refused', async t => {
  const f = await fixture(t, { provider: 'codex' });
  await f.observe({ sample: codexSample(f) }); await codexEnable(f); f.tick(1199000);
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
    await f.observe({ sample: codexSample(f) }); await codexEnable(f); f.tick(1199000);
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
