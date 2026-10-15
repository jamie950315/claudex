import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexCacheWarmer } from '../src/codex-cache-warm.mjs';

const ID = '11111111-1111-4111-8111-111111111111', OWNER = '22222222-2222-4222-8222-222222222222';
const initial = { totalTokens: 1004, inputTokens: 1000, cachedInputTokens: 900, cacheWriteInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0 };
const next = { ...initial, totalTokens: 1204, inputTokens: 1200, cachedInputTokens: 1100 };
const warm = { ...initial, totalTokens: 1306, inputTokens: 1300, cachedInputTokens: 1200, outputTokens: 6, reasoningOutputTokens: 2 };
const add = (a, b) => Object.fromEntries(Object.keys(a).map(key => [key, a[key] + b[key]]));
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-warm-'))); await chmod(root, 0o700);
  let now = 1000000, listener, connected = false, stopped = false, calls = 0, dispatches = 0, hook, preflightHook, stopHook, settingsReady = true, acceptsUnreported = false;
  let total = initial, compactions = 0, expecting = false, compactHook;
  const state = { sessionId: ID, cwd: '/fixture', model: 'fixture-model', effort: 'medium',
    fingerprint: 'fixture-fingerprint', ownerClientId: OWNER, phase: 'busy', nativeVersion: '0.160.0' };
  const timers = [], listeners = [];
  const native = {
    async inspect() { calls++; return { ...state }; },
    async connect(_params, onEvent) {
      calls++; connected = true; listener = onEvent;
      listeners.push(onEvent);
      return { state: { ...state }, initialTurn: { id: 'seed', startedAt: now, status: state.phase === 'idle' ? 'completed' : 'inProgress' },
        get dispatchReady() { return true; },
        get settingsReady() { return settingsReady; },
        acceptUnreportedSettings() { if (acceptsUnreported) settingsReady = true; },
        listen() {}, async close() { connected = false; },
        expectCompaction() { expecting = true; },
        async inspect() { return { ...state }; },
        async preflight() {
          await preflightHook?.();
          return { status: 'ready', ownerClientId: OWNER, close() {},
            async dispatch(args) { await args.beforeDispatch(); dispatches++; return hook ? hook(args) : { status: 'accepted', turnId: 'warm' }; },
            async compact(args) { await args.beforeDispatch(); compactions++; return compactHook ? compactHook() : { status: 'accepted' }; } };
        } };
    },
  };
  const service = await new CodexCacheWarmer({ root, native, now: () => now, stopped: async () => stopHook ? stopHook() : stopped,
    after(ms, callback) { const timer = { due: now + ms, callback, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(timer); return timer; },
  }).initialize();
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  async function emit(e) { listener(e); await service.serial; }
  async function usage(turnId, u) { total = add(total, u); await emit({ type: 'usage', turnId, tokenUsage: { total, last: u }, at: ++now }); }
  async function seed() {
    await emit({ type: 'usage', turnId: 'seed', tokenUsage: { total, last: initial }, at: ++now });
    await usage('seed', next); state.phase = 'idle';
    await emit({ type: 'complete', turnId: 'seed', status: 'completed', completedAt: now });
  }
  async function enable(more = {}) {
    const preview = await service.prepare({ sessionId: ID, cwd: '/fixture', bestEffort: true, maxRefreshes: 1, ...more }, 'controller');
    return service.confirm({ confirmationId: preview.confirmationId, bestEffort: true }, 'controller');
  }
  async function fire(delay = 0) {
    const timer = timers.filter(t => !t.cancelled).sort((a, b) => a.due - b.due)[0];
    if (!timer) return;
    timer.cancelled = true; now = timer.due + delay; timer.callback(); await service.serial;
  }
  return { service, root, state, timers, listeners, emit, usage, seed, enable, fire, tick(ms) { now += ms; },
    get compactions() { return compactions; }, get expecting() { return expecting; }, set compactHook(value) { compactHook = value; },
    get now() { return now; }, get connected() { return connected; }, get calls() { return calls; }, get dispatches() { return dispatches; },
    set hook(value) { hook = value; }, set preflightHook(value) { preflightHook = value; }, set stopped(value) { stopped = value; },
    set stopHook(value) { stopHook = value; }, set settingsReady(value) { settingsReady = value; }, set acceptsUnreported(value) { acceptsUnreported = value; } };
}

test('Codex status is default-off and confirmation requires exact actor and explicit risk consent', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.list()).policies.length, 0); assert.equal(f.calls, 0);
  await assert.rejects(f.service.prepare({ sessionId: ID, cwd: '/fixture' }, 'controller'), /consent/);
  const preview = await f.service.prepare({ sessionId: ID, cwd: '/fixture', bestEffort: true }, 'controller');
  assert.equal(preview.inferenceStarted, false); assert.equal(f.connected, false);
  assert.equal(preview.refreshMinutes, 25);
  assert.equal(preview.maxReadTokens, null);
  await assert.rejects(f.service.confirm({ confirmationId: preview.confirmationId, bestEffort: true }, 'other'), /controller/);
  await assert.rejects(f.service.confirm({ confirmationId: preview.confirmationId }, 'controller'), /consent/);
  assert.equal(f.dispatches, 0);
});

test('Codex accepts legacy read bounds without applying them and retains actual usage', async t => {
  const f = await fixture(t);
  for (const maxReadTokens of [0, -1, 100000001, '250000', NaN])
    await assert.rejects(f.service.prepare({ sessionId: ID, cwd: '/fixture', bestEffort: true, maxReadTokens }, 'controller'), /maxReadTokens/);
  const enabled = await f.enable({ maxReadTokens: 1, maxRefreshes: 3 });
  assert.equal(enabled.policy.maxReadTokens, null);
  await f.seed();
  await f.emit({ type: 'start', turnId: 'large-prefix', startedAt: f.now });
  const large = { ...warm, totalTokens: 310006, inputTokens: 310000, cachedInputTokens: 300000 };
  await f.usage('large-prefix', large);
  await f.emit({ type: 'complete', turnId: 'large-prefix', status: 'completed', completedAt: f.now });
  await f.fire(); assert.equal(f.dispatches, 1);
  await f.emit({ type: 'start', turnId: 'warm', startedAt: f.now });
  await f.usage('warm', large);
  await f.usage('warm', large);
  await f.emit({ type: 'complete', turnId: 'warm', status: 'completed', completedAt: f.now });
  const status = await f.service.list();
  assert.equal(status.policies[0].enabled, true);
  assert.equal(status.policies[0].maxReadTokens, null);
  assert.equal(status.policies[0].totals.readTokens, 600000);
  assert.equal(status.policies[0].totals.outputTokens, 12);
  assert.ok(status.policies[0].nextAt > f.now);
});

test('Codex timer dispatches once to the owner and verifies only completed native cache evidence', async t => {
  const f = await fixture(t); await f.enable({ compact: false }); await f.seed();
  const scheduled = (await f.service.list()).policies[0];
  assert.equal(scheduled.refreshMinutes, 25);
  assert.equal(scheduled.nextAt, scheduled.sample.startedAt + 25 * 60000);
  await f.fire(); assert.equal(f.dispatches, 1);
  let status = await f.service.list(); assert.equal(status.attempts[0].state, 'submitted');
  await f.emit({ type: 'start', turnId: 'warm', startedAt: f.now });
  await f.usage('warm', warm);
  assert.equal((await f.service.list()).attempts[0].state, 'submitted');
  await f.emit({ type: 'complete', turnId: 'warm', status: 'completed', completedAt: f.now });
  status = await f.service.list();
  assert.equal(status.attempts[0].state, 'verified');
  assert.equal(status.policies[0].totals.readTokens, 1200);
  assert.equal(status.policies[0].totals.outputTokens, 6, 'Reasoning is already included in native output.');
  assert.equal(status.policies[0].nativeReason, 'refresh-limit');
  assert.equal(f.connected, false); await f.fire(); assert.equal(f.dispatches, 1);
});

test('a baseline-only enrollment turn autonomously primes without another user message', async t => {
  const f = await fixture(t); await f.enable();
  await f.emit({ type: 'usage', turnId: 'seed', tokenUsage: { total: initial, last: initial }, at: f.now });
  f.state.phase = 'idle';
  await f.emit({ type: 'complete', turnId: 'seed', status: 'completed', completedAt: f.now });
  assert.equal(f.connected, true); assert.equal((await f.service.list()).policies[0].sample, null);
  assert.equal((await f.service.list()).policies[0].nextAt, f.now);
  await f.fire(); assert.equal(f.dispatches, 1);
  assert.equal((await f.service.list()).attempts[0].kind, 'prime');
  await f.emit({ type: 'start', turnId: 'warm', startedAt: f.now });
  await f.usage('warm', next);
  await f.emit({ type: 'complete', turnId: 'warm', status: 'completed', completedAt: f.now });
  assert.equal((await f.service.list()).attempts[0].reason, 'native-cache-primed');
});

test('an idle enrollment primes from its own first native response with no ordinary message or sample', async t => {
  const f = await fixture(t); f.state.phase = 'idle'; f.settingsReady = false; f.acceptsUnreported = true;
  const enabled = await f.enable({ maxRefreshes: 2 });
  assert.equal(enabled.awaitingFreshUsage, false); assert.equal(enabled.policy.sample, null);
  assert.equal(enabled.nextAt, f.now);
  await f.fire(); assert.equal(f.dispatches, 1);
  await f.emit({ type: 'start', turnId: 'warm', startedAt: f.now });
  await f.usage('warm', next);
  await f.emit({ type: 'complete', turnId: 'warm', status: 'completed', completedAt: f.now });
  const result = await f.service.list();
  assert.equal(result.attempts[0].reason, 'native-cache-primed');
  assert.equal(result.policies[0].totals.readTokens, next.cachedInputTokens);
  assert.equal(result.policies[0].totals.outputTokens, next.outputTokens);
  assert.ok((await f.service.list()).policies[0].nextAt > f.now);
  await f.fire(); assert.equal(f.dispatches, 2);
});

test('the first autonomous prime keeps uncertain delivery and missing-start accounting unreplayable', async t => {
  for (const failure of ['uncertain', 'missing-start', 'timeout']) {
    const f = await fixture(t); f.state.phase = 'idle';
    await f.enable({ maxRefreshes: 2 });
    if (failure === 'uncertain') f.hook = async () => ({ status: 'uncertain' });
    await f.fire(); assert.equal(f.dispatches, 1);
    if (failure === 'missing-start') {
      await f.usage('warm', next);
      await f.emit({ type: 'complete', turnId: 'warm', status: 'completed', completedAt: f.now });
    }
    if (failure === 'timeout') await f.fire();
    const result = await f.service.list();
    assert.equal(result.attempts[0].state, 'uncertain');
    assert.equal(result.attempts[0].actual, undefined);
    await f.fire(); assert.equal(f.dispatches, 1);
  }
});

test('cold first requests and later cache misses keep warming without fabricated cache accounting', async t => {
  const f = await fixture(t); f.state.phase = 'idle';
  await f.enable({ maxRefreshes: 3 }); await f.fire();
  const cold = { ...next, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
  await f.emit({ type: 'start', turnId: 'warm', startedAt: f.now });
  await f.usage('warm', cold);
  await f.emit({ type: 'complete', turnId: 'warm', status: 'completed', completedAt: f.now });
  let result = await f.service.list();
  assert.equal(result.attempts[0].reason, 'native-cache-primed');
  assert.equal(result.policies[0].enabled, true); assert.equal(result.policies[0].totals.readTokens, 0);
  assert.equal(result.policies[0].sample.cacheReadTokens, 0); assert.equal(result.policies[0].sample.cacheWriteTokens, 0);
  assert.equal(result.policies[0].nextAt, result.policies[0].sample.startedAt + 25 * 60000);
  await f.fire(); assert.equal(f.dispatches, 2);
  await f.emit({ type: 'start', turnId: 'warm', startedAt: f.now });
  await f.usage('warm', cold);
  await f.emit({ type: 'complete', turnId: 'warm', status: 'completed', completedAt: f.now });
  result = await f.service.list();
  assert.equal(result.attempts[1].reason, 'native-cache-refreshed');
  assert.equal(result.attempts[1].cacheVerified, false);
  assert.equal(result.policies[0].enabled, true); assert.equal(result.policies[0].totals.readTokens, 0);
  await f.fire(); assert.equal(f.dispatches, 3);
});

test('a command-only enrollment turn schedules its own prime without native prompt settings', async t => {
  const f = await fixture(t); f.settingsReady = false; f.acceptsUnreported = true;
  await f.enable(); f.state.phase = 'idle';
  await f.emit({ type: 'complete', turnId: 'seed', status: 'completed', completedAt: f.now });
  const p = (await f.service.list()).policies[0];
  assert.equal(p.sample, null); assert.equal(p.nextAt, f.now);
  await f.fire(); assert.equal(f.dispatches, 1);
});

test('native request evidence schedules normally without a prompt-settings snapshot prerequisite', async t => {
  const f = await fixture(t); f.settingsReady = false;
  await f.enable(); await f.seed();
  const p = (await f.service.list()).policies[0];
  assert.equal(p.enabled, true); assert.ok(p.nextAt > f.now);
  await f.fire(); assert.equal(f.dispatches, 1);
});

test('busy state, changed configuration and app-stop suppress native warming', async t => {
  for (const change of ['busy', 'config', 'stop']) {
    const f = await fixture(t); await f.enable(); await f.seed();
    if (change === 'busy') f.state.phase = 'busy';
    if (change === 'config') f.state.fingerprint = 'changed';
    if (change === 'stop') f.stopped = true;
    await f.fire(); assert.equal(f.dispatches, 0); assert.equal(f.connected, false);
  }
});

test('off revokes a warm request during awaited preflight before native submission', async t => {
  const f = await fixture(t); await f.enable(); await f.seed();
  let entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  f.preflightHook = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const firing = f.fire(); await enteredPromise;
  const off = f.service.off({ sessionId: ID, cwd: '/fixture' }); release();
  await Promise.all([firing, off]);
  assert.equal(f.dispatches, 0); assert.equal((await f.service.list()).policies[0].enabled, false);
});

test('tool activity stops later warming but preserves usage from the dispatched turn', async t => {
  const f = await fixture(t); await f.enable(); await f.seed(); await f.fire();
  await f.emit({ type: 'start', turnId: 'warm', startedAt: f.now });
  await f.emit({ type: 'tool', turnId: 'warm', itemType: 'commandExecution' });
  await f.usage('warm', warm);
  await f.emit({ type: 'complete', turnId: 'warm', status: 'completed', completedAt: f.now });
  const result = await f.service.list();
  assert.equal(result.attempts[0].state, 'failed'); assert.equal(result.policies[0].totals.outputTokens, 6);
  assert.equal(f.dispatches, 1); assert.equal(f.connected, false);
});

test('off during the final awaited app-stop read cannot pass the native dispatch fence', async t => {
  const f = await fixture(t); await f.enable(); await f.seed();
  let entered, release, calls = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.preflightHook = async () => {
    f.stopHook = async () => {
      if (++calls === 2) { entered(); return new Promise(resolve => { release = () => resolve(false); }); }
      return false;
    };
  };
  const firing = f.fire(); await waiting;
  const off = f.service.off({ sessionId: ID, cwd: '/fixture' }); release();
  await Promise.all([firing, off]); assert.equal(f.dispatches, 0);
});

test('Codex second-precision starts and same-millisecond usage retain every completed request', async t => {
  const f = await fixture(t); await f.enable(); await f.seed(); await f.fire(123);
  await f.emit({ type: 'start', turnId: 'warm', startedAt: Math.floor(f.now / 1000) * 1000 });
  let total = add(add(initial, next), warm);
  await f.emit({ type: 'usage', turnId: 'warm', tokenUsage: { total, last: warm }, at: f.now });
  total = add(total, warm);
  await f.emit({ type: 'usage', turnId: 'warm', tokenUsage: { total, last: warm }, at: f.now });
  await f.emit({ type: 'complete', turnId: 'warm', status: 'completed', completedAt: f.now });
  const result = await f.service.list();
  assert.equal(result.attempts[0].state, 'verified'); assert.equal(result.attempts[0].responseIds.length, 2);
  assert.equal(result.policies[0].totals.readTokens, 2400); assert.equal(result.policies[0].totals.outputTokens, 12);
});

test('unknown delivery, missing completion and disconnect never replay a Codex turn', async t => {
  for (const outcome of ['uncertain', 'timeout', 'disconnect']) {
    const f = await fixture(t); await f.enable(); await f.seed();
    if (outcome === 'uncertain') f.hook = async () => ({ status: 'uncertain' });
    await f.fire();
    if (outcome === 'timeout') await f.fire();
    if (outcome === 'disconnect') await f.emit({ type: 'invalidated', reason: 'disconnected' });
    assert.equal((await f.service.list()).attempts[0].state, 'uncertain');
    await f.fire(); assert.equal(f.dispatches, 1);
  }
});

test('Codex retires more than 64 sessions and repeated bindings without reviving old callbacks', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 72; i++) {
    const sessionId = `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;
    await f.enable({ sessionId, maxMinutes: 1 });
    await f.service.off({ sessionId, cwd: '/fixture' });
    f.tick(60001);
  }
  for (let i = 0; i < 72; i++) {
    await f.enable();
    await f.service.off({ sessionId: ID, cwd: '/fixture' });
  }
  await f.enable();
  const before = await f.service.list();
  for (const old of f.listeners.slice(0, -1)) old({ type: 'invalidated', reason: 'stale-callback' });
  await f.service.serial;
  assert.deepEqual(await f.service.list(), before);
  assert.equal(f.service.bindings.size, 1);
  assert.equal(f.service.manager.bindings.size, 1);
  assert.equal(f.service.manager.retired.size, 64);
  assert.ok(f.service.nativeReasons.size <= 64);
  assert.equal(f.dispatches, 0);
});

test('an asynchronous provider failure visibly closes every policy and preserves unrelated pending uncertainty', async t => {
  const f = await fixture(t); await f.enable(); await f.seed(); await f.fire();
  assert.equal(f.dispatches, 1);
  await f.enable({ sessionId: OWNER });
  f.service.manager.configure = async () => { throw new Error('fixture disable failure'); };
  await f.emit({ type: 'invalidated', reason: 'fixture disconnect' });
  const status = await f.service.list();
  assert.equal(status.providerStatus.closed, true);
  assert.equal(status.providerStatus.reason, 'native-service-failed');
  assert.equal(status.providerStatus.code, 'CACHE_WARM_PROVIDER_FAILED');
  assert.equal(status.providerStatus.phase, 'native-events');
  assert.equal(status.providerStatus.cleanupFailed, false);
  assert.equal(status.policies.length, 2);
  assert.ok(status.policies.every(p => !p.enabled && p.nextAt === null && p.compactAt === null));
  assert.equal(status.attempts[0].state, 'uncertain');
  assert.equal(f.service.bindings.size, 0);
  for (const timer of f.timers) if (!timer.cancelled) timer.callback();
  await f.service.serial;
  assert.equal(f.dispatches, 1);
  await assert.rejects(f.enable(), /stopped/);
});

test('native events arriving inside dispatch are attributed after the exact returned turn ID', async t => {
  const f = await fixture(t); await f.enable(); await f.seed();
  f.hook = async () => {
    // Do not await the service queue while dispatch holds its authorization boundary.
    void f.emit({ type: 'start', turnId: 'warm', startedAt: f.now });
    return { status: 'accepted', turnId: 'warm' };
  };
  await f.fire(); await f.service.serial;
  await f.usage('warm', warm);
  await f.emit({ type: 'complete', turnId: 'warm', status: 'completed', completedAt: f.now });
  assert.equal((await f.service.list()).attempts[0].state, 'verified');
});

test('the reply to a Codex message of the user restarts the limit and its expiry timer', async t => {
  const f = await fixture(t); const enabled = await f.enable({ maxRefreshes: 2, maxMinutes: 60 }); await f.seed();
  const before = (await f.service.list()).policies[0];
  assert.equal(before.until, enabled.policy.until);
  f.state.phase = 'busy';
  await f.emit({ type: 'start', turnId: 'user', startedAt: f.now });
  await f.usage('user', next); f.state.phase = 'idle';
  await f.emit({ type: 'complete', turnId: 'user', status: 'completed', completedAt: f.now });
  const after = (await f.service.list()).policies[0];
  assert.equal(after.reason, 'scheduled'); assert.ok(after.until > before.until);
  assert.equal(after.until, after.restartedAt + 3600000);
  const live = f.timers.filter(timer => !timer.cancelled).map(timer => timer.due);
  assert.ok(live.includes(after.until)); assert.ok(!live.includes(before.until));
});

test('a Codex schedule that reached its limit asks the owner to compact once and follows its native turn', async t => {
  const warmed = async (more = {}) => {
    const f = await fixture(t); await f.enable(more); await f.seed();
    await f.fire(); assert.equal(f.dispatches, 1);
    await f.emit({ type: 'start', turnId: 'warm', startedAt: f.now });
    await f.usage('warm', warm);
    await f.emit({ type: 'complete', turnId: 'warm', status: 'completed', completedAt: f.now });
    return f;
  };
  const policy = async f => (await f.service.list()).policies[0];
  {
    const f = await warmed();
    const ended = await policy(f);
    // The observer stays connected for the compaction, 25 minutes after the warm request started.
    assert.equal(ended.reason, 'refresh-limit'); assert.equal(f.connected, true);
    assert.equal(ended.compactAt, ended.sample.startedAt + 25 * 60000); assert.equal(ended.compactAtEnd, true);
    // The limit's own end time does not end the schedule while the compaction is due.
    const expiry = f.timers.filter(timer => !timer.cancelled).sort((a, b) => a.due - b.due);
    assert.equal(expiry.at(-1).due, ended.until);
    await f.fire(); assert.equal(f.compactions, 1); assert.equal(f.dispatches, 1); assert.equal(f.expecting, true);
    let status = await f.service.list();
    assert.equal(status.attempts.at(-1).kind, 'compact'); assert.equal(status.attempts.at(-1).state, 'dispatching');
    // Acceptance is not completion: the native compaction turn must be seen whole.
    await f.emit({ type: 'start', turnId: 'compaction', startedAt: f.now });
    await f.emit({ type: 'usage', turnId: 'compaction', tokenUsage: { total: initial, last: initial }, at: f.now });
    await f.emit({ type: 'compacted' });
    assert.equal((await f.service.list()).attempts.at(-1).state, 'dispatching');
    await f.emit({ type: 'complete', turnId: 'compaction', status: 'completed', completedAt: f.now });
    status = await f.service.list();
    assert.equal(status.attempts.at(-1).state, 'verified'); assert.equal(status.attempts.at(-1).reason, 'native-compacted');
    assert.equal(status.policies[0].enabled, false); assert.equal(status.policies[0].reason, 'compacted');
    assert.equal(status.policies[0].totals.refreshes, 1);
    assert.equal(f.connected, false); await f.fire(); await f.fire(); assert.equal(f.compactions, 1);
  }
  // A turn that ends without the compaction, another failure or a lost answer is uncertain and never repeated.
  for (const events of [
    [{ type: 'start', turnId: 'c' }, { type: 'complete', turnId: 'c', status: 'completed' }],
    [{ type: 'start', turnId: 'c' }, { type: 'compacted' }, { type: 'complete', turnId: 'c', status: 'failed' }],
    [{ type: 'start', turnId: 'c' }, { type: 'invalidated', reason: 'disconnected' }]]) {
    const f = await warmed(); await f.fire();
    for (const e of events) await f.emit({ startedAt: f.now, completedAt: f.now, ...e });
    assert.equal((await policy(f)).reason, 'native-uncertain'); assert.equal(f.connected, false);
    assert.equal((await f.service.list()).attempts.at(-1).state, 'uncertain');
    await f.fire(); assert.equal(f.compactions, 1);
  }
  {
    const lost = await warmed(); lost.compactHook = () => ({ status: 'uncertain', reason: 'lost' }); await lost.fire();
    assert.equal((await policy(lost)).reason, 'native-uncertain'); assert.equal(lost.connected, false);
    const busy = await warmed(); busy.compactHook = () => ({ status: 'rejected', reason: 'busy' }); await busy.fire();
    assert.equal((await policy(busy)).reason, 'compact-skipped'); assert.equal(busy.connected, false);
    // No answer to an accepted request within ten minutes is uncertain too.
    // The limit's end time passes first and changes nothing while the compaction is awaited.
    const silent = await warmed(); await silent.fire(); await silent.fire();
    assert.equal((await policy(silent)).enabled, true); assert.equal(silent.connected, true);
    await silent.fire();
    assert.equal((await policy(silent)).reason, 'native-uncertain'); assert.equal(silent.connected, false);
  }
  {
    // Busy, changed or stopped at the compaction time: nothing is requested.
    const f = await warmed(); f.state.phase = 'busy'; await f.fire();
    assert.equal(f.compactions, 0); assert.equal(f.connected, false);
    // The session's own choice and the expired window.
    const off = await warmed({ compact: false });
    assert.equal(off.connected, false); assert.equal((await policy(off)).compactAtEnd, false);
    const late = await warmed(); await late.fire(6 * 60000);
    assert.equal(late.compactions, 0); assert.equal(late.connected, false);
  }
  await assert.rejects((async () => (await fixture(t)).service.prepare({ sessionId: ID, cwd: '/fixture', bestEffort: true, compact: 'on' }, 'controller'))(), /compact/);
});
