import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, readFile, writeFile, readdir, symlink, mkdir, link, unlink, rename, utimes, chmod } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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

function mockFsMethod(t, method, replacement) {
  const original = fs[method];
  const mock = t.mock.method(fs, method, (...args) => replacement(original, ...args));
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

for (const stage of ['initial-stat', 'owner-read', 'identity-stat']) {
  test(`lock acquisition retries exclusive creation when the previous owner releases before ${stage}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-released-lock-'));
    const path = join(root, 'operation.lock');
    await writeFile(path, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { mode: 0o600 });
    let reads = 0; let released = false; let entered = 0;
    mockFsMethod(t, stage === 'owner-read' ? 'readFile' : 'lstat', async (original, target, ...args) => {
      if (target === path && ++reads === (stage === 'identity-stat' ? 2 : 1)) {
        await unlink(path);
        released = true;
      }
      return original(target, ...args);
    });
    assert.equal(await withLock(path, async () => { entered++; return 'acquired'; }, { recoverDead: true }), 'acquired');
    assert.equal(released, true);
    assert.equal(entered, 1);
    assert.deepEqual(await readdir(root), []);
  });
}

test('a replacement lock between the owner read and identity check is preserved', async t => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-replaced-lock-'));
  const path = join(root, 'operation.lock');
  const originalBody = JSON.stringify({ pid: exitedPid(), started: new Date().toISOString() });
  const replacementBody = JSON.stringify({ pid: process.pid, started: new Date().toISOString() });
  await writeFile(path, originalBody, { mode: 0o600 });
  let replaced = false; let entered = false;
  mockFsMethod(t, 'readFile', async (original, target, ...args) => {
    const contents = await original(target, ...args);
    if (target === path && !replaced) {
      replaced = true;
      await rename(path, `${path}.previous`);
      await writeFile(path, replacementBody, { mode: 0o600 });
    }
    return contents;
  });
  await assert.rejects(withLock(path, async () => { entered = true; }, { recoverDead: true }), /Lock identity changed/);
  assert.equal(entered, false);
  assert.equal(await readFile(path, 'utf8'), replacementBody);
  assert.equal(await readFile(`${path}.previous`, 'utf8'), originalBody);
  assert.deepEqual((await readdir(root)).sort(), ['operation.lock', 'operation.lock.previous']);
});

for (const stage of ['owner-read', 'identity-stat']) {
  test(`non-absence filesystem errors during ${stage} are not treated as a released lock`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-lock-error-'));
    const path = join(root, 'operation.lock');
    const body = JSON.stringify({ pid: exitedPid(), started: new Date().toISOString() });
    await writeFile(path, body, { mode: 0o600 });
    let calls = 0; let entered = false;
    mockFsMethod(t, stage === 'owner-read' ? 'readFile' : 'lstat', async (original, target, ...args) => {
      if (target === path && ++calls === (stage === 'identity-stat' ? 2 : 1)) {
        throw Object.assign(new Error('Injected permission error'), { code: 'EACCES' });
      }
      return original(target, ...args);
    });
    await assert.rejects(withLock(path, async () => { entered = true; }, { recoverDead: true }), { code: 'EACCES' });
    assert.equal(entered, false);
    assert.equal(await readFile(path, 'utf8'), body);
    assert.deepEqual(await readdir(root), ['operation.lock']);
  });
}

test('a writer paused before publishing its owner keeps a fresh empty lock busy without reclaiming it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-publishing-lock-'));
  const path = join(root, 'operation.lock');
  let publicationReached, finishPublication;
  const publishing = new Promise(resolve => { publicationReached = resolve; });
  const resume = new Promise(resolve => { finishPublication = resolve; });
  let firstOpen = true; let firstEntered = false; let secondEntered = false;
  mockFsMethod(t, 'open', async (original, target, ...args) => {
    const file = await original(target, ...args);
    if (target === path && firstOpen) {
      firstOpen = false;
      const write = file.writeFile.bind(file);
      file.writeFile = async (...values) => { publicationReached(); await resume; return write(...values); };
    }
    return file;
  });
  const first = withLock(path, async () => { firstEntered = true; });
  await publishing;
  const before = await fs.lstat(path);
  t.mock.method(Date, 'now', () => Math.floor(before.mtimeMs) + 10);
  try {
    assert.equal(await readFile(path, 'utf8'), '');
    await assert.rejects(withLock(path, async () => { secondEntered = true; }, { recoverDead: true }), /Another bridge operation.*lock owner publication/);
    const after = await fs.lstat(path);
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, 0);
    assert.equal(firstEntered, false);
    assert.equal(secondEntered, false);
    assert.deepEqual(await readdir(root), ['operation.lock']);
  } finally { finishPublication(); await first; }
  assert.equal(firstEntered, true);
  assert.deepEqual(await readdir(root), []);
});

test('old, future-dated, and nonempty malformed locks never enter the empty publication wait', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-empty-lock-age-'));
  const path = join(root, 'operation.lock');
  for (const [body, age] of [['', 5000], ['', -5000], [' ', 0], ['{"pid":', 0]]) {
    await writeFile(path, body, { mode: 0o600 });
    const at = new Date(Date.now() - age);
    await utimes(path, at, at);
    let entered = false;
    await assert.rejects(withLock(path, async () => { entered = true; }, { recoverDead: true }), /Malformed lock owner/);
    assert.equal(entered, false);
    assert.equal(await readFile(path, 'utf8'), body);
  }
});

for (const change of ['inode', 'contents', 'permissions']) {
  test(`an empty lock whose ${change} change during publication classification is preserved as an error`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'claudex-empty-lock-changed-'));
    const path = join(root, 'operation.lock');
    await writeFile(path, '', { mode: 0o600 });
    let changed = false; let entered = false;
    mockFsMethod(t, 'readFile', async (original, target, ...args) => {
      const contents = await original(target, ...args);
      if (target === path && !changed) {
        changed = true;
        if (change === 'inode') {
          await rename(path, `${path}.previous`);
          await writeFile(path, '', { mode: 0o600 });
        } else if (change === 'contents') await writeFile(path, '{"pid":');
        else await chmod(path, 0o644);
      }
      return contents;
    });
    await assert.rejects(withLock(path, async () => { entered = true; }, { recoverDead: true }), /Lock (?:identity|state) changed/);
    assert.equal(entered, false);
    assert.equal(await readFile(path, 'utf8'), change === 'contents' ? '{"pid":' : '');
    assert.equal((await fs.lstat(path)).mode & 0o777, change === 'permissions' ? 0o644 : 0o600);
    assert.ok((await readdir(root)).includes('operation.lock'));
  });
}
