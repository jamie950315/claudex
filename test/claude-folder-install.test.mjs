import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, zstdCompressSync } from 'node:zlib';
import { inspectFolderCache, replaceFolderCacheSource, sha256 } from '../src/claude-folder-cache.mjs';
import { ensureClaudeFolderCache, restoreClaudeFolderCache } from '../src/claude-folder-install.mjs';

function cacheFixture() {
  const source = `export const sample=${JSON.stringify(randomBytes(8000).toString('hex'))};`;
  const key = Buffer.from('1/0/https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-19-DDVvTIwQ.js');
  const header = Buffer.alloc(24);
  header.writeBigUInt64LE(0xfcfb6d1ba7725c30n); header.writeUInt32LE(5, 8); header.writeUInt32LE(key.length, 12);
  const body = zstdCompressSync(Buffer.from(source));
  const metadata = Buffer.from(`HTTP/1.1 200 OK\0content-length:${body.length}\0x-goog-stored-content-length:${body.length}\0unrelated:preserved\0`);
  const footer = (flags, data, size) => {
    const bytes = Buffer.alloc(24); bytes.writeBigUInt64LE(0xf4fa6f45970d41d8n);
    bytes.writeUInt32LE(flags, 8); bytes.writeUInt32LE(crc32(data), 12); bytes.writeBigUInt64LE(BigInt(size), 16); return bytes;
  };
  return { source, bytes: Buffer.concat([header, key, body, footer(1, body, 0), metadata,
    createHash('sha256').update(key).digest(), footer(3, metadata, metadata.length)]) };
}

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-folder-install-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'state'), cacheDir = join(base, 'Cache'), cachePath = join(cacheDir, 'resource_0');
  await Promise.all([root, cacheDir].map(path => mkdir(path, { mode: 0o700 })));
  const { source, bytes } = cacheFixture();
  await writeFile(cachePath, bytes, { mode: 0o600 });
  const privatePath = join(root, 'ui-folder-compat');
  const deps = {
    sourceHash: sha256(Buffer.from(source)),
    buildCandidate: ({ original }) => replaceFolderCacheSource(original, inspectFolderCache(original).source.replace('sample=', 'patchedA=')),
  };
  return { base, root, cacheDir, cachePath, privatePath, source, bytes, deps,
    options: { root, cachePath }, backupPath: join(privatePath, 'original.cache'), manifestPath: join(privatePath, 'manifest.json') };
}

const manifest = async f => JSON.parse(await readFile(f.manifestPath, 'utf8'));
const identity = info => ({ ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs });

test('installation, exact no-op, upgrades, and restore retain one immutable original', async t => {
  const f = await fixture(t);
  assert.equal((await ensureClaudeFolderCache(f.options, f.deps)).changed, true);
  const first = await readFile(f.cachePath), saved = await manifest(f);
  assert.equal(inspectFolderCache(first).source, f.source.replace('sample=', 'patchedA='));
  assert.deepEqual(await readFile(f.backupPath), f.bytes);
  assert.equal(saved.phase, 'installed'); assert.equal(saved.action, 'install');
  const backupInfo = identity(await lstat(f.backupPath, { bigint: true }));
  const currentInfo = identity(await lstat(f.cachePath, { bigint: true }));
  const manifestInfo = identity(await lstat(f.manifestPath, { bigint: true }));
  assert.equal((await ensureClaudeFolderCache(f.options, f.deps)).changed, false);
  assert.deepEqual(identity(await lstat(f.cachePath, { bigint: true })), currentInfo);
  assert.deepEqual(identity(await lstat(f.manifestPath, { bigint: true })), manifestInfo);
  const updated = { ...f.deps, buildCandidate: ({ original }) => replaceFolderCacheSource(original,
    inspectFolderCache(original).source.replace('sample=', 'patchedB=')) };
  assert.equal((await ensureClaudeFolderCache(f.options, updated)).changed, true);
  assert.equal(inspectFolderCache(await readFile(f.cachePath)).source, f.source.replace('sample=', 'patchedB='));
  assert.equal((await restoreClaudeFolderCache(f.options, f.deps)).changed, true);
  assert.deepEqual(await readFile(f.cachePath), f.bytes);
  assert.equal((await restoreClaudeFolderCache(f.options, f.deps)).changed, false);
  assert.equal((await ensureClaudeFolderCache(f.options, updated)).changed, true);
  assert.deepEqual(identity(await lstat(f.backupPath, { bigint: true })), backupInfo);
  assert.deepEqual((await readdir(f.privatePath)).sort(), ['manifest.json', 'original.cache']);
  assert.deepEqual(await readdir(f.cacheDir), ['resource_0']);
});

test('prepared recovery handles interruption before and after native cache publication without a second backup', async t => {
  for (const hook of ['beforeReplace', 'afterReplace']) {
    const f = await fixture(t);
    await assert.rejects(ensureClaudeFolderCache(f.options, { ...f.deps, [hook]: () => { throw new Error('simulated interruption'); } }),
      /simulated interruption/);
    assert.equal((await manifest(f)).phase, 'prepared');
    const backupInfo = identity(await lstat(f.backupPath, { bigint: true }));
    const result = await ensureClaudeFolderCache(f.options, f.deps);
    assert.equal(result.recovered, true);
    assert.equal(result.changed, hook === 'beforeReplace');
    assert.deepEqual(identity(await lstat(f.backupPath, { bigint: true })), backupInfo);
    assert.equal((await manifest(f)).phase, 'installed');
    await assert.rejects(restoreClaudeFolderCache(f.options, { ...f.deps, afterReplace: () => { throw new Error('restore interruption'); } }),
      /restore interruption/);
    const restored = await restoreClaudeFolderCache(f.options, f.deps);
    assert.equal(restored.recovered, true); assert.equal(restored.changed, false);
    assert.deepEqual(await readFile(f.cachePath), f.bytes);
  }
});

test('an exclusive original left before its first manifest is adopted only when it matches the current original', async t => {
  const f = await fixture(t);
  await mkdir(f.privatePath, { mode: 0o700 });
  await copyFile(f.cachePath, f.backupPath);
  const backupInfo = identity(await lstat(f.backupPath, { bigint: true }));
  await ensureClaudeFolderCache(f.options, f.deps);
  assert.deepEqual(identity(await lstat(f.backupPath, { bigint: true })), backupInfo);
});

test('restore can supersede an interrupted upgrade and recover its own pre-publication interruption', async t => {
  const f = await fixture(t);
  await ensureClaudeFolderCache(f.options, f.deps);
  const originalPatch = await readFile(f.cachePath);
  const interrupted = () => { throw new Error('before publication'); };
  await assert.rejects(ensureClaudeFolderCache(f.options, { ...f.deps,
    buildCandidate: ({ original }) => replaceFolderCacheSource(original, f.source.replace('sample=', 'patchedB=')),
    beforeReplace: interrupted }), /before publication/);
  assert.equal((await manifest(f)).previousPatchedHash, sha256(originalPatch));
  await assert.rejects(restoreClaudeFolderCache(f.options, { ...f.deps, beforeReplace: interrupted }), /before publication/);
  assert.equal((await manifest(f)).patchedHash, sha256(originalPatch));
  const result = await restoreClaudeFolderCache(f.options, f.deps);
  assert.equal(result.changed, true); assert.equal(result.recovered, true);
  assert.deepEqual(await readFile(f.cachePath), f.bytes);
});

test('foreign valid cache updates and pre-publication races are preserved, never restored over', async t => {
  const f = await fixture(t);
  await ensureClaudeFolderCache(f.options, f.deps);
  const outside = replaceFolderCacheSource(f.bytes, f.source.replace('sample=', 'foreignX='));
  await writeFile(f.cachePath, outside);
  for (const operation of [ensureClaudeFolderCache, restoreClaudeFolderCache])
    await assert.rejects(operation(f.options, f.deps), /changed outside/);
  assert.deepEqual(await readFile(f.cachePath), outside);
  const g = await fixture(t);
  await assert.rejects(ensureClaudeFolderCache(g.options, { ...g.deps, beforeReplace: async () => {
    const replacement = join(g.cacheDir, 'external');
    await writeFile(replacement, g.bytes, { mode: 0o600 });
    await rename(replacement, g.cachePath);
  } }), /changed before publication/);
  assert.deepEqual(await readFile(g.cachePath), g.bytes);
  assert.equal((await manifest(g)).phase, 'prepared');
});

test('cache symlinks, hard links, unsafe modes and parent aliases fail without touching their targets', async t => {
  for (const kind of ['symlink', 'hardlink', 'mode', 'parent']) {
    const f = await fixture(t), outside = join(f.base, 'outside');
    let options = f.options;
    if (kind === 'symlink') { await rename(f.cachePath, outside); await symlink(outside, f.cachePath); }
    if (kind === 'hardlink') await link(f.cachePath, outside);
    if (kind === 'mode') await chmod(f.cachePath, 0o644);
    if (kind === 'parent') { const alias = join(f.base, 'alias'); await symlink(f.cacheDir, alias); options = { ...options, cachePath: join(alias, 'resource_0') }; }
    await assert.rejects(ensureClaudeFolderCache(options, f.deps), /private|canonical/);
    assert.deepEqual(await readFile(f.cachePath), f.bytes);
    await assert.rejects(lstat(f.backupPath), { code: 'ENOENT' });
  }
});

test('backup and manifest tampering, unknown source versions, and interrupted unjournaled staging fail closed', async t => {
  for (const kind of ['backup', 'binding', 'manifest-link', 'staging']) {
    const f = await fixture(t);
    await ensureClaudeFolderCache(f.options, f.deps);
    const current = await readFile(f.cachePath);
    if (kind === 'backup') { const altered = Buffer.from(f.bytes); altered[40] ^= 1; await writeFile(f.backupPath, altered); }
    if (kind === 'binding') { const value = await manifest(f); value.cachePath += '-another'; await writeFile(f.manifestPath, JSON.stringify(value)); }
    if (kind === 'manifest-link') { const elsewhere = join(f.base, 'manifest'); await rename(f.manifestPath, elsewhere); await symlink(elsewhere, f.manifestPath); }
    if (kind === 'staging') await writeFile(join(f.privatePath, '.manifest-interrupted.tmp'), '{}', { mode: 0o600 });
    await assert.rejects(restoreClaudeFolderCache(f.options, f.deps), /backup|manifest|private|interrupted/);
    assert.deepEqual(await readFile(f.cachePath), current);
  }
  const f = await fixture(t);
  await assert.rejects(ensureClaudeFolderCache(f.options), /unvalidated frontend/);
  assert.deepEqual(await readFile(f.cachePath), f.bytes);
  await assert.rejects(lstat(f.backupPath), { code: 'ENOENT' });
});
