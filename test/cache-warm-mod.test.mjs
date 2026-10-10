import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheWarmManager } from '../src/cache-warm.mjs';
import { createCacheWarmClient, cacheWarmTtl, parseCacheWarmBounds, isCacheWarmTurnText, assertNativeCacheTtlChange, cacheTtlPreference, defaultWarmLimit } from '../plugins/claudex/hooks/cache-warm.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const PROMPT = 'Cache-retention measurement only. Reply with exactly OK. Do not call tools.';
const usage = { model: 'claude-sonnet-5-5', input_tokens: 2, cache_read_input_tokens: 6000, cache_creation_input_tokens: 20, output_tokens: 4 };
async function fixture() {
  let now = 1000, context = { sessionId: ID, cwd: '/fixture' }, fingerprint = 'sonnet-medium-5m';
  let draft = '', worker = false, enabled = false, sequence = 0, submits = 0, nativeTtl = '1h', preference, warmLimit;
  const lastChoices = new Map();
  const timers = [], calls = [], client = createCacheWarmClient();
  const hooks = {};
  const host = {
    pluginName: 'claudex', worker: async () => worker, context: async () => ({ ...context }), now: async () => now,
    cacheConfiguration: async preference => ({ fingerprint, ttl: cacheWarmTtl({ setting: nativeTtl, preference }) }),
    readCacheTtl: async () => ({ value: nativeTtl, environmentValue: nativeTtl, scope: 'current-process', force5m: false, policyLocked: false }),
    readTtlPreference: async () => preference,
    writeTtlPreference: async value => { preference = structuredClone(value); },
    readWarmLimit: async () => warmLimit,
    writeWarmLimit: async value => { warmLimit = structuredClone(value); },
    readLastTtlChoice: async revision => lastChoices.get(revision),
    writeLastTtlChoice: async value => { lastChoices.set(value.revision, structuredClone(value)); },
    checkCacheTtl: async desired => { const state = await host.readCacheTtl(); assertNativeCacheTtlChange(state, desired); return state; },
    applyCacheTtl: async (desired, expected, beforeWrite) => {
      await beforeWrite();
      assert.equal(nativeTtl, expected); const changed = nativeTtl !== desired; nativeTtl = desired;
      return { value: desired, scope: 'current-process', changed };
    },
    readPrompt: async () => ({ text: draft, cursor: draft.length }),
    after(ms, callback) { const timer = { due: now + ms, callback, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(timer); return timer; },
    async bridge(request) {
      calls.push(request);
      if (hooks[request.action]) return hooks[request.action](request);
      if (request.action === 'configure') { enabled = request.params.enabled; return { policy: { enabled } }; }
      if (request.action === 'observe') return { observed: true, policy: { enabled }, nextAt: request.params.phase === 'idle' ? now + 1000 : null };
      if (request.action === 'list') return { policies: [{ enabled }] };
      if (request.action === 'claim') return { claimed: enabled, attempt: { id: `attempt-${++sequence}`, prompt: PROMPT, expiresAt: now + 1000 } };
      if (request.action === 'check') return { ready: enabled };
      return {};
    },
    async submitPrompt(args) {
      submits++;
      if (hooks.submit) return hooks.submit(args);
      const e = { text: args.text, origin: { kind: 'plugin', name: 'claudex' } };
      const refusal = await client.prompt(e);
      if (refusal) return refusal;
      await client.turnStart({ turnId: `warm-${sequence}`, text: args.text });
      return { text: args.text, origin: e.origin };
    },
  };
  await client.start(host);
  async function seed(turnId = 'seed', responseUsage = usage) {
    await client.turnStart({ turnId, text: 'Ordinary user work' });
    const ticket = await client.stepStart({ turnId, index: 0, model: usage.model, effort: 'medium' });
    await client.stepEnd(ticket, { usage: responseUsage, stopReason: 'end_turn' });
    await client.turnComplete({ turnId, reason: 'answer' });
  }
  async function enable(bounds = []) {
    const preview = await client.command(host, ['on', ...bounds], { kind: 'composer' });
    return client.command(host, ['confirm', preview.confirm.split(' ').at(-1)], { kind: 'composer' });
  }
  async function fire() {
    const timer = timers.findLast(item => !item.cancelled);
    if (!timer) return;
    timer.cancelled = true; now = timer.due; await timer.callback();
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  }
  return { client, host, calls, timers, hooks, seed, enable, fire,
    get submits() { return submits; }, set draft(value) { draft = value; }, set worker(value) { worker = value; },
    set fingerprint(value) { fingerprint = value; }, set context(value) { context = value; },
    get now() { return now; }, set now(value) { now = value; } };
}

test('cache warm window defaults to one hour and supports an explicit five-minute choice', () => {
  assert.deepEqual(cacheWarmTtl(), { ttlMs: 3600000, ttlSource: 'configured-window' });
  assert.equal(cacheWarmTtl({ setting: '1h' }).ttlMs, 3600000);
  assert.equal(cacheWarmTtl({ ttl: '5m', setting: '1h' }).ttlMs, 300000);
  assert.equal(cacheWarmTtl({ ttl: '1h', force5m: '1' }).ttlMs, 300000);
  assert.deepEqual(cacheWarmTtl({ preference: '5m' }), { ttlMs: 300000, ttlSource: 'configured-window' });
  assert.equal(cacheWarmTtl({ setting: '1h', preference: '5m' }).ttlMs, 300000);
  assert.equal(cacheWarmTtl({ setting: '5m', preference: '1h' }).ttlSource, 'native-setting');
  assert.equal(parseCacheWarmBounds().ttl, '1h');
  assert.equal(parseCacheWarmBounds().maxReadTokens, null);
  assert.throws(() => parseCacheWarmBounds(['maxReadTokens=250000']), /removed/);
  assert.equal(parseCacheWarmBounds(['ttl=5m']).ttl, '5m');
  assert.throws(() => parseCacheWarmBounds(['ttl=30m']), /ttl=1h or ttl=5m/);
  assert.throws(() => parseCacheWarmBounds(['ttl=5m', 'ttl=1h']), /exactly once/);
});

async function setPreference(f, ...words) {
  const preview = await f.client.command(f.host, ['preference', ...words], { kind: 'composer' });
  return f.client.command(f.host, ['confirm', preview.confirm.split(' ').at(-1)], { kind: 'composer' });
}

test('namespaced shortcut applies TTL only to its session, never the shared remember choice', async () => {
  const f = await fixture(), origin = { kind: 'composer' };
  await setPreference(f, 'remember', 'ttl=1h');
  for (const choice of ['5m', 'ttl=1h']) {
    const result = await f.client.sessionCommand(f.host, ['on', choice], origin);
    assert.equal(result.state, 'enabled');
    assert.equal(result.confirm, undefined);
    assert.equal(result.local.sessionId, ID);
    assert.equal((await f.host.readCacheTtl()).value, choice.replace('ttl=', ''));
    assert.equal(f.client.snapshot().enabled, true);
    await f.client.sessionCommand(f.host, ['off'], origin);
    const status = await f.client.sessionCommand(f.host, [], origin);
    assert.equal(status.ttlPreference.ttl, '1h');
    assert.equal(status.local.enabled, false);
    assert.equal(status.nativeCache.value, choice.replace('ttl=', ''));
  }
  assert.equal(f.submits, 0);
});

test('the shortcut turns rounds, a duration or a clock time into the confirmed bounds', async () => {
  const origin = { kind: 'composer' };
  for (const [words, expected] of [[['on', '5m', 'rounds=6'], { maxRefreshes: 6, maxMinutes: 10080 }],
    [['on', 'for=3h'], { maxRefreshes: 3, maxMinutes: 180 }], [['on'], { maxRefreshes: 4, maxMinutes: 240 }],
    [['on', '5m'], { maxRefreshes: 60, maxMinutes: 240 }], [['on', '5m', 'for=40m'], { maxRefreshes: 10, maxMinutes: 40 }]]) {
    const f = await fixture(), result = await f.client.sessionCommand(f.host, words, origin);
    assert.equal(result.state, 'enabled');
    const configured = f.calls.findLast(call => JSON.stringify(call).includes('maxRefreshes'));
    assert.ok(JSON.stringify(configured).includes(`"maxRefreshes":${expected.maxRefreshes}`), JSON.stringify(configured));
    assert.ok(JSON.stringify(configured).includes(`"maxMinutes":${expected.maxMinutes}`));
  }
  const f = await fixture();
  for (const words of [['on', 'for=10m'], ['on', '5m', 'for=40h'], ['on', 'rounds=0'], ['on', 'for=1h', 'until=23:00'], ['on', 'rounds=2', 'for=3h'], ['on', 'rounds=200'], ['off', 'rounds=2']])
    await assert.rejects(f.client.sessionCommand(f.host, words, origin));
  assert.equal(f.calls.length, 0);
});

test('a saved default limit replaces four hours for commands without one, through preview and confirm', async () => {
  const f = await fixture(), origin = { kind: 'composer' };
  const bounds = () => JSON.stringify(f.calls.findLast(call => JSON.stringify(call).includes('maxRefreshes')));
  assert.equal((await f.client.command(f.host, ['status'], origin)).defaultLimit, 'for=4h');
  const preview = await f.client.command(f.host, ['limit', 'rounds=7'], origin);
  assert.equal(preview.state, 'confirmation-required'); assert.equal(preview.defaultLimit, 'rounds=7'); assert.equal(preview.previousDefaultLimit, 'for=4h');
  // A preview writes nothing and enables nothing.
  const configured = () => f.calls.filter(call => JSON.stringify(call).includes('"configure"')).length;
  assert.equal(await f.host.readWarmLimit(), undefined); assert.equal(configured(), 0);
  const saved = await f.client.command(f.host, ['confirm', preview.confirm.split(' ').at(-1)], origin);
  assert.equal(saved.state, 'limit-saved'); assert.deepEqual(await f.host.readWarmLimit(), { version: 1, limit: 'rounds=7' });
  assert.equal(f.client.snapshot().enabled, false); assert.equal(configured(), 0);
  await assert.rejects(f.client.command(f.host, ['confirm', preview.confirm.split(' ').at(-1)], origin), /expired|changed/);
  await f.client.sessionCommand(f.host, ['on'], origin);
  assert.ok(bounds().includes('"maxRefreshes":7') && bounds().includes('"maxMinutes":10080'), bounds());
  // An explicit limit still wins over the saved default.
  await f.client.sessionCommand(f.host, ['on', 'for=2h'], origin);
  assert.ok(bounds().includes('"maxRefreshes":2') && bounds().includes('"maxMinutes":120'), bounds());
  for (const word of ['until=11:18:30', 'for=200h', 'rounds=0', 'ttl=1h', 'for=1m'])
    await assert.rejects(f.client.command(f.host, ['limit', word], origin), /limit|Limits|fits/i);
  await assert.rejects(f.client.command(f.host, ['limit', 'for=8h'], { kind: 'plugin' }), /explicit native user/);
  // Valid for one TTL is enough to save; the other TTL refuses it when warming is enabled.
  assert.equal(defaultWarmLimit('rounds=300'), 'rounds=300'); assert.equal(defaultWarmLimit({ version: 1, limit: 'until=18:30' }), 'until=18:30');
  assert.throws(() => defaultWarmLimit({ version: 2, limit: 'for=4h' }), /Default warming limit/);
  const strict = await fixture();
  const next = await strict.client.command(strict.host, ['limit', 'rounds=300'], origin);
  await strict.client.command(strict.host, ['confirm', next.confirm.split(' ').at(-1)], origin);
  await assert.rejects(strict.client.sessionCommand(strict.host, ['on', '1h'], origin), /300 warm requests cannot fit/);
});

test('bare session on enables directly with saved TTL or the one-hour default', async () => {
  for (const ttl of [undefined, '5m']) {
    const f = await fixture();
    if (ttl) await setPreference(f, 'default', `ttl=${ttl}`);
    const result = await f.client.sessionCommand(f.host, ['on'], { kind: 'composer' });
    assert.equal(result.state, 'enabled');
    assert.equal(result.confirm, undefined);
    assert.equal(result.nativeCacheSync.value, ttl ?? '1h');
    assert.equal(f.submits, 0);
  }
});

test('namespaced shortcut rejects ambiguous arguments, other contexts and non-user origins', async () => {
  const f = await fixture(), origin = { kind: 'composer' };
  for (const words of [['on', '30m'], ['on', '5m', 'ttl=1h'], ['off', '5m'], ['preference', 'session'], ['on', 'session=other']])
    await assert.rejects(f.client.sessionCommand(f.host, words, origin));
  await assert.rejects(f.client.sessionCommand(f.host, ['on'], { kind: 'plugin' }), /explicit native user/);
  assert.equal(f.calls.length, 0);
  const check = f.host.checkCacheTtl;
  f.host.checkCacheTtl = async desired => {
    const state = await check(desired);
    f.context = { sessionId: '22222222-2222-4222-8222-222222222222', cwd: '/other' };
    return state;
  };
  await assert.rejects(f.client.sessionCommand(f.host, ['on', '5m'], origin), /context changed/);
  assert.equal((await f.host.readCacheTtl()).value, '1h');
  assert.equal(f.calls.length, 0);
  assert.equal(f.submits, 0);
});

test('direct session enable fences activity during preparation and cannot consume legacy preference confirmations', async () => {
  const f = await fixture(), origin = { kind: 'composer' };
  const preview = await f.client.command(f.host, ['preference', 'remember', 'ttl=5m'], origin);
  await assert.rejects(f.client.sessionCommand(f.host, ['confirm', preview.confirm.split(' ').at(-1)], origin), /context changed/);
  assert.equal(await f.host.readTtlPreference(), undefined);
  const check = f.host.checkCacheTtl;
  f.host.checkCacheTtl = async desired => {
    const state = await check(desired);
    f.client.invalidate();
    return state;
  };
  await assert.rejects(f.client.sessionCommand(f.host, ['on', '5m'], origin), /context changed/);
  assert.equal((await f.host.readCacheTtl()).value, '1h');
  assert.equal(f.calls.length, 0);
  assert.equal(f.submits, 0);
});

test('TTL preference schema is bounded and defaults to session-only without inventing persistence', () => {
  assert.deepEqual(cacheTtlPreference(undefined), { version: 1, mode: 'session' });
  for (const value of [{ version: 2, mode: 'remember', ttl: '5m' }, { version: 1, mode: 'default' },
    { version: 1, mode: 'remember', ttl: '30m' }, { version: 1, mode: 'session', ttl: '1h' }])
    assert.throws(() => cacheTtlPreference(value), /invalid/);
});

test('remember preference is confirmed, updates on explicit TTL choices, and restores without inference', async () => {
  const f = await fixture();
  const preview = await f.client.command(f.host, ['preference', 'remember', 'ttl=5m'], { kind: 'composer' });
  assert.equal(await f.host.readTtlPreference(), undefined);
  assert.equal((await f.host.readCacheTtl()).value, '1h');
  const result = await f.client.command(f.host, ['confirm', preview.confirm.split(' ').at(-1)], { kind: 'composer' });
  assert.equal(result.state, 'preference-saved'); assert.equal(result.local.enabled, false);
  assert.equal((await f.host.readTtlPreference()).ttl, '5m');
  assert.equal(f.calls.length, 0); assert.equal(f.submits, 0);
  const omitted = await f.client.command(f.host, ['on'], { kind: 'composer' });
  assert.equal(omitted.ttl, '5m');
  await f.enable(['ttl=1h']);
  assert.equal((await f.host.readLastTtlChoice((await f.host.readTtlPreference()).revision)).ttl, '1h');
  const restarted = await fixture();
  await restarted.host.applyCacheTtl('5m', '1h', async () => {});
  restarted.host.readTtlPreference = f.host.readTtlPreference;
  restarted.host.readLastTtlChoice = f.host.readLastTtlChoice;
  await restarted.client.start(restarted.host, { restore: true });
  assert.equal((await restarted.host.readCacheTtl()).value, '1h');
  assert.equal(restarted.client.snapshot().ttlRestore.state, 'applied');
  assert.equal(restarted.client.snapshot().enabled, false);
  assert.equal(restarted.calls.length, 0); assert.equal(restarted.timers.length, 0);
});

test('fixed default survives temporary selection, while session mode disables future restoration', async () => {
  const f = await fixture(); await setPreference(f, 'default', 'ttl=5m');
  await f.enable(['ttl=1h']);
  assert.equal((await f.host.readTtlPreference()).ttl, '5m');
  await f.client.start(f.host, { restore: true });
  assert.equal((await f.host.readCacheTtl()).value, '5m');
  await f.enable(['ttl=1h']);
  await setPreference(f, 'session');
  assert.equal((await f.host.readCacheTtl()).value, '1h');
  await f.client.start(f.host, { restore: true });
  assert.equal((await f.host.readCacheTtl()).value, '1h');
  assert.equal(f.client.snapshot().ttlRestore.state, 'session-only');
  assert.equal(f.client.snapshot().enabled, false);
});

test('lazy status and clear-style binding never apply a saved native TTL preference', async () => {
  const f = await fixture(); await f.host.writeTtlPreference({ version: 1, mode: 'default', ttl: '5m' });
  await f.client.stop();
  const result = await f.client.command(f.host, ['status'], { kind: 'composer' });
  assert.equal(result.nativeCache.value, '1h'); assert.equal(result.ttlPreference.ttl, '5m');
  assert.deepEqual(f.calls.map(item => item.action), ['list']);
  await f.client.start(f.host);
  assert.equal((await f.host.readCacheTtl()).value, '1h');
});

test('startup policy and malformed preference failures stay visible without writes or inference', async () => {
  const f = await fixture(); let writes = 0;
  f.host.applyCacheTtl = async () => { writes++; };
  await f.host.writeTtlPreference({ version: 1, mode: 'remember', ttl: '1h', revision: 'warm-fixture' });
  f.host.checkCacheTtl = async () => { throw new Error('Managed policy prevents this change'); };
  await f.client.start(f.host, { restore: true });
  assert.match(f.client.snapshot().ttlRestore.error, /Managed policy/);
  await f.host.writeTtlPreference({ version: 99 });
  await f.client.start(f.host, { restore: true });
  assert.match(f.client.snapshot().ttlRestore.error, /invalid/);
  assert.equal(writes, 0); assert.equal(f.calls.length, 0); assert.equal(f.submits, 0);
});

test('native activity fences startup restoration before its environment write', async () => {
  const f = await fixture(); await f.host.writeTtlPreference({ version: 1, mode: 'default', ttl: '5m' });
  const apply = f.host.applyCacheTtl;
  f.host.applyCacheTtl = async (...args) => {
    await f.client.turnStart({ turnId: 'human', text: 'Human work' });
    return apply(...args);
  };
  await f.client.start(f.host, { restore: true });
  assert.equal((await f.host.readCacheTtl()).value, '1h');
  assert.equal(f.client.snapshot().ttlRestore.state, 'failed');
  assert.ok(await f.client.stepStart({ turnId: 'human', index: 0, effort: 'medium' }));
});

test('changed or failed preference persistence cannot silently enable warming', async () => {
  const f = await fixture();
  const preview = await f.client.command(f.host, ['preference', 'default', 'ttl=5m'], { kind: 'composer' });
  await f.host.writeTtlPreference({ version: 1, mode: 'default', ttl: '1h' });
  await assert.rejects(f.client.command(f.host, ['confirm', preview.confirm.split(' ').at(-1)], { kind: 'composer' }), /preference changed/);
  await setPreference(f, 'remember', 'ttl=1h');
  f.host.writeLastTtlChoice = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.enable(['ttl=5m']), /saved preference may have changed.*storage unavailable/);
  assert.equal((await f.host.readCacheTtl()).value, '5m');
  assert.equal(f.client.snapshot().enabled, false); assert.equal(f.submits, 0);
});

test('a stale remember write cannot overwrite another session mode or a newer remember revision', async () => {
  for (const newer of [{ version: 1, mode: 'session' }, { version: 1, mode: 'default', ttl: '1h' },
    { version: 1, mode: 'remember', ttl: '1h', revision: 'warm-newer' }]) {
    const f = await fixture(); await setPreference(f, 'remember', 'ttl=1h');
    const write = f.host.writeLastTtlChoice;
    f.host.writeLastTtlChoice = async value => {
      await f.host.writeTtlPreference(newer); // Another native session commits first.
      if (newer.mode === 'remember') await write({ revision: newer.revision, ttl: '5m' });
      await write(value);
    };
    await assert.rejects(f.enable(['ttl=5m']), /preference changed during remember update/);
    const status = await f.client.command(f.host, ['status'], { kind: 'composer' });
    assert.deepEqual(status.ttlPreference, newer.mode === 'remember' ? { ...newer, ttl: '5m' } : newer);
    assert.equal(f.client.snapshot().enabled, false);
  }
});

test('native TTL synchronization preserves forced-five-minute and managed-policy constraints', () => {
  assert.throws(() => assertNativeCacheTtlChange({ force5m: true }, '1h'), /FORCE_PROMPT_CACHING_5M/);
  assert.throws(() => assertNativeCacheTtlChange({ policyLocked: true, policyValue: '5m' }, '1h'), /Managed/);
  assert.doesNotThrow(() => assertNativeCacheTtlChange({ force5m: true, policyLocked: true, policyValue: '5m' }, '5m'));
});

test('native TTL readback failure leaves warming disabled without fake synchronization', async () => {
  const f = await fixture(); await f.seed(); await f.enable();
  f.host.applyCacheTtl = async () => ({ value: '1h', scope: 'current-process' });
  const preview = await f.client.command(f.host, ['on', 'ttl=5m'], { kind: 'composer' });
  await assert.rejects(f.client.command(f.host, ['confirm', preview.confirm.split(' ').at(-1)], { kind: 'composer' }), /readback/);
  assert.equal(f.client.snapshot().enabled, false);
  assert.equal(f.calls.findLast(item => item.action === 'configure').params.enabled, false);
  await f.fire(); assert.equal(f.submits, 0);
});

test('native TTL is not changed by preview or status', async () => {
  const f = await fixture(); let writes = 0;
  f.host.applyCacheTtl = async () => { writes++; throw new Error('unexpected mutation'); };
  const preview = await f.client.command(f.host, ['on', 'ttl=5m'], { kind: 'composer' });
  assert.equal(preview.nativeCacheChange.before, '1h'); assert.equal(preview.nativeCacheChange.after, '5m');
  assert.equal(preview.nativeCacheChange.writesGlobalSettings, false);
  const status = await f.client.command(f.host, ['status'], { kind: 'composer' });
  assert.equal(status.nativeCache.value, '1h'); assert.equal(writes, 0);
});

test('native panel can change TTL without enabling warming and stale panel contexts are refused', async () => {
  const f = await fixture(); await setPreference(f, 'remember', 'ttl=1h');
  const context = await f.host.context();
  const preview = await f.client.command(f.host, ['ttl', '5m'], { kind: 'claudex-panel' }, context);
  assert.equal((await f.host.readCacheTtl()).value, '1h');
  const result = await f.client.command(f.host, ['confirm', preview.confirm.split(' ').at(-1)], { kind: 'claudex-panel' }, context);
  assert.equal(result.state, 'ttl-applied'); assert.equal(result.local.enabled, false);
  const status = await f.client.command(f.host, ['status'], { kind: 'claudex-panel' }, context);
  assert.equal(status.nativeCache.value, '5m'); assert.equal(status.ttlPreference.ttl, '5m');
  assert.equal(f.calls.some(item => item.action === 'configure' && item.params.enabled), false);
  f.context = { sessionId: '22222222-2222-4222-8222-222222222222', cwd: '/other' };
  await assert.rejects(f.client.command(f.host, ['ttl', '1h'], { kind: 'claudex-panel' }, context), /panel context changed/);
  assert.equal((await f.host.readCacheTtl()).value, '5m'); assert.equal(f.submits, 0);
});

test('discarding a cache settings preview revokes its native confirmation', async () => {
  const f = await fixture();
  const preview = await f.client.command(f.host, ['ttl', '5m'], { kind: 'composer' });
  await f.client.command(f.host, ['discard'], { kind: 'claudex-panel' });
  await assert.rejects(f.client.command(f.host, ['confirm', preview.confirm.split(' ').at(-1)], { kind: 'composer' }), /expired/);
  assert.equal((await f.host.readCacheTtl()).value, '1h');
});

test('TTL confirmation locks queued timers before awaiting native preflight', async () => {
  const f = await fixture(); await f.seed(); await f.enable();
  const queued = f.timers.at(-1);
  const preview = await f.client.command(f.host, ['on', 'ttl=5m'], { kind: 'composer' });
  const check = f.host.checkCacheTtl;
  f.host.checkCacheTtl = async desired => {
    await queued.callback();
    return check(desired);
  };
  await f.client.command(f.host, ['confirm', preview.confirm.split(' ').at(-1)], { kind: 'composer' });
  assert.equal(f.submits, 0);
  assert.equal(f.calls.some(item => item.action === 'claim'), false);
  assert.equal((await f.host.readCacheTtl()).value, '5m');
});

test('a native turn during TTL preflight prevents the final environment write', async () => {
  const f = await fixture(); await f.seed(); await f.enable();
  const apply = f.host.applyCacheTtl;
  f.host.applyCacheTtl = async (...args) => {
    await f.client.turnStart({ turnId: 'new-human', text: 'Human work' });
    return apply(...args);
  };
  await assert.rejects(f.enable(['ttl=5m']), /native context or current native turn changed/);
  assert.equal((await f.host.readCacheTtl()).value, '1h');
  assert.equal(f.client.snapshot().enabled, false);
  assert.equal(f.calls.findLast(item => item.action === 'configure').params.enabled, false);
  assert.ok(await f.client.stepStart({ turnId: 'new-human', index: 0, effort: 'medium' }));
});

test('lost native TTL readback explicitly reports possible applied configuration', async () => {
  const f = await fixture(); await f.seed(); await f.enable();
  const apply = f.host.applyCacheTtl;
  f.host.applyCacheTtl = async (...args) => { await apply(...args); throw new Error('readback unavailable'); };
  await assert.rejects(f.enable(['ttl=5m']), /native TTL may have changed and was not rolled back.*readback unavailable/);
  assert.equal((await f.host.readCacheTtl()).value, '5m');
  assert.equal(f.client.snapshot().enabled, false);
  await f.fire(); assert.equal(f.submits, 0);
});

test('warming defaults off and status neither configures nor observes', async () => {
  const f = await fixture(); await f.seed();
  assert.equal(f.calls.length, 0); assert.equal(f.timers.length, 0);
  await f.client.command(f.host, ['status'], { kind: 'composer' });
  assert.deepEqual(f.calls.map(item => item.action), ['list']);
  assert.equal(f.submits, 0);
});

test('confirmed five-minute choice is persisted and waits for fresh window-specific evidence', async () => {
  const f = await fixture();
  f.host.cacheConfiguration = async preference => {
    const ttl = cacheWarmTtl({ preference }); return { ttl, fingerprint: JSON.stringify(ttl) };
  };
  await f.seed();
  const preview = await f.client.command(f.host, ['on', 'ttl=5m'], { kind: 'composer' });
  assert.equal(preview.ttl, '5m');
  assert.equal(preview.cacheWindow.ttlMs, 300000);
  assert.equal(f.calls.length, 0);
  await f.client.command(f.host, ['confirm', preview.confirm.split(' ').at(-1)], { kind: 'composer' });
  assert.equal(f.calls.find(item => item.action === 'configure' && item.params.enabled).params.ttl, '5m');
  assert.equal((await f.host.readCacheTtl()).value, '5m');
  assert.equal(f.calls.find(item => item.action === 'observe').params.sample, undefined);
  assert.equal(f.timers.length, 0);
  await f.seed('after-window-change');
  const sample = f.calls.findLast(item => item.action === 'observe' && item.params.sample)?.params.sample;
  assert.equal(sample.ttlMs, 300000);
  assert.equal(sample.ttlSource, 'configured-window');
  assert.equal(f.timers.length, 1);
});

test('changing the window cannot invalidate an in-flight native turn', async () => {
  const f = await fixture();
  await f.client.turnStart({ turnId: 'working', text: 'Human work' });
  const preview = await f.client.command(f.host, ['on', 'ttl=5m'], { kind: 'composer' });
  await assert.rejects(f.client.command(f.host, ['confirm', preview.confirm.split(' ').at(-1)], { kind: 'composer' }), /current native turn/);
  assert.equal(f.calls.length, 0);
  assert.ok(await f.client.stepStart({ turnId: 'working', index: 0, effort: 'medium' }));
});

test('bounded confirmation is exact context, expires, and is one-use', async () => {
  const f = await fixture();
  const preview = await f.client.command(f.host, ['on', 'maxRefreshes=2'], { kind: 'composer' });
  assert.equal(f.calls.length, 0); assert.equal(preview.maxRefreshes, 2);
  assert.equal(preview.ttl, '1h');
  assert.deepEqual(preview.cacheWindow, { ttlMs: 3600000, ttlSource: 'native-setting', refreshBeforeExpiryMs: 300000 });
  assert.equal(preview.nativeOutputCapUnchanged, true);
  const command = ['confirm', preview.confirm.split(' ').at(-1)];
  f.now = 121000;
  await assert.rejects(f.client.command(f.host, command, { kind: 'composer' }), /expired/);
  await assert.rejects(f.client.command(f.host, command, { kind: 'composer' }), /expired/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => parseCacheWarmBounds(['maxMinutes=1', 'maxMinutes=2']), /unique/);
  assert.throws(() => parseCacheWarmBounds(['maxRefreshes=100000']), /limits/);
});

test('managed workers and plugin-origin enable cannot authorize inference', async () => {
  const f = await fixture();
  await assert.rejects(f.client.command(f.host, ['on'], { kind: 'plugin', name: 'other' }), /user command/);
  f.worker = true;
  await assert.rejects(f.client.command(f.host, ['on'], { kind: 'composer' }), /worker/);
  assert.equal(f.calls.length, 0);
});

test('one broker-authorized own prompt inherits context without fork, asUser, or token changes', async () => {
  const f = await fixture(); await f.seed(); await f.enable(); await f.fire();
  assert.deepEqual(f.calls.slice(0, 2).map(item => item.action), ['observe', 'configure']);
  assert.equal(f.submits, 1);
  const receipt = f.calls.find(item => item.action === 'receipt');
  assert.equal(receipt.params.outcome, 'submitted');
  assert.equal(f.client.deniesTool({}), true);
  assert.equal(f.client.deniesTool({ agentId: 'child' }), false);
  assert.deepEqual(f.calls.find(item => item.action === 'claim').context, { sessionId: ID, cwd: '/fixture' });
});

test('native re-entry suppression does not require the originating prompt hook to run', async () => {
  const f = await fixture(); await f.seed(); await f.enable();
  f.hooks.submit = async args => {
    // Observed native behavior: prompt.submit skips this plugin's hook, but
    // turn.start still arrives with the exact native idle-plugin envelope.
    const framed = `The claudex plugin sent a message:\n${args.text}\n\nThis is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.`;
    assert.equal(isCacheWarmTurnText(framed, args.text, 'claudex'), true);
    assert.equal(isCacheWarmTurnText(framed + '\nextra work', args.text, 'claudex'), false);
    assert.equal(isCacheWarmTurnText(framed, args.text, 'another-plugin'), false);
    await f.client.turnStart({ turnId: 'native-warm', text: framed });
    assert.equal(f.client.deniesTool({}), true);
    return { text: args.text, origin: { kind: 'plugin', name: 'claudex' } };
  };
  await f.fire();
  assert.equal(f.submits, 1);
  assert.equal(f.calls.find(item => item.action === 'receipt').params.outcome, 'submitted');
});

test('a suspended warm turn-start cannot overwrite a newer human turn', async () => {
  const f = await fixture(); await f.seed(); await f.enable();
  f.hooks.submit = async args => {
    const originalContext = f.host.context; let interrupt = true;
    f.host.context = async () => {
      if (interrupt) {
        interrupt = false;
        await f.client.prompt({ text: 'New human work', origin: { kind: 'composer' } });
        await f.client.turnStart({ turnId: 'new-human', text: 'New human work' });
      }
      return originalContext();
    };
    await f.client.turnStart({ turnId: 'old-warm', text: args.text });
    return { text: args.text, origin: { kind: 'plugin', name: 'claudex' } };
  };
  await f.fire();
  assert.equal(f.client.deniesTool({}), false);
  assert.equal(f.client.snapshot().suspended, false);
  assert.ok(await f.client.stepStart({ turnId: 'new-human', index: 0, effort: 'medium' }));
});

test('a pending draft suppresses warming without touching draft or retrying', async () => {
  const f = await fixture(); await f.seed(); await f.enable(); f.draft = 'My unsent draft'; await f.fire(); await f.fire();
  assert.equal(f.submits, 0); assert.equal(f.calls.filter(item => item.action === 'claim').length, 0);
  assert.equal((await f.host.readPrompt()).text, 'My unsent draft');
});

test('a broker not-due result without a policy preserves the existing opt-in', async () => {
  const f = await fixture(); await f.seed(); await f.enable();
  f.hooks.claim = async () => ({ claimed: false, reason: 'not-due', nextAt: f.now + 1000 });
  await f.fire();
  assert.equal(f.submits, 0); assert.equal(f.client.snapshot().enabled, true);
  assert.equal(f.timers.at(-1).cancelled, false);
});

test('ordinary activity cancels the old timer and new completed usage reschedules', async () => {
  const f = await fixture(); await f.seed(); await f.enable();
  const old = f.timers.at(-1);
  await f.client.turnStart({ turnId: 'human', text: 'Work' });
  assert.equal(old.cancelled, true); await f.fire(); assert.equal(f.submits, 0);
  const ticket = await f.client.stepStart({ turnId: 'human', index: 0, effort: 'medium' });
  await f.client.stepEnd(ticket, { usage, stopReason: 'end_turn' });
  await f.client.turnComplete({ turnId: 'human', reason: 'answer' });
  assert.equal(f.timers.at(-1).cancelled, false);
});

test('context change while broker check is awaited rejects the reserved slot', async () => {
  const f = await fixture(); await f.seed(); await f.enable();
  f.hooks.check = async () => { f.context = { sessionId: 'other', cwd: '/elsewhere' }; return { ready: true }; };
  await f.fire(); assert.equal(f.submits, 0);
  assert.equal(f.calls.find(item => item.action === 'receipt').params.outcome, 'rejected');
});

test('model/effort setting changes and session end fence late timer callbacks', async () => {
  const f = await fixture(); await f.seed(); await f.enable(); f.fingerprint = 'opus-high'; await f.fire();
  assert.equal(f.submits, 0);
  await f.client.stop(); await f.fire(); assert.equal(f.submits, 0);
  assert.equal(f.calls.at(-1).params.phase, 'ended');
});

test('uncertain native submission is consumed once and never automatically retried', async () => {
  const f = await fixture(); await f.seed(); await f.enable();
  f.hooks.submit = async () => { throw new Error('Native result lost'); };
  await f.fire(); await f.fire(); await f.seed('another-human'); await f.fire();
  assert.equal(f.submits, 1); assert.equal(f.client.snapshot().suspended, true);
  assert.equal(f.calls.find(item => item.action === 'receipt').params.outcome, 'uncertain');
});

test('human prompt racing before native admission revokes the warm prompt', async () => {
  const f = await fixture(); await f.seed(); await f.enable();
  f.hooks.submit = async args => {
    await f.client.prompt({ text: 'Human work', origin: { kind: 'composer' } });
    return f.client.prompt({ text: args.text, origin: { kind: 'plugin', name: 'claudex' } });
  };
  await f.fire();
  assert.equal(f.calls.find(item => item.action === 'receipt').params.outcome, 'rejected');
  assert.equal(f.client.deniesTool({}), false);
});

test('off cancels pending timers and native recovery is accounted per response', async () => {
  const f = await fixture(); await f.seed(); await f.enable(); await f.fire();
  for (let index = 0; index < 2; index++) {
    const ticket = await f.client.stepStart({ turnId: 'warm-1', index, effort: 'medium' });
    await f.client.stepEnd(ticket, { usage, stopReason: index === 0 ? 'max_tokens' : 'end_turn' });
  }
  const samples = f.calls.filter(item => item.action === 'observe' && item.params.sample?.attemptId).map(item => item.params.sample);
  assert.deepEqual(samples.map(item => item.id), ['warm-1:0', 'warm-1:1']);
  assert.ok(samples.every(item => item.attemptId === 'attempt-1' && !('text' in item)));
  await f.client.turnComplete({ turnId: 'warm-1', reason: 'answer' });
  await f.client.command(f.host, ['off'], { kind: 'composer' }); await f.fire();
  assert.equal(f.submits, 1); assert.equal(f.client.snapshot().enabled, false);
});

test('native client integrates with the real policy ledger from opt-in through verified usage', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-warm-mod-')));
  await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(), manager = await new CacheWarmManager({ root, now: () => f.now }).initialize();
  for (const action of ['configure', 'observe', 'claim', 'check', 'receipt', 'list']) f.hooks[action] = request => manager[action](request.params);
  await f.seed(); await f.enable();
  assert.equal((await manager.list()).policies[0].enabled, true);
  await f.fire(); assert.equal(f.submits, 1);
  // The broker generates a UUID; the host's synthetic native turn counter is 0.
  const ticket = await f.client.stepStart({ turnId: 'warm-0', index: 0, effort: 'medium' });
  f.now += 1000;
  await f.client.stepEnd(ticket, { usage: { ...usage, cache_read_input_tokens: 6020 }, stopReason: 'end_turn' });
  await f.client.turnComplete({ turnId: 'warm-0', reason: 'answer' });
  const status = await manager.list();
  assert.equal(status.attempts[0].state, 'verified');
  assert.equal(status.policies[0].totals.readTokens, 6020);
  assert.equal(status.policies[0].totals.outputTokens, 4);
  assert.equal(f.client.snapshot().enabled, true);
  assert.ok(status.policies[0].nextAt > f.now);
});

test('already-started native recovery remains accounted after the policy disables itself', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-warm-mod-')));
  await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(), manager = await new CacheWarmManager({ root, now: () => f.now }).initialize();
  for (const action of ['configure', 'observe', 'claim', 'check', 'receipt', 'list']) f.hooks[action] = request => manager[action](request.params);
  await f.seed(); await f.enable(); await f.fire();
  for (let index = 0; index < 2; index++) {
    const ticket = await f.client.stepStart({ turnId: 'warm-0', index, effort: 'medium' });
    f.now += 1000;
    await f.client.stepEnd(ticket, { usage: { ...usage, cache_read_input_tokens: 6020 + index * 20 },
      stopReason: index === 0 ? 'max_tokens' : 'end_turn' });
    assert.equal(f.client.snapshot().enabled, false);
  }
  await f.client.turnComplete({ turnId: 'warm-0', reason: 'answer' });
  const status = await manager.list();
  assert.equal(status.attempts[0].state, 'failed');
  assert.equal(status.policies[0].enabled, false);
  assert.equal(status.policies[0].totals.readTokens, 12060);
  assert.equal(status.policies[0].totals.outputTokens, 8);
  assert.equal(status.attempts[0].responseIds.length, 2);
  await f.fire(); assert.equal(f.submits, 1);
});

test('an aborted main turn retires successful busy-step evidence instead of scheduling it', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-warm-mod-')));
  await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture(), manager = await new CacheWarmManager({ root, now: () => f.now }).initialize();
  for (const action of ['configure', 'observe', 'claim', 'check', 'receipt', 'list']) f.hooks[action] = request => manager[action](request.params);
  await f.seed(); await f.enable();
  await f.client.turnStart({ turnId: 'interrupted', text: 'Ordinary work' });
  f.now += 1000;
  const ticket = await f.client.stepStart({ turnId: 'interrupted', index: 0, effort: 'medium' });
  f.now += 1000;
  await f.client.stepEnd(ticket, { usage, stopReason: 'end_turn' });
  await f.client.turnComplete({ turnId: 'interrupted', reason: 'aborted' });
  const status = await manager.list();
  assert.equal(status.policies[0].reason, 'awaiting-evidence');
  assert.equal(status.policies[0].nextAt, null);
  await f.fire(); assert.equal(f.submits, 0);
});
