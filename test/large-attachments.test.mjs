import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { largePng, digest } from './helpers/large-attachments.mjs';
import { encodeContextPacket, decodeContextPacket } from '../src/context-packet.mjs';
import { encodeArchivedContextPacket, loadContextArchive, inspectArchivedContextPacket, decodeArchivedContextPacket } from '../src/context-archive.mjs';
import { captureImageAssets, restoreImageAssets } from '../src/claude-image-assets.mjs';
import { fingerprint } from '../src/history.mjs';
import { exportNativeHistory } from '../src/native-history.mjs';
import { hash } from '../src/storage.mjs';

const image = bytes => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } });
const normalizeContent = content => content;

test('a real greater-than-5-MiB PNG survives signed inline packets, archives, and durable preview restoration', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-large-image-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = largePng(), original = image(bytes), sessionId = randomUUID();
  assert.ok(bytes.length > 5 * 1024 * 1024);
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Keep this large synthetic image intact.' }, original] },
    { role: 'assistant', content: [{ type: 'text', text: 'Synthetic completed fixture response.' }] }];
  const identity = { key: randomBytes(32), conversationId: randomUUID(), targetSessionId: sessionId, sourceSide: 'codex', operationId: 'large-png' };
  const inline = encodeContextPacket({ ...identity, messages });
  const decoded = decodeContextPacket({ ...identity, content: inline });
  assert.equal(fingerprint({ messages: decoded.messages }), fingerprint({ messages }));
  assert.equal(digest(Buffer.from(decoded.messages[0].content[1].source.data, 'base64')), digest(bytes));
  const archived = await encodeArchivedContextPacket({ ...identity, root, messages, maxViewBytes: 1024 });
  assert.equal(digest(Buffer.from(archived.find(block => block.type === 'image').source.data, 'base64')), digest(bytes),
    'the native packet must contain actual image bytes, not only an archive reference');
  const metadata = inspectArchivedContextPacket({ ...identity, content: archived });
  const loaded = await loadContextArchive({ root, archive: metadata.archive });
  const archiveDecoded = decodeArchivedContextPacket({ ...identity, content: archived, resolveArchive: () => loaded });
  assert.equal(archiveDecoded.digest, fingerprint({ messages }));
  assert.equal(digest(Buffer.from(archiveDecoded.messages[0].content[1].source.data, 'base64')), digest(bytes));
  const page = { nextCursor: null, data: [{ id: 'large-turn', status: 'completed', itemsView: 'full', startedAt: 100, completedAt: 101,
    items: [{ type: 'userMessage', id: 'large-input', content: [{ type: 'text', text: 'Large image budget probe' },
      { type: 'image', url: `data:image/png;base64,${original.source.data}`, detail: 'original' }] },
    { type: 'agentMessage', id: 'large-reply', phase: 'final_answer', text: 'Synthetic complete response' }] }] };
  let reads = 0;
  const client = { async request() { reads++; return structuredClone(page); } };
  await assert.rejects(exportNativeHistory({ client, threadId: 'large-thread', cwd: root, limits: { maxBytes: 4 * 1024 * 1024 } }), /byte limit exceeded/);
  assert.equal(reads, 1, 'a byte-budget refusal must not retry or return a partial image');
  reads = 0;
  const exported = await exportNativeHistory({ client, threadId: 'large-thread', cwd: root });
  assert.equal(reads, 2);
  assert.equal(digest(Buffer.from(exported.common.messages[0].content.find(block => block.type === 'image').source.data, 'base64')), digest(bytes));
  const cwd = join(root, 'project'), claudeTempRoot = join(root, 'temporary');
  const images = join(claudeTempRoot, cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId, 'images');
  await mkdir(images, { recursive: true, mode: 0o700 });
  await writeFile(join(images, '1.png'), bytes, { mode: 0o600 });
  const preview = image(Buffer.from('small synthetic persisted preview'));
  const row = { type: 'user', uuid: randomUUID(), sessionId, version: '2.1.281', queueTranscriptOnly: true,
    promptSource: 'sdk', imagePasteIds: [1], message: { role: 'user', content: [preview] } };
  const captured = await captureImageAssets({ root, claudeTempRoot, cwd, sessionId, row, expectedContent: [original],
    expectedHash: hash([original]), normalizeContent });
  const persisted = join(root, 'bindings.json');
  await writeFile(persisted, JSON.stringify({ [row.uuid]: captured.bindings }), { mode: 0o600 });
  const restored = await restoreImageAssets({ root, rows: [row], bindings: JSON.parse(await readFile(persisted, 'utf8')) });
  assert.equal(digest(Buffer.from(restored[0].message.content[0].source.data, 'base64')), digest(bytes));
  assert.deepEqual(row.message.content, [preview]);
  assert.deepEqual(await readFile(join(root, 'image-assets', digest(bytes))), bytes);
  const corrupted = structuredClone(row); corrupted.message.content[0].source.data = Buffer.from('wrong preview').toString('base64');
  await assert.rejects(restoreImageAssets({ root, rows: [corrupted], bindings: { [row.uuid]: captured.bindings } }), /preview changed/);
});
