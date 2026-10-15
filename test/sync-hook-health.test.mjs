import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, rm, chmod, symlink, link, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_HEALTH_LIMITS, recordSyncHookHealth, readSyncHookHealth } from '../src/sync-hook-health.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-hook-health-')));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, 'sync-hook-health-codex.json'),
    record: (phase, error, at) => recordSyncHookHealth({ root, provider: 'codex', phase, error, at }) };
}
test('hook health persists bounded content-free errors and matching recovery without creating success-only state', async t => {
  const f = await fixture(t);
  await f.record('sync', undefined, 1000);
  assert.equal((await readSyncHookHealth(f.root)).codex.state, 'missing');
  for (let i = 0; i < HOOK_HEALTH_LIMITS.history + 3; i++) {
    await f.record('origin_recheck', Object.assign(new Error('PRIVATE_ERROR /private/prompt'), { code: 'PRIVATE_CODE' }), 1000 + i);
  }
  let value = (await readSyncHookHealth(f.root)).codex;
  assert.equal(value.errorCount, 19);
  assert.equal(value.history.length, 16);
  assert.equal(value.history[0].at, 1003);
  assert.equal(value.phases.origin_recheck.lastError.code, 'ORIGIN_UNVERIFIED');
  await f.record('origin_bind', undefined, 2000);
  assert.equal((await readSyncHookHealth(f.root)).codex.phases.origin_recheck.recoveredAt, undefined);
  await f.record('origin_recheck', undefined, 2000);
  value = (await readSyncHookHealth(f.root)).codex;
  assert.equal(value.phases.origin_recheck.recoveredAt, 2000);
  assert.equal(value.errorCount, 19);
  assert.doesNotMatch(await readFile(f.path, 'utf8'), /PRIVATE_|private\/prompt/);
  assert.ok((await stat(f.path)).size < HOOK_HEALTH_LIMITS.bytes);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
});
test('hook counters saturate, and unsafe or malformed existing diagnostics are preserved and reported unavailable', async t => {
  const f = await fixture(t);
  await f.record('sync', new Error('private'), 1000);
  const value = JSON.parse(await readFile(f.path, 'utf8'));
  value.errorCount = value.phases.sync.errorCount = HOOK_HEALTH_LIMITS.count;
  await writeFile(f.path, JSON.stringify(value));
  await f.record('sync', new Error('private'), 2000);
  assert.equal((await readSyncHookHealth(f.root)).codex.errorCount, HOOK_HEALTH_LIMITS.count);
  for (const mode of [0o644, 0o666]) {
    await chmod(f.path, mode);
    assert.equal((await readSyncHookHealth(f.root)).codex.state, 'unavailable');
    await assert.rejects(f.record('sync', new Error('private'), 3000));
    assert.equal((await stat(f.path)).mode & 0o777, mode);
  }
  await chmod(f.path, 0o600);
  await writeFile(f.path, 'PRIVATE_MALFORMED');
  await assert.rejects(f.record('sync', new Error('private'), 3000));
  assert.equal((await readSyncHookHealth(f.root)).codex.state, 'unavailable');
  assert.equal(await readFile(f.path, 'utf8'), 'PRIVATE_MALFORMED');
});
test('symlink and hardlink diagnostic aliases never modify their target', async t => {
  const f = await fixture(t), target = join(f.root, 'original');
  await writeFile(target, 'ORIGINAL_PRIVATE_CONTENT', { mode: 0o600 });
  for (const alias of [symlink, link]) {
    await alias(target, f.path);
    await assert.rejects(f.record('mailbox', new Error('private'), 1000));
    assert.equal((await readSyncHookHealth(f.root)).codex.state, 'unavailable');
    assert.equal(await readFile(target, 'utf8'), 'ORIGINAL_PRIVATE_CONTENT');
    await unlink(f.path);
  }
});

test('contended error publication persists an incomplete-count marker without retrying or clearing it on success', async t => {
  const f = await fixture(t);
  await f.record('origin_recheck', new Error('PRIVATE'), 1000);
  const lock = `${f.path}.lock`;
  await writeFile(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { mode: 0o600 });
  await f.record('origin_recheck', Object.assign(new Error('PRIVATE'), { code: 'PRIVATE_CODE' }), 2000);
  await unlink(lock);
  let value = (await readSyncHookHealth(f.root)).codex;
  assert.equal(value.errorCount, 1);
  assert.deepEqual(value.incomplete, { at: 2000, phase: 'origin_recheck', code: 'ORIGIN_UNVERIFIED' });
  await f.record('origin_recheck', undefined, 3000);
  value = (await readSyncHookHealth(f.root)).codex;
  assert.equal(value.phases.origin_recheck.recoveredAt, 3000);
  assert.equal(value.incomplete.at, 2000);
  const marker = join(f.root, 'sync-hook-health-codex-incomplete.json');
  assert.ok((await stat(marker)).size <= 256);
  assert.doesNotMatch(await readFile(marker, 'utf8'), /PRIVATE/);
});
