import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile, writeFile, lstat, symlink, rename, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ColdVerificationCache, captureVerificationFiles } from '../src/cold-verification-cache.mjs';
import { persistContextArchive, loadContextArchive } from '../src/context-archive.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
const key = Buffer.alloc(32, 7);
const messages = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'done' }] }];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cold-verification-'));
  await chmod(root, 0o700);
  // macOS temporary paths contain a system alias; production roots are canonical.
  const { realpath } = await import('node:fs/promises');
  const canonical = await realpath(root);
  t.after(() => rm(canonical, { recursive: true, force: true }));
  const { archive } = await persistContextArchive({ root: canonical, messages });
  const captured = await captureVerificationFiles(() => loadContextArchive({ root: canonical, archive }));
  const cache = new ColdVerificationCache({ root: canonical, key, now: () => 1000 });
  const data = { signature: { checkpoint: 'unchanged' }, context: { version: 1 }, files: captured.files, verifiedAt: 999 };
  assert.equal(await cache.store(id, data), true);
  return { root: canonical, archive, captured, cache, data, path: join(canonical, 'cold-verification', `${id}.json`) };
}

test('authenticated archive observations survive restart without rereading archive contents', async t => {
  const { root, captured, cache, data, path } = await fixture(t);
  assert.equal(captured.files.length, 4);
  assert.deepEqual(captured.result.messages, messages);
  assert.match(captured.files[0].identity.mtimeNs, /^\d+$/);
  assert.ok(await cache.load(id, data.signature, data.context));
  const restarted = new ColdVerificationCache({ root, key, now: () => 1000 });
  assert.ok(await restarted.load(id, data.signature, data.context));
  const before = await lstat(path, { bigint: true });
  assert.equal(await cache.store(id, { ...data, verifiedAt: 1000 }), true);
  assert.equal((await lstat(path, { bigint: true })).mtimeNs, before.mtimeNs);
});

test('different signature, context, epoch, key and future clock reject cached proofs', async t => {
  const { root, cache, data } = await fixture(t);
  assert.equal(await cache.load(id, {}, data.context), null);
  assert.equal(await cache.load(id, data.signature, {}), null);
  for (const change of [{ epoch: 'new' }, { key: Buffer.alloc(32, 8) }, { now: () => 998 }, { now: () => 2000, maxAgeMs: 10 }]) {
    const candidate = new ColdVerificationCache({ root, key, now: () => 1000, ...change });
    assert.equal(await candidate.load(id, data.signature, data.context), null);
  }
});

test('asset changes and unsafe permissions invalidate proof without modifying assets', async t => {
  const { cache, data } = await fixture(t);
  const asset = data.files[0].path;
  const bytes = await readFile(asset);
  await chmod(asset, 0o644);
  assert.equal(await cache.load(id, data.signature, data.context), null);
  await chmod(asset, 0o600);
  await writeFile(asset, bytes);
  assert.equal(await cache.load(id, data.signature, data.context), null);
});

test('signed tombstone persists invalidation across restarts', async t => {
  const { root, cache, data } = await fixture(t);
  assert.equal(await cache.invalidate(id), true);
  assert.equal(await cache.load(id, data.signature, data.context), null);
  assert.equal(await new ColdVerificationCache({ root, key }).load(id, data.signature, data.context), null);
  assert.equal(await cache.store(id, data), true);
  assert.ok(await cache.load(id, data.signature, data.context));
});

test('successful invalidations coalesce but failed durable writes retry and fresh proofs reset them', async t => {
  const { cache, data, path } = await fixture(t);
  const originalWrite = cache.write.bind(cache);
  let attempts = 0;
  cache.write = async (...args) => { attempts++; return attempts === 1 ? false : originalWrite(...args); };
  assert.equal(await cache.invalidate(id), false);
  assert.equal(await cache.invalidate(id), true);
  const before = await lstat(path, { bigint: true });
  assert.equal(await cache.invalidate(id), true);
  assert.equal(attempts, 2);
  assert.equal((await lstat(path, { bigint: true })).mtimeNs, before.mtimeNs);
  assert.equal(await cache.store(id, data), true);
  assert.ok(await cache.load(id, data.signature, data.context));
  assert.equal(await cache.invalidate(id), true);
  assert.equal(attempts, 4);
});

test('replacing the archive directory invalidates proof even when the same asset inodes are moved back', async t => {
  const { root, cache, data } = await fixture(t);
  const assets = join(root, 'history-assets');
  await rename(assets, `${assets}.old`);
  await mkdir(assets, { mode: 0o700 });
  for (const file of data.files) await rename(file.path.replace(assets, `${assets}.old`), file.path);
  assert.equal(await cache.load(id, data.signature, data.context), null);
});

test('tampered cache, cache symlinks and unsafe IDs are misses', async t => {
  const { root, cache, data, path } = await fixture(t);
  const text = await readFile(path, 'utf8');
  const envelope = JSON.parse(text); envelope.payload.verifiedAt = 998;
  await writeFile(path, JSON.stringify(envelope));
  assert.equal(await cache.load(id, data.signature, data.context), null);
  await rename(path, `${path}.original`);
  await symlink(`${path}.original`, path);
  assert.equal(await cache.load(id, data.signature, data.context), null);
  assert.equal(await cache.load('../outside', data.signature, data.context), null);
  assert.equal(await cache.store('../outside', data), false);
  assert.equal(await cache.store(id, { ...data, files: [{ ...data.files[0], path: join(root, 'outside') }] }), false);
});

test('asset symlinks and failed authenticated reads cannot produce reusable observations', async t => {
  const { root, cache, data, archive } = await fixture(t);
  const asset = data.files[0].path;
  await rename(asset, `${asset}.original`); await symlink(`${asset}.original`, asset);
  assert.equal(await cache.load(id, data.signature, data.context), null);
  await assert.rejects(captureVerificationFiles(() => loadContextArchive({ root, archive })));
});

test('a cache file replaced by a FIFO after inspection is a miss without waiting for a writer', { timeout: 5000 }, async t => {
  const { cache, data, path } = await fixture(t);
  const promises = createRequire(import.meta.url)('node:fs/promises');
  const original = promises.lstat;
  const restore = () => { promises.lstat = original; syncBuiltinESMExports(); };
  t.after(restore);
  // Swap the inspected regular file for a FIFO between lstat() and open().
  promises.lstat = async (target, options) => {
    const stat = await original(target, options);
    if (target === path) {
      restore();
      await rm(path);
      assert.equal(spawnSync('mkfifo', ['-m', '600', path]).status, 0);
    }
    return stat;
  };
  syncBuiltinESMExports();
  assert.equal(await cache.load(id, data.signature, data.context), null);
  assert.ok((await lstat(path)).isFIFO());
});
