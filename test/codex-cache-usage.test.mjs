import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexUsageCounter } from '../src/codex-cache-usage.mjs';

const prior = { totalTokens: 1010, inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 100, outputTokens: 10, reasoningOutputTokens: 4 };
const request = { totalTokens: 1106, inputTokens: 1100, cachedInputTokens: 1000, cacheWriteInputTokens: 50, outputTokens: 6, reasoningOutputTokens: 2 };
const add = (a, b) => Object.fromEntries(Object.keys(a).map(key => [key, a[key] + b[key]]));
const event = (total, last) => ({ threadId: 'fixture', turnId: 'own-prime', tokenUsage: { total, last } });

test('an attributed first warm request charges native last usage without fabricating a baseline', () => {
  const c = createCodexUsageCounter('fixture'), total = add(prior, request);
  const first = c.observe(event(total, request), { firstRequest: true });
  assert.equal(first.state, 'sample'); assert.equal(first.provenance, 'native-last-request');
  assert.deepEqual(first.usage, request); assert.equal(first.upstreamResponseIdAvailable, false);
  assert.equal(c.observe(event(total, request), { firstRequest: true }).state, 'duplicate');
  const later = c.observe(event(add(total, request), request), { firstRequest: true });
  assert.equal(later.provenance, 'native-cumulative-delta'); assert.deepEqual(later.usage, request);
});

test('ordinary first observations remain baseline-only and later continuity cannot be bypassed', () => {
  const c = createCodexUsageCounter('fixture');
  assert.equal(c.observe(event(prior, prior)).state, 'baseline');
  const invalid = add(add(prior, request), request);
  assert.throws(() => c.observe(event(invalid, request), { firstRequest: true }), /not one request/);
  assert.throws(() => c.observe(event(add(prior, request), request)), /continuity was lost/);
});

test('first-request accounting rejects last usage larger than native cumulative totals', () => {
  const c = createCodexUsageCounter('fixture');
  assert.throws(() => c.observe(event(prior, request), { firstRequest: true }), /exceeds/);
  assert.throws(() => c.observe(event(add(prior, request), request)), /continuity was lost/);
});
