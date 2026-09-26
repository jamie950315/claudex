import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { zstdCompressSync, crc32 } from 'node:zlib';
import { inspectFolderCache, replaceFolderCacheSource, buildFolderSourceProof } from '../src/claude-folder-cache.mjs';

function fixture() {
  const source = `export const sample=${JSON.stringify(randomBytes(8000).toString('hex'))};`;
  const body = zstdCompressSync(Buffer.from(source));
  const key = Buffer.from('1/0/https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-23-Db0dcGkF.js');
  const header = Buffer.alloc(24);
  header.writeBigUInt64LE(0xfcfb6d1ba7725c30n); header.writeUInt32LE(5, 8); header.writeUInt32LE(key.length, 12);
  const metadata = Buffer.from(`HTTP/1.1 200 OK\0content-length:${body.length}\0x-goog-stored-content-length:${body.length}\0unrelated:preserved\0`);
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
