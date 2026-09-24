import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, symlink, mkdir, link } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishExclusive, writeJSON, privateDirectory, withLock } from '../src/storage.mjs';
import { nativeDrivers } from '../src/native-drivers.mjs';

test('native publication replaces an interrupted private staging write but never an existing session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-publish-test-'));
  const path = join(root, 'new.jsonl');
  await writeFile(`${path}.claudex-next`, '{"partial":');
  await publishExclusive(path, '{"complete":true}\n');
  assert.equal(await readFile(path, 'utf8'), '{"complete":true}\n');
  await assert.rejects(publishExclusive(path, 'different'), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), '{"complete":true}\n');
  assert.deepEqual(await readdir(root), ['new.jsonl']);
});

test('atomic state writes use a bounded staging slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-atomic-test-'));
  const path = join(root, 'state.json');
  await writeFile(`${path}.next`, 'interrupted');
  for (let n = 0; n < 5; n++) await writeJSON(path, { n });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).n, 4);
  assert.deepEqual(await readdir(root), ['state.json']);
});

test('private roots, rollback roots, and staging files reject symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-symlink-test-'));
  const outside = join(root, 'outside');
  await mkdir(outside);
  const link = join(root, 'link');
  await symlink(outside, link);
  await assert.rejects(privateDirectory(link), /symlink/);
  const state = join(root, 'state');
  await mkdir(state);
  await symlink(outside, join(state, 'rollback'));
  await assert.rejects(nativeDrivers({ root: state, codexHome: root, claudeHome: root }), /symlink/);
  const victim = join(outside, 'keep');
  await writeFile(victim, 'unchanged');
  await symlink(victim, join(root, 'state.json.next'));
  await assert.rejects(writeJSON(join(root, 'state.json'), {}));
  assert.equal(await readFile(victim, 'utf8'), 'unchanged');
});

function exitedPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(child.status, 0);
  return child.pid;
}

test('opt-in lock recovery reclaims only a private lock owned by an exited process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-dead-lock-'));
  const path = join(root, 'watch.lock');
  await writeFile(path, JSON.stringify({ pid: exitedPid(), started: new Date().toISOString() }), { mode: 0o600 });
  assert.equal(await withLock(path, async () => 'restarted', { recoverDead: true }), 'restarted');
  assert.deepEqual(await readdir(root), []);
});

test('live, malformed, and externally linked locks are never reclaimed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-preserved-lock-'));
  const path = join(root, 'watch.lock');
  const body = JSON.stringify({ pid: process.pid, started: new Date().toISOString() });
  await writeFile(path, body, { mode: 0o600 });
  await assert.rejects(withLock(path, async () => {}, { recoverDead: true }), /holds the lock/);
  assert.equal(await readFile(path, 'utf8'), body);

  await writeFile(path, '{"pid":0}', { mode: 0o600 });
  await assert.rejects(withLock(path, async () => {}, { recoverDead: true }), /Malformed lock owner/);
  assert.equal(await readFile(path, 'utf8'), '{"pid":0}');

  await writeFile(path, JSON.stringify({ pid: exitedPid(), started: new Date().toISOString() }), { mode: 0o600 });
  await link(path, `${path}.other`);
  await assert.rejects(withLock(path, async () => {}, { recoverDead: true }), /private owned regular file/);
  assert.ok((await readdir(root)).includes('watch.lock'));
});

test('a competing hardlink claim prevents simultaneous stale-lock recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-claimed-lock-'));
  const path = join(root, 'watch.lock');
  await writeFile(path, JSON.stringify({ pid: exitedPid(), started: new Date().toISOString() }), { mode: 0o600 });
  await link(path, `${path}.reclaim`);
  await assert.rejects(withLock(path, async () => {}, { recoverDead: true }), /private owned regular file|recovery is in progress/);
  assert.equal((await readdir(root)).length, 2);
});
