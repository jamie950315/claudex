import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from './plugin/hooks/register.mjs';
import { assessEvidence } from './evidence.mjs';
import { createTokenLimitEvidence } from './token-limit-evidence.mjs';

function fixture({ arm = 'warm', authorized = true, mutate = false, strategy = 'fork' } = {}) {
  const hooks = {}, timers = [], records = [];
  let now = 1000, calls = 0, messages = [{ role: 'user', content: 'fixture' }];
  const $ = {
    env: { get: async key => key === 'CLAUDEX_CACHE_PROBE_ARM' ? arm
      : key === 'CLAUDEX_CACHE_PROBE_STRATEGY' ? strategy : authorized ? '1' : undefined },
    clock: { now: async () => now, after: (delay, callback) => {
      const timer = { delay, callback, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(timer); return timer;
    } },
    fs: { write: async (_path, text) => { records.push(JSON.parse(text)); } },
    session: { cwd: async () => '/fixture', version: async () => ({ version: 'fixture' }), model: async () => 'claude-sonnet-5-5',
      messages: async () => messages },
    model: { fork: async () => { calls++; if (mutate) messages = [...messages, { role: 'user', content: 'unexpected' }];
      return { isAnswered: true, text: 'OK', usage: { cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, input_tokens: 10, output_tokens: 1 } }; } },
  };
  register((name, hook) => { hooks[name] = hook; });
  return { timers, records, get calls() { return calls; }, set now(value) { now = value; },
    async fire(name, event = {}) {
      if (name === 'turn.step') {
        const stream = hooks[name]($, event, async function* () { return {}; });
        while (!(await stream.next()).done) {}
      } else return hooks[name]($, event, async () => ({}));
    } };
}

async function seed(f) {
  await f.fire('session.start'); await f.fire('turn.start');
  await f.fire('turn.step', { model: 'claude-sonnet-5-5', effort: 'medium', index: 0 });
  await f.fire('turn.complete', { reason: 'answer' });
}
test('no authorization produces no observations or scheduled inference', async () => {
  const f = fixture({ authorized: false }); await seed(f); assert.equal(f.records.length, 0); assert.equal(f.timers.length, 0);
});
test('control observes without scheduling', async () => {
  const f = fixture({ arm: 'control' }); await seed(f); assert(f.records.length > 0); assert.equal(f.timers.length, 0);
});
test('main strategy observes without scheduling any fork', async () => {
  const f = fixture({ strategy: 'main' }); await seed(f); assert(f.records.length > 0);
  assert.equal(f.timers.length, 0); assert.equal(f.calls, 0);
});
test('warm arm schedules exactly one fork, preserves main, and does not rearm', async () => {
  const f = fixture(); await seed(f); assert.equal(f.timers.length, 1); assert.equal(f.timers[0].delay, 240000);
  f.now = 241000; await f.timers[0].callback(); await f.timers[0].callback();
  await f.fire('turn.complete', { reason: 'answer' });
  assert.equal(f.calls, 1); assert.equal(f.timers.length, 1);
  assert.equal(f.records.at(-1).rows.find(row => row.kind === 'fork-result').mainUnchanged, true);
});
test('end cancels the timer and fences late callbacks', async () => {
  const f = fixture(); await seed(f); await f.fire('session.end'); await f.timers[0].callback();
  assert(f.timers[0].cancelled); assert.equal(f.calls, 0);
});
test('busy sessions do not fork or retry after the scheduled opportunity', async () => {
  const f = fixture(); await seed(f); await f.fire('turn.start'); await f.timers[0].callback();
  await f.fire('turn.complete', { reason: 'answer' }); assert.equal(f.calls, 0); assert.equal(f.timers.length, 1);
});
test('main mutation is reported, never treated as preservation', async () => {
  const f = fixture({ mutate: true }); await seed(f); await f.timers[0].callback();
  assert.equal(f.records.at(-1).rows.find(row => row.kind === 'fork-result').mainUnchanged, false);
});

test('an answered cache-writing fork is not cache-refresh success', () => {
  const report = { arms: { warm: { receipts: [{ usage: { cache_creation_input_tokens: 6455 } }],
    probe: { rows: [{ kind: 'fork-result', isAnswered: true, mainUnchanged: true,
      usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 6458 } }] } } } };
  assert.equal(assessEvidence(report).status, 'not-established');
});

test('a hit without the post-expiry control is still inconclusive', () => {
  const report = { arms: { warm: { receipts: [{ usage: { cache_creation_input_tokens: 4000 } }],
    probe: { rows: [{ kind: 'fork-result', isAnswered: true, mainUnchanged: true,
      usage: { cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 } }] } } } };
  assert.equal(assessEvidence(report).status, 'inconclusive');
});

test('a full prefix, expired cold control and exited processes are required', () => {
  const requests = [{ kind: 'request', main: true, at: 1000 }, { kind: 'request', main: true, at: 361000 }];
  const report = { arms: {
    control: { childExited: true, receipts: [{ usage: { cache_creation_input_tokens: 4000 } },
      { usage: { cache_creation_input_tokens: 4010, cache_read_input_tokens: 0 } }], probe: { rows: requests } },
    warm: { childExited: true, receipts: [{ usage: { cache_creation_input_tokens: 4000 } },
      { usage: { cache_creation_input_tokens: 10, cache_read_input_tokens: 4000 } }], probe: { rows: [...requests,
        { kind: 'fork-result', isAnswered: true, mainUnchanged: true, usage: { cache_read_input_tokens: 4000 } }] } },
  } };
  assert.equal(assessEvidence(report).status, 'demonstrated-in-isolated-cli');
  report.arms.control.receipts[1].usage.cache_read_input_tokens = 4000;
  assert.equal(assessEvidence(report).status, 'inconclusive');
  report.arms.control.receipts[1].usage.cache_read_input_tokens = 0;
  delete report.arms.warm.receipts[1].usage.cache_read_input_tokens;
  assert.equal(assessEvidence(report).status, 'inconclusive');
});

test('main refresh requires same-session, fixed-model requests and a cold control', () => {
  const request = at => ({ kind: 'request', main: true, at, model: 'claude-sonnet-5-5', effort: 'medium' });
  const receipt = (read, write) => ({ isError: false, replyIsOK: true,
    usage: { cache_creation_input_tokens: write, cache_read_input_tokens: read } });
  const report = { strategy: 'main', arms: {
    control: { childExited: true, nativeSessionCount: 1, nativeModels: ['claude-sonnet-5-5'], receipts: [receipt(0, 4000), receipt(0, 4010)],
      probe: { rows: [request(1000), request(362000)] } },
    warm: { childExited: true, nativeSessionCount: 1, nativeModels: ['claude-sonnet-5-5'],
      receipts: [receipt(0, 4000), receipt(4000, 20), receipt(4020, 10)],
      probe: { rows: [request(1000), request(241010), request(363000)] } },
  } };
  assert.equal(assessEvidence(report).status, 'demonstrated-in-isolated-cli');
  report.arms.warm.receipts[1].usage.cache_read_input_tokens = 0;
  assert.equal(assessEvidence(report).status, 'not-established');
  report.arms.warm.receipts[1].usage.cache_read_input_tokens = 4000;
  report.arms.warm.nativeSessionCount = 2;
  assert.equal(assessEvidence(report).status, 'refused');
  report.arms.warm.nativeSessionCount = 1;
  report.arms.control.receipts[1].usage.cache_read_input_tokens = 4000;
  assert.equal(assessEvidence(report).status, 'inconclusive');
});

test('one-token accounting deduplicates native frames and counts recovery responses', () => {
  const evidence = createTokenLimitEvidence();
  const usage = { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000, output_tokens: 0 };
  evidence.observe({ type: 'stream_event', event: { type: 'message_start', message: { id: 'a', model: 'claude-sonnet-5-5', usage } } }, 1);
  evidence.observe({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } } }, 1);
  evidence.observe({ type: 'assistant', message: { id: 'a', model: 'claude-sonnet-5-5', stop_reason: null, usage } }, 1);
  assert.equal(evidence.summary().totals.output_tokens, 1);
  evidence.observe({ type: 'assistant', message: { id: 'a', model: 'claude-sonnet-5-5', stop_reason: 'max_tokens', usage: { ...usage, output_tokens: 1 } } }, 1);
  evidence.observe({ type: 'assistant', message: { id: 'synthetic', model: '<synthetic>', content: [{ text: 'Do not retain me' }] } }, 1);
  evidence.observe({ type: 'assistant', message: { id: 'b', model: 'claude-sonnet-5-5', stop_reason: 'max_tokens', usage: { ...usage, output_tokens: 1 } } }, 1);
  const result = evidence.summary();
  assert.equal(result.responseCount, 2); assert.equal(result.totals.output_tokens, 2);
  assert.equal(result.totals.cache_read_input_tokens, 8000);
  assert.equal(JSON.stringify(result).includes('Do not retain me'), false);
  evidence.observe({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 2, error_status: 429 }, 2);
  assert.equal(evidence.summary().retries[0].status, 429);
});
