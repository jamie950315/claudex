import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexUsageCounter, codexCacheAdmission } from './codex-usage.mjs';

const first = { totalTokens: 1010, inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 100, outputTokens: 10, reasoningOutputTokens: 4 };
const last = { totalTokens: 1106, inputTokens: 1100, cachedInputTokens: 1000, cacheWriteInputTokens: 50, outputTokens: 6, reasoningOutputTokens: 2 };
const added = Object.fromEntries(Object.keys(first).map(key => [key, first[key] + last[key]]));
const event = (total, latest = total) => ({ threadId: 'fixture', turnId: 'turn-fixture', tokenUsage: { total, last: latest } });

test('Codex usage needs a real baseline, counts exact deltas and ignores duplicate notifications', () => {
  const c = createCodexUsageCounter('fixture');
  assert.equal(c.observe(event(first)).state, 'baseline');
  const sample = c.observe(event(added, last));
  assert.equal(sample.state, 'sample'); assert.deepEqual(sample.usage, last);
  assert.equal(sample.upstreamResponseIdAvailable, false);
  assert.equal(c.observe(event(added, last)).state, 'duplicate');
});

test('Codex counter fails closed on missing fields, reset, gaps and changed duplicate usage', () => {
  for (const bad of [event({ ...added, cacheWriteInputTokens: undefined }, last), event(first, last),
    event(last), event({ ...added, totalTokens: added.totalTokens + 1 }, last),
    event({ ...added, inputTokens: added.inputTokens + 1, totalTokens: added.totalTokens + 1 }, last)]) {
    const c = createCodexUsageCounter('fixture'); c.observe(event(first));
    assert.throws(() => c.observe(bad));
    assert.throws(() => c.observe(event(added, last)), /continuity was lost/);
  }
});

test('Codex usage identities and subset accounting are strict', () => {
  for (const bad of [{ ...event(first), threadId: 'another' }, { ...event(first), turnId: null },
    event({ ...first, reasoningOutputTokens: 11 }), event({ ...first, cachedInputTokens: 999 }),
    event({ ...first, outputTokens: -1 })]) assert.throws(() => createCodexUsageCounter('fixture').observe(bad));
});

test('a ready Codex owner never implies missing draft or tool guards are available', () => {
  const result = codexCacheAdmission({ status: 'ready' });
  assert.equal(result.ownerAvailable, true); assert.equal(result.supported, false);
  assert.equal(result.automaticDispatch, false);
  assert.deepEqual(result.blockers, ['native-composer-state-unavailable', 'native-warm-turn-tool-denial-unavailable']);
  assert.ok(codexCacheAdmission({ status: 'unavailable', reason: 'native-owner-unavailable' }).blockers.includes('native-owner-unavailable'));
});
