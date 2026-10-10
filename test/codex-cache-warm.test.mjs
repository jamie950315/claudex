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
  let total = initial;
  const state = { sessionId: ID, cwd: '/fixture', model: 'fixture-model', effort: 'medium',
    fingerprint: 'fixture-fingerprint', ownerClientId: OWNER, phase: 'busy', nativeVersion: '0.160.0' };
  const timers = [];
  const native = {
    async inspect() { calls++; return { ...state }; },
    async connect(_params, onEvent) {
      calls++; connected = true; listener = onEvent;
      return { state: { ...state }, initialTurn: { id: 'seed', startedAt: now, status: 'inProgress' },
        get settingsReady() { return settingsReady; },
        acceptUnreportedSettings() { if (acceptsUnreported) settingsReady = true; },
        listen() {}, async close() { connected = false; },
        async inspect() { return { ...state }; },
        async preflight() {
          await preflightHook?.();
          return { status: 'ready', ownerClientId: OWNER, close() {},
            async dispatch(args) { await args.beforeDispatch(); dispatches++; return hook ? hook(args) : { status: 'accepted', turnId: 'warm' }; } };
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
  return { service, root, state, timers, emit, usage, seed, enable, fire,
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
  const f = await fixture(t); await f.enable(); await f.seed();
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

test('a baseline-only first normal turn waits for fresh usage instead of fabricating a sample', async t => {
  const f = await fixture(t); await f.enable();
  await f.emit({ type: 'usage', turnId: 'seed', tokenUsage: { total: initial, last: initial }, at: f.now });
  await f.emit({ type: 'complete', turnId: 'seed', status: 'completed', completedAt: f.now });
  assert.equal(f.connected, true); assert.equal((await f.service.list()).policies[0].sample, null);
  await f.emit({ type: 'start', turnId: 'normal-next', startedAt: f.now });
  await f.usage('normal-next', next); f.state.phase = 'idle';
  await f.emit({ type: 'complete', turnId: 'normal-next', status: 'completed', completedAt: f.now });
  assert.ok((await f.service.list()).policies[0].nextAt > f.now);
});

test('a model turn seen from its start without a settings snapshot makes the rejoin baseline usable', async t => {
  const f = await fixture(t); f.settingsReady = false; f.acceptsUnreported = true;
  await f.enable(); await f.seed();
  // The enrollment turn was not observed from its start and proves nothing.
  let p = (await f.service.list()).policies[0];
  assert.equal(p.nextAt, null); assert.equal(p.nativeReason, 'awaiting-native-settings');
  // Nor does a turn without native usage, such as a prompt a hook blocked.
  await f.emit({ type: 'start', turnId: 'blocked', startedAt: f.now });
  await f.emit({ type: 'complete', turnId: 'blocked', status: 'completed', completedAt: f.now });
  assert.equal((await f.service.list()).policies[0].nativeReason, 'awaiting-native-settings');
  await f.emit({ type: 'start', turnId: 'unreported', startedAt: f.now });
  await f.usage('unreported', next);
  await f.emit({ type: 'complete', turnId: 'unreported', status: 'completed', completedAt: f.now });
  p = (await f.service.list()).policies[0]; assert.ok(p.nextAt > f.now);
  assert.equal(f.dispatches, 0);
});

test('mid-turn enrollment waits for a native settings snapshot instead of arming an unusable timer', async t => {
  const f = await fixture(t); f.settingsReady = false;
  await f.enable(); await f.seed();
  let p = (await f.service.list()).policies[0];
  assert.equal(p.enabled, true); assert.equal(p.nextAt, null); assert.equal(p.nativeReason, 'awaiting-native-settings');
  f.settingsReady = true;
  await f.emit({ type: 'start', turnId: 'settings-observed', startedAt: f.now });
  await f.usage('settings-observed', next);
  await f.emit({ type: 'complete', turnId: 'settings-observed', status: 'completed', completedAt: f.now });
  p = (await f.service.list()).policies[0]; assert.ok(p.nextAt > f.now);
  assert.equal(f.dispatches, 0);
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
