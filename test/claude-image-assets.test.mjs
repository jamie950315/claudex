import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, unlink } from 'node:fs/promises';
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
