import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CacheWarmManager } from '../src/cache-warm.mjs';
import { createCacheWarmClient, cacheWarmTtl, parseCacheWarmBounds, isCacheWarmTurnText, assertNativeCacheTtlChange } from '../plugins/claudex/hooks/cache-warm.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const PROMPT = 'Cache-retention measurement only. Reply with exactly OK. Do not call tools.';
const usage = { model: 'claude-sonnet-5-5', input_tokens: 2, cache_read_input_tokens: 6000, cache_creation_input_tokens: 20, output_tokens: 4 };
async function fixture() {
  let now = 1000, context = { sessionId: ID, cwd: '/fixture' }, fingerprint = 'sonnet-medium-5m';
  let draft = '', worker = false, enabled = false, sequence = 0, submits = 0, nativeTtl = '1h';
  const timers = [], calls = [], client = createCacheWarmClient();
  const hooks = {};
  const host = {
    pluginName: 'claudex', worker: async () => worker, context: async () => ({ ...context }), now: async () => now,
    cacheConfiguration: async preference => ({ fingerprint, ttl: cacheWarmTtl({ setting: nativeTtl, preference }) }),
    readCacheTtl: async () => ({ value: nativeTtl, environmentValue: nativeTtl, scope: 'current-process', force5m: false, policyLocked: false }),
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
  assert.equal(parseCacheWarmBounds(['ttl=5m']).ttl, '5m');
  assert.throws(() => parseCacheWarmBounds(['ttl=30m']), /ttl=1h or ttl=5m/);
  assert.throws(() => parseCacheWarmBounds(['ttl=5m', 'ttl=1h']), /exactly once/);
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
