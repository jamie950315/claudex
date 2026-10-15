#!/usr/bin/env node
// Pure fixture differential: no native conversation or model operations.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { formatWarmSummary } from '../plugins/claudex/hooks/cache-warm-display.mjs';
import { LANGUAGE_IDS, translator } from '../plugins/claudex/hooks/localization.mjs';

const [executable] = process.argv.slice(2);
assert.ok(executable && isAbsolute(executable), 'Usage: node dev/verify-rust-warm-summary.mjs /abs/warm-summary');
const context = { sessionId: '10000000-0000-4000-8000-000000000001', cwd: '/private/project' };
const policy = { ...context, provider: 'codex', enabled: true, reason: 'scheduled', refreshMinutes: 25,
  sample: { cacheReadTokens: 1000, cacheWriteTokens: 2000 }, totals: { readTokens: 5000, outputTokens: 10, refreshes: 2 },
  maxReadTokens: null, maxOutputTokens: 100, maxRefreshes: 8, until: 1760000000000, nextAt: 1759990000000,
  cacheResults: { count: 1, firstAt: 1759980000000 }, compactAtEnd: true };
const fixtures = [{}, { policy }, { policies: [{ ...policy, sessionId: 'foreign' }, policy] },
  ...['disabled', 'duration-limit', 'native-uncertain', 'unknown-native-state'].map(reason => ({ policy: { ...policy, reason, enabled: reason !== 'disabled' } })),
  { policy: { ...policy, enabled: false } }, { policy: { ...policy, compactAt: 1759970000000 } },
  { policy, local: { ...context, suspended: true, reason: 'user-message' } },
  { policy, local: { ...context, phase: 'running' } }, { policy, local: { ...context, phase: 'ended' } },
  { policy, local: { sessionId: 'foreign', suspended: true, reason: 'user-message' } },
  { policy: { ...policy, maxReadTokens: 0, sample: { cacheReadTokens: Number.MAX_SAFE_INTEGER, cacheWriteTokens: 1 } } }];
const requests = LANGUAGE_IDS.flatMap(language => fixtures.map(result => ({ language, result, context })));
const output = await new Promise((resolve, reject) => {
  const child = execFile(executable, [], { maxBuffer: 1024 * 1024, timeout: 20000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
  child.stdin.end(JSON.stringify(requests));
});
assert.equal(output.length, requests.length);
for (const [index, request] of requests.entries())
  assert.equal(output[index], formatWarmSummary(request.result, { ...context, provider: 'codex', t: translator(request.language) }),
    `${request.language} fixture ${index % fixtures.length}`);
process.stdout.write(JSON.stringify({ passed: true, languages: LANGUAGE_IDS.length, fixtures: fixtures.length, comparisons: requests.length }) + '\n');
