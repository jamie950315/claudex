import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, unlink, chmod, lstat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { hash } from '../src/storage.mjs';
import { captureImageAssets, restoreImageAssets } from '../src/claude-image-assets.mjs';

const normalizeContent = content => content.map(block => block.type === 'image'
  ? { type: 'image', source: { type: block.source?.type, media_type: block.source?.media_type, data: block.source?.data } }
  : block.type === 'text' ? { type: 'text', text: block.text } : block);
const image = bytes => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'claudex-image-assets-'));
  const claudeTempRoot = join(root, 'claude-cache');
  const cwd = join(root, 'project');
  const sessionId = randomUUID();
  const original = Buffer.from('synthetic original PNG bytes');
  const preview = Buffer.from('synthetic rendered preview bytes');
  const expectedContent = [{ type: 'text', text: 'One image' }, image(original)];
  const row = { type: 'user', uuid: randomUUID(), sessionId, version: '2.1.281',
    queueTranscriptOnly: true, promptSource: 'sdk', imagePasteIds: [1],
    message: { role: 'user', content: [{ type: 'text', text: 'One image' }, image(preview)] } };
  const images = join(claudeTempRoot, resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'), sessionId, 'images');
  await mkdir(images, { recursive: true, mode: 0o700 });
  await writeFile(join(images, '1.png'), original, { mode: 0o600 });
  const options = { root, claudeTempRoot, cwd, sessionId, row, expectedContent,
    expectedHash: hash(normalizeContent(expectedContent)), normalizeContent };
  return { ...options, original, preview };
}

test('capture binds the exact native preview to original cache bytes and restores without changing raw row', async () => {
  const f = await fixture();
  const captured = await captureImageAssets(f);
  const assetHash = digest(f.original);
  assert.deepEqual(captured.row.message.content, f.expectedContent);
  assert.deepEqual(captured.bindings, { 1: { assetHash, mediaType: 'image/png',
    renderedHash: hash(normalizeContent([f.row.message.content[1]])[0]) } });
  assert.deepEqual(f.row.message.content[1], image(f.preview));
  assert.deepEqual(await readFile(join(f.root, 'image-assets', assetHash)), f.original);
  assert.deepEqual(await restoreImageAssets({ root: f.root, rows: [f.row], bindings: { [f.row.uuid]: captured.bindings } }), [captured.row]);
  const unbound = [f.row];
  assert.equal(await restoreImageAssets({ root: f.root, rows: unbound, bindings: {} }), unbound);
});

test('the observed 0755 native project is hardened without changing its inode or image bytes', async () => {
  const f = await fixture();
  const project = join(f.claudeTempRoot, resolve(f.cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  await chmod(project, 0o755);
  const before = await lstat(project);
  const captured = await captureImageAssets(f);
  const after = await lstat(project);
  assert.equal(after.mode & 0o777, 0o700);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.deepEqual(captured.row.message.content, f.expectedContent);
  assert.deepEqual(await readFile(join(project, f.sessionId, 'images', '1.png')), f.original);
  assert.deepEqual((await captureImageAssets(f)).bindings, captured.bindings);
});

test('native project hardening refuses public cache roots, writable projects and symlink aliases', async () => {
  const f = await fixture();
  const project = join(f.claudeTempRoot, resolve(f.cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  await chmod(project, 0o755);
  await chmod(f.claudeTempRoot, 0o755);
  await assert.rejects(captureImageAssets(f), /private owned directory/);
  assert.equal((await lstat(project)).mode & 0o777, 0o755);
  await chmod(f.claudeTempRoot, 0o700);
  for (const mode of [0o750, 0o777, 0o2755]) {
    await chmod(project, mode);
    await assert.rejects(captureImageAssets(f), /private owned directory/);
    assert.equal((await lstat(project)).mode & 0o7777, mode);
  }
  await chmod(project, 0o755);
  const original = project + '-original';
  await rename(project, original);
  await symlink(original, project);
  await assert.rejects(captureImageAssets(f), /private owned directory/);
  assert.equal((await lstat(original)).mode & 0o777, 0o755);
});

test('the observed large PNG-to-JPEG preview restores exact PNG bytes and media type under its original paste identity', async () => {
  const f = await fixture();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvXcAAAAASUVORK5CYII=', 'base64');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
  const expectedContent = [{ type: 'text', text: 'One image' }, image(png)];
  const preview = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } };
  const row = { ...f.row, message: { role: 'user', content: [expectedContent[0], preview] } };
  const path = join(f.claudeTempRoot, resolve(f.cwd).replace(/[^a-zA-Z0-9]/g, '-'), f.sessionId, 'images', '1.png');
  await writeFile(path, png);
  const input = { ...f, row, expectedContent, expectedHash: hash(expectedContent) };
  const captured = await captureImageAssets(input);
  assert.equal(captured.bindings[1].mediaType, 'image/png');
  assert.equal(captured.bindings[1].renderedMediaType, 'image/jpeg');
  const bindings = { [row.uuid]: captured.bindings };
  const restored = await restoreImageAssets({ root: f.root, rows: [row], bindings });
  assert.deepEqual(restored[0].message.content, expectedContent);
  assert.equal(row.message.content[1].source.media_type, 'image/jpeg');
  for (const media_type of ['image/gif', 'image/webp']) {
    const changed = structuredClone(row); changed.message.content[1].source.media_type = media_type;
    await assert.rejects(captureImageAssets({ ...input, row: changed }), /preview type differs/);
    const saved = structuredClone(bindings); saved[row.uuid][1].renderedMediaType = media_type;
    await assert.rejects(restoreImageAssets({ root: f.root, rows: [row], bindings: saved }), /conversion binding/);
  }
  for (const renderedMediaType of [null, '', 'image/png', undefined]) {
    const saved = structuredClone(bindings); saved[row.uuid][1].renderedMediaType = renderedMediaType;
    await assert.rejects(restoreImageAssets({ root: f.root, rows: [row], bindings: saved }), /conversion binding/);
  }
  const malformed = structuredClone(row); malformed.message.content[1].source.data = Buffer.from('not JPEG bytes').toString('base64');
  await assert.rejects(captureImageAssets({ ...input, row: malformed }), /signatures/);
  await writeFile(path, f.original);
  const malformedOriginal = { ...f, row };
  await assert.rejects(captureImageAssets(malformedOriginal), /signatures/);
  await assert.rejects(captureImageAssets({ ...input, row: { ...row, imagePasteIds: [2] } }), /missing/);
});

test('changed text, wrong cache bytes, or unverified provenance cannot be captured', async () => {
  const f = await fixture();
  await assert.rejects(captureImageAssets({ ...f, row: { ...f.row,
    message: { ...f.row.message, content: [{ type: 'text', text: 'Changed' }, image(f.preview)] } } }), /nonimage content/);
  await writeFile(join(f.claudeTempRoot, resolve(f.cwd).replace(/[^a-zA-Z0-9]/g, '-'), f.sessionId, 'images', '1.png'), Buffer.from('wrong'));
  await assert.rejects(captureImageAssets(f), /differs from the durable intent/);
  await assert.rejects(captureImageAssets({ ...f, row: { ...f.row, queueTranscriptOnly: false } }), /provenance/);
  await assert.rejects(captureImageAssets({ ...f, expectedHash: '0'.repeat(64) }), /expected owner append/);
});

test('warn policy accepts future native version tags but still requires exact image provenance and bytes', async () => {
  const f = await fixture();
  f.row.version = '2.2.1';
  await assert.rejects(captureImageAssets(f), /provenance/);
  const warn = { ...f, versionPolicy: 'warn' };
  const captured = await captureImageAssets(warn);
  assert.deepEqual(captured.row.message.content, f.expectedContent);
  await assert.rejects(captureImageAssets({ ...warn, row: { ...f.row, promptSource: 'user' } }), /provenance/);
  await assert.rejects(captureImageAssets({ ...warn, row: { ...f.row, queueTranscriptOnly: false } }), /provenance/);
  await assert.rejects(captureImageAssets({ ...warn, row: { ...f.row, version: '' } }), /provenance/);
  await assert.rejects(captureImageAssets({ ...warn, row: { ...f.row,
    message: { ...f.row.message, content: [{ type: 'text', text: 'Changed' }, image(f.preview)] } } }), /nonimage content/);
});

test('paste identities and private cache paths are mandatory', async () => {
  const f = await fixture();
  await assert.rejects(captureImageAssets({ ...f, row: { ...f.row, imagePasteIds: [] } }), /paste identities/);
  const path = join(f.claudeTempRoot, resolve(f.cwd).replace(/[^a-zA-Z0-9]/g, '-'), f.sessionId, 'images', '1.png');
  await unlink(path);
  await symlink(join(f.root, 'outside.png'), path);
  await assert.rejects(captureImageAssets(f), /private owned regular file/);
});

test('restoration rejects a changed preview or missing and linked original asset', async () => {
  const f = await fixture();
  const captured = await captureImageAssets(f);
  const bindings = { [f.row.uuid]: captured.bindings };
  const changed = { ...f.row, message: { ...f.row.message,
    content: [{ type: 'text', text: 'One image' }, image(Buffer.from('different preview'))] } };
  await assert.rejects(restoreImageAssets({ root: f.root, rows: [changed], bindings }), /preview changed/);
  const path = join(f.root, 'image-assets', digest(f.original));
  await unlink(path);
  await assert.rejects(restoreImageAssets({ root: f.root, rows: [f.row], bindings }), /ENOENT/);
  await symlink(join(f.root, 'outside.png'), path);
  await assert.rejects(restoreImageAssets({ root: f.root, rows: [f.row], bindings }), /private owned regular file/);
});
