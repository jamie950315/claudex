// Native observer acceptance only. Dispatch is disabled at the final owner boundary.
import assert from 'node:assert/strict';
import { lstat, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CodexCacheWarmer } from '../../src/codex-cache-warm.mjs';
import { createCodexCacheNative } from '../../src/codex-cache-native.mjs';

const { values } = parseArgs({ options: { root: { type: 'string' }, session: { type: 'string' }, cwd: { type: 'string' },
  'observe-ms': { type: 'string', default: '20000' } } });
assert(values.root && values.session && values.cwd, 'Supply --root, --session and --cwd.');
const root = await realpath(values.root), stat = await lstat(root), duration = Number(values['observe-ms']);
assert(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && (await readdir(root)).length === 0);
assert(relative(fileURLToPath(new URL('../..', import.meta.url)), root).startsWith('../'));
assert(Number.isSafeInteger(duration) && duration >= 1000 && duration <= 60000);
const native = createCodexCacheNative();
let dispatchAttempts = 0;
const original = native.connect;
native.connect = async (...args) => {
  const handle = await original(...args), preflight = handle.preflight;
  handle.preflight = async () => {
    const owner = await preflight();
    owner.dispatch = async () => { dispatchAttempts++; throw new Error('Native inference is prohibited by this observer acceptance.'); };
    return owner;
  };
  return handle;
};
const service = await new CodexCacheWarmer({ root, native }).initialize();
const report = { outcome: 'running', inferenceStarted: false };
try {
  const preview = await service.prepare({ sessionId: values.session, cwd: values.cwd, bestEffort: true,
    refreshMinutes: 25, maxMinutes: 1, maxRefreshes: 1, maxReadTokens: 1000000, maxOutputTokens: 128 }, 'observer-test');
  const result = await service.confirm({ confirmationId: preview.confirmationId, bestEffort: true }, 'observer-test');
  assert.equal(result.policy.enabled, true);
  console.log(JSON.stringify({ phase: 'observing', durationMs: duration, nativeInferenceDisabled: true }));
  await new Promise(resolve => setTimeout(resolve, duration));
  await service.serial;
  const b = service.bindings.get(values.session);
  report.observedSamples = b.samples.length;
  report.nativeReason = b.reason;
  assert.equal(dispatchAttempts, 0);
  assert(!b.retired || b.reason === 'duration-limit', `Native observer stopped unexpectedly: ${b.reason}`);
  assert(b.samples.length > 0, 'No fresh delta sample was observed; repeat only during ordinary authorized native activity.');
  const status = await service.list();
  assert.equal(status.attemptCount, 0);
  report.nativeVersion = preview.native.nativeVersion;
  report.configuredModel = preview.native.model;
  report.outcome = 'native-observer-verified';
} catch (error) { report.outcome = 'failed'; report.error = error.message; process.exitCode = 1; }
finally {
  await service.off({ sessionId: values.session, cwd: values.cwd }); await service.close();
  report.disabledAfterProbe = (await service.list()).policies.every(p => p.enabled === false);
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
