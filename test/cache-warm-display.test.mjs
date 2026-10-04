import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWarmSummary, formatWarmTime } from '../plugins/claudex/hooks/cache-warm-display.mjs';
import { catalogs } from '../plugins/claudex/hooks/locales.mjs';
import { translator } from '../plugins/claudex/hooks/localization.mjs';

const context = { provider: 'claude', sessionId: 'this-session', cwd: '/fixture', formatTime: value => `time-${value}` };
const policy = overrides => ({
  provider: 'claude', sessionId: context.sessionId, cwd: context.cwd, enabled: true, ttlPreference: '1h',
  until: 10000, status: 'awaiting-evidence', reason: 'awaiting-evidence',
  totals: { readTokens: 0, outputTokens: 0 }, maxReadTokens: 250000, maxOutputTokens: 256,
  cacheResults: { firstAt: null, lastAt: null, count: 0 }, ...overrides,
});
const show = (result, options = {}) => formatWarmSummary(result, { ...context, ...options });

test('waiting summary contains four compact plain-text lines without diagnostic JSON', () => {
  const result = { policy: policy(), nativeCacheSync: { value: '1h' }, fingerprint: 'private-fingerprint', risks: 'private-risk' };
  const before = structuredClone(result);
  assert.equal(show(result), [
    'Cache warming: Enabled · TTL 1h',
    'Tokens: prefix Unknown · warm reads: 0/250,000 (counted/limit), output 0/256',
    'First cache result: Not yet',
    'Next warm: Waiting for a normal reply',
  ].join('\n'));
  assert.deepEqual(result, before);
  assert.doesNotMatch(show(result), /private-|this-session|fixture|[{}]/);
});

test('scheduled summary separates cached prefix, budget accounting and actual cache results', () => {
  const p = policy({ reason: 'scheduled', status: 'scheduled', nextAt: 9000,
    sample: { cacheReadTokens: 6000, cacheWriteTokens: 250, startedAt: 2000, completedAt: 3000 },
    totals: { readTokens: 8000, outputTokens: 64 }, cacheResults: { firstAt: 4500, lastAt: 6500, count: 2 } });
  const text = show({ policy: p });
  assert.ok(text.includes('prefix 6,250 · warm reads: 8,000/250,000 (counted/limit), output 64/256'));
  assert.match(text, /First cache result: time-4500/);
  assert.match(text, /Next warm: time-9000$/);
  assert.doesNotMatch(text, /time-2000|time-3000|time-6500|time-10000/);
});

test('Codex interval is not presented as a configurable native TTL', () => {
  const text = show({ policy: policy({ provider: 'codex', refreshMinutes: 25, effectiveTtlMs: 1800000, ttlMs: 1800000 }) }, { provider: 'codex' });
  assert.match(text, /Interval 25 min · TTL managed by Codex/);
  assert.doesNotMatch(text, /TTL 1h|TTL 30|1800000/);
});

test('no matching policy stays off without invented quotas, timestamps or defaults', () => {
  const text = show({ policies: [policy({ sessionId: 'other-session' }), policy({ cwd: '/elsewhere' })] });
  assert.equal(text, [
    'Cache warming: Disabled · TTL Unknown',
    'Tokens: prefix Unknown · warm reads: Unknown/Unknown (counted/limit), output Unknown/Unknown',
    'First cache result: Not yet',
    'Next warm: Stopped',
  ].join('\n'));
  assert.doesNotMatch(show({ policy: policy({ sessionId: 'other-session' }), nativeCache: { value: '5m' } }), /TTL 5m/);
  assert.match(formatWarmSummary({ policies: [policy()] }), /Cache warming: Disabled/);
});

test('status selects only the exact session and directory and supports known native TTL while off', () => {
  const text = show({ policies: [policy({ sessionId: 'other-session' }), policy({ enabled: false, reason: 'disabled' })], nativeCache: { value: '5m' } });
  assert.match(text, /^Cache warming: Disabled · TTL 5m\n/);
  assert.match(text, /Next warm: Stopped$/);
});

test('disabled and reached-budget policies retain the reason without a misleading future schedule', () => {
  assert.match(show({ policy: policy({ enabled: false, reason: 'output-budget', nextAt: 9000 }) }), /Next warm: Token budget reached$/);
  const paused = show({ policy: policy({ reason: 'refresh-limit', nextAt: 9000 }) });
  assert.match(paused, /^Cache warming: Paused/);
  assert.match(paused, /Next warm: Refresh limit reached$/);
  assert.doesNotMatch(paused, /time-9000/);
});

test('local suspension and activity supersede stale broker schedule without hiding a failure', () => {
  const scheduled = policy({ reason: 'scheduled', nextAt: 9000 });
  const paused = show({ policy: scheduled, local: { sessionId: context.sessionId, enabled: true, suspended: true, reason: 'uncertain' } });
  assert.match(paused, /^Cache warming: Paused/);
  assert.match(paused, /Next warm: Delivery uncertain; stopped$/);
  assert.doesNotMatch(paused, /time-9000/);
  assert.match(show({ policy: policy({ reason: 'busy', nextAt: 9000 }) }), /Next warm: Waiting for the current turn$/);
  assert.match(show({ policy: scheduled, local: { sessionId: context.sessionId, enabled: false } }), /Next warm: Stopped$/);
  assert.match(show({ policy: policy({ enabled: false, reason: 'disabled' }), local: { sessionId: context.sessionId, enabled: false, reason: 'awaiting-evidence' } }), /Next warm: Stopped$/);
  assert.match(show({ policy: scheduled, local: { sessionId: 'other-session', enabled: false } }), /Next warm: time-9000$/);
  assert.match(show({ policy: scheduled, local: { sessionId: context.sessionId, enabled: true, phase: 'busy' } }), /Next warm: Waiting for the current turn$/);
  assert.match(show({ policy: { ...scheduled, nativeReason: 'awaiting-native-settings' } }), /Next warm: Waiting for a normal reply$/);
  assert.match(show({ policy: policy({ reason: 'duration-limit', nativeReason: 'awaiting-evidence', nextAt: 9000 }) }), /Next warm: Time limit reached$/);
});

test('missing or invalid timestamps and counters remain unknown rather than fabricated', () => {
  const text = show({ policy: policy({ reason: 'scheduled', until: null, nextAt: Infinity,
    sample: { cacheReadTokens: 3, cacheWriteTokens: null }, totals: { readTokens: NaN, outputTokens: -1 },
    cacheResults: { count: 1, firstAt: null, lastAt: null } }) });
  assert.doesNotMatch(text, /Until/);
  assert.ok(text.includes('prefix Unknown · warm reads: Unknown/250,000 (counted/limit), output Unknown/256'));
  assert.match(text, /First cache result: Unknown/);
  assert.match(text, /Next warm: Unknown$/);
  assert.match(show({ policy: policy({ reason: 'scheduled', nextAt: 5000 }) }, { formatTime: () => null }), /Next warm: Unknown$/);
});

test('unknown reasons are bounded and do not expose raw multiline diagnostics', () => {
  const text = show({ policy: policy({ reason: 'new-native-refusal' }) });
  assert.match(text, /Next warm: Needs inspection \(new-native-refusal\)$/);
  const privateText = show({ policy: policy({ reason: 'PRIVATE\n/path/secret' }) });
  assert.equal(privateText.split('\n').length, 4);
  assert.match(privateText, /Next warm: Needs inspection$/);
  assert.doesNotMatch(privateText, /PRIVATE|secret/);
});

test('default times include local date, time and explicit UTC offset without Intl', () => {
  const text = formatWarmTime(1791120000000);
  assert.match(text, /^\d{2}\/\d{2} \d{2}:\d{2} UTC[+-]\d{2}:\d{2}$/);
  for (const value of [null, undefined, NaN, Infinity, -1, 0, 1e20]) assert.equal(formatWarmTime(value), null);
});

test('all nine catalogs render the same four-line contract with complete placeholders', () => {
  const reasonList = ['awaiting-evidence', 'awaiting-native-binding', 'busy', 'attempt-pending', 'duration-limit',
    'refresh-limit', 'read-budget', 'cache-expired', 'no-cache-prefix', 'native-output-not-complete',
    'native-ended', 'native-binding-changed', 'native-configuration-changed', 'native-activity-changed', 'uncertain', 'unknown-reason'];
  for (const language of Object.keys(catalogs)) {
    const t = translator(language);
    for (const reason of reasonList) {
      const output = show({ policy: policy({ reason }) }, { t });
      assert.equal(output.split('\n').length, 4, language);
      assert.doesNotMatch(output, /[{}]/, language);
    }
  }
  for (const [key, english] of Object.entries(catalogs.en)) {
    const placeholders = value => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match => match[1]).sort();
    for (const [language, catalog] of Object.entries(catalogs)) {
      assert.equal(typeof catalog[key], 'string', `${language}: ${key}`);
      assert.deepEqual(placeholders(catalog[key]), placeholders(english), `${language}: ${key}`);
    }
  }
  assert.match(show({ policy: policy() }, { t: translator('zh-Hant') }), /^快取保溫：?[:]? 已啟用/);
});
