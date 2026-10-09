import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { zstdCompressSync, crc32 } from 'node:zlib';
import { inspectFolderCache, replaceFolderCacheSource, buildFolderSourceProof, FOLDER_TARGET_URL,
  MAX_CLAUDE_CACHE_BYTES, MAX_CLAUDE_SOURCE_BYTES } from '../src/claude-folder-cache.mjs';

function fixture(source = `export const sample=${JSON.stringify(randomBytes(8000).toString('hex'))};`, { pickle = false, flags = 0x82476d03 } = {}) {
  const body = zstdCompressSync(Buffer.from(source));
  const key = Buffer.from(`1/0/${FOLDER_TARGET_URL}`);
  const header = Buffer.alloc(24);
  header.writeBigUInt64LE(0xfcfb6d1ba7725c30n); header.writeUInt32LE(5, 8); header.writeUInt32LE(key.length, 12);
  const headers = Buffer.from(`HTTP/1.1 200 OK\0content-length:${body.length}\0x-goog-stored-content-length:${body.length}\0unrelated:preserved\0${pickle ? '\0' : ''}`);
  let metadata = headers;
  if (pickle) {
    const prefix = Buffer.alloc(40); prefix.writeUInt32LE(flags, 4); prefix.writeUInt32LE(6, 8);
    for (const at of [12, 20, 28]) prefix.writeBigInt64LE(11644473600000000n + 1000000n, at);
    prefix.writeUInt32LE(headers.length, 36);
    metadata = Buffer.concat([prefix, headers, Buffer.alloc((4 - headers.length % 4) % 4), Buffer.from('opaque-native-tail')]);
    metadata = Buffer.concat([metadata, Buffer.alloc((4 - metadata.length % 4) % 4)]);
    metadata.writeUInt32LE(metadata.length - 4);
  }
  const footer = (flags, data, size) => {
    const b = Buffer.alloc(24); b.writeBigUInt64LE(0xf4fa6f45970d41d8n);
    b.writeUInt32LE(flags, 8); b.writeUInt32LE(crc32(data), 12); b.writeBigUInt64LE(BigInt(size), 16); return b;
  };
  return { source, bytes: Buffer.concat([header, key, body, footer(1, body, 0), metadata,
    createHash('sha256').update(key).digest(), footer(3, metadata, metadata.length)]) };
}

test('cache replacement preserves the resource identity and unrelated metadata with valid stream checksums', () => {
  const f = fixture(), before = inspectFolderCache(f.bytes);
  const source = f.source.replace('sample=', 'modified=');
  const result = replaceFolderCacheSource(f.bytes, source);
  assert.equal(inspectFolderCache(result).source, source);
  assert.ok(result.subarray(0, before.start).equals(f.bytes.subarray(0, before.start)));
  assert.ok(result.includes(Buffer.from('unrelated:preserved\0')));
  assert.equal(inspectFolderCache(f.bytes).source, f.source);
});

test('malformed headers, stream corruption and unknown source versions fail closed', () => {
  const f = fixture(), entry = inspectFolderCache(f.bytes);
  for (const at of [0, 8, entry.start + 10, f.bytes.length - 1]) {
    const copy = Buffer.from(f.bytes); copy[at] ^= 1;
    assert.throws(() => inspectFolderCache(copy), /Claude folder resource/);
  }
  assert.throws(() => buildFolderSourceProof(f.source, {}), /unvalidated frontend source/);
});

test('decoded sources above the former limit roundtrip within the finite 4 MiB bound', () => {
  const f = fixture('//' + 'x'.repeat(MAX_CLAUDE_SOURCE_BYTES - 2));
  assert.equal(inspectFolderCache(f.bytes).decoded.length, MAX_CLAUDE_SOURCE_BYTES);
  const modified = '//' + 'y'.repeat(MAX_CLAUDE_SOURCE_BYTES - 2);
  assert.equal(inspectFolderCache(replaceFolderCacheSource(f.bytes, modified)).source, modified);
  assert.throws(() => inspectFolderCache(fixture(f.source + 'x').bytes), { code: 'ERR_BUFFER_TOO_LARGE' });
  assert.throws(() => replaceFolderCacheSource(f.bytes, modified + 'y'), /patched source exceeds its bound/);
  assert.throws(() => inspectFolderCache(Buffer.alloc(MAX_CLAUDE_CACHE_BYTES + 1)), /invalid cache entry size/);
});

test('native HTTP header length changes preserve aligned pickle times, opaque tail and resource checksums', () => {
  const f = fixture(undefined, { pickle: true }), before = inspectFolderCache(f.bytes);
  const short = 'export const sample=1;', result = replaceFolderCacheSource(f.bytes, short), after = inspectFolderCache(result);
  assert.equal(after.source, short);
  assert.notEqual(String(before.body.length).length, String(after.body.length).length);
  const tailOf = m => m.subarray(40 + Math.ceil(m.readUInt32LE(36) / 4) * 4);
  for (const entry of [after, inspectFolderCache(replaceFolderCacheSource(result, f.source))]) {
    const m = entry.metadata, size = m.readUInt32LE(36);
    assert.equal(m.readUInt32LE(0), m.length - 4);
    assert.deepEqual(m.subarray(4, 36), before.metadata.subarray(4, 36));
    assert.deepEqual(tailOf(m), tailOf(before.metadata));
    assert.ok(m.subarray(40, 40 + size).includes(Buffer.from(`\0content-length:${entry.body.length}\0`)));
    assert.ok(m.includes(Buffer.from('unrelated:preserved\0')));
  }
  assert.equal(inspectFolderCache(f.bytes).source, f.source);
  assert.throws(() => replaceFolderCacheSource(fixture(f.source).bytes, short), /unsupported HTTP metadata/);
  assert.throws(() => replaceFolderCacheSource(fixture(f.source, { pickle: true, flags: 0x82476c03 }).bytes, short), /unsupported HTTP metadata/);
});
