import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { encodeArchivedContextPacket, inspectArchivedContextPacket, decodeArchivedContextPacket,
  loadContextArchive, hasProjectedImages } from '../src/context-archive.mjs';
import { prepareArchiveResolver } from '../src/context-packet-reader.mjs';
import { encodeContextPacket } from '../src/context-packet.mjs';
import { decodeCompletedOwnedClaudeHistory } from '../src/owned-claude-history.mjs';
import { encodeClaude } from '../src/claude.mjs';
import { fingerprint } from '../src/history.mjs';

const image = (text, mime = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mime, data: Buffer.from(text).toString('base64') } });
const originalImage = image('first exact image bytes');
const pair = label => [{ role: 'user', content: [{ type: 'text', text: `Question ${label}` }] },
  { role: 'assistant', content: [{ type: 'text', text: `Answer ${label}` }] }];
const imagePair = () => [{ role: 'user', content: [{ type: 'text', text: 'Original visual input' }, originalImage] },
  { role: 'assistant', content: [{ type: 'text', text: 'Original complete answer' }] }];
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-archive-images-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = { conversationId: randomUUID(), targetSessionId: randomUUID(), sourceSide: 'codex', operationId: 'first', key: Buffer.alloc(32, 23) };
  return { root, identity, async encode(messages, options = {}) {
    return encodeArchivedContextPacket({ ...identity, root, messages, ...options });
  }, async loaded(content) {
    const metadata = inspectArchivedContextPacket({ ...identity, content });
    return loadContextArchive({ root, archive: metadata.archive });
  } };
}

function resign(content, key) {
  const prefix = '[Claudex context packet v2]\n';
  const { signature: ignored, ...metadata } = JSON.parse(content.at(-1).text.slice(prefix.length));
  const signature = createHmac('sha256', key).update(JSON.stringify(ordered({ metadata, content: content.slice(0, -1) }))).digest('hex');
  content.at(-1).text = prefix + JSON.stringify({ ...metadata, signature });
  return content;
}

test('archive packets expose exact native images with deterministic role and source-index labels', async t => {
  const f = await fixture(t), second = image('second image bytes'), third = image('jpeg image bytes', 'image/jpeg');
  const source = [imagePair()[0],
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', input: { inert: image('not a visual input') } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'result' }, second, third], is_error: false }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Complete' }, image('assistant image bytes', 'image/webp')] }];
  const untouched = structuredClone(source), content = await f.encode(source, { maxViewBytes: 1024 });
  assert.deepEqual(source, untouched);
  assert.deepEqual(content.filter(block => block.type === 'image'), [originalImage, second, third, source[3].content[1]]);
  assert.match(content[2].text, /Imported user image; source message 0, block 1;/);
  assert.match(content[4].text, /source message 2, block 0, tool_result content 1;/);
  assert.match(content[6].text, /source message 2, block 0, tool_result content 2;/);
  assert.match(content[8].text, /Imported assistant image; source message 3, block 1;/);
  assert.ok(Buffer.byteLength(content[1].text) <= 1024);
  const decoded = decodeArchivedContextPacket({ ...f.identity, content, resolveArchive: () => untouched });
  assert.deepEqual(decoded.messages, source);
  assert.equal(decoded.imageProjectionVersion, 1);
});

test('legacy image recovery is byte-compatible and image-free packets remain the original three-text format', async t => {
  const f = await fixture(t), source = imagePair();
  const legacy = await f.encode(source, { imageProjectionVersion: 0 });
  assert.equal(legacy.length, 3);
  assert.ok(legacy.every(block => block.type === 'text'));
  assert.equal(Object.hasOwn(inspectArchivedContextPacket({ ...f.identity, content: legacy }), 'imageProjectionVersion'), false);
  assert.deepEqual(await f.encode(source, { imageProjectionVersion: 0 }), legacy);
  assert.deepEqual(decodeArchivedContextPacket({ ...f.identity, content: legacy, resolveArchive: () => source }).messages, source);
  assert.deepEqual(await f.encode(pair('no image')), await f.encode(pair('no image'), { imageProjectionVersion: 0 }));
  assert.equal((await f.encode(pair('no image'))).length, 3);
});

test('arbitrary tool JSON and malformed tool-result shapes cannot become visual inputs', async t => {
  const f = await fixture(t);
  for (const block of [
    { type: 'tool_use', id: 'tool-1', input: { image: originalImage } },
    { type: 'tool_result', tool_use_id: 'tool-1', content: { image: originalImage } },
    { type: 'tool_result', content: [originalImage] },
    { type: 'tool_result', tool_use_id: 'tool-1', id: 'different', content: [originalImage] },
    { type: 'tool_result', tool_use_id: 'tool-1', content: [originalImage, { type: 'unknown', image: originalImage }] },
  ]) {
    const source = [{ role: 'user', content: [block] }];
    assert.equal(hasProjectedImages(source), false);
    assert.equal((await f.encode(source)).length, 3);
  }
  assert.equal(hasProjectedImages(imagePair()), true);
  assert.equal(hasProjectedImages([{ role: 'user', content: [{ type: 'tool_result', id: 'native-result', content: [originalImage] }] }]), true);
});

test('image bytes, MIME, order and labels are HMAC-bound before archive access and exact archive-bound after it', async t => {
  const f = await fixture(t), source = imagePair();
  source[0].content.push(image('second image', 'image/jpeg'));
  const original = await f.encode(source), loaded = await f.loaded(original);
  for (const mutate of [
    content => { content[3].source.data = Buffer.from('changed bytes').toString('base64'); },
    content => { content[3].source.media_type = 'image/webp'; },
    content => { [content[3], content[5]] = [content[5], content[3]]; },
    content => { content[2].text += ' forged label'; },
    content => { content.splice(2, 2); },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    let accesses = 0;
    assert.throws(() => decodeArchivedContextPacket({ ...f.identity, content: changed, resolveArchive() { accesses++; return loaded; } }), /signature/);
    assert.equal(accesses, 0);
    resign(changed, f.identity.key);
    assert.throws(() => decodeArchivedContextPacket({ ...f.identity, content: changed, resolveArchive() { accesses++; return loaded; } }), /image projection differs/);
    assert.equal(accesses, 1);
  }
});

test('native image byte bounds refuse the complete packet instead of truncating or omitting pictures', async t => {
  const f = await fixture(t), source = [{ role: 'user', content: [image('large'.repeat(3000))] }];
  await assert.rejects(f.encode(source, { maxViewBytes: 1024, maxNativeBytes: 4096 }), /native packet byte limit exceeded/);
  const content = await f.encode(source, { maxViewBytes: 1024 });
  assert.equal(content.find(block => block.type === 'image').source.data, source[0].content[0].source.data);
  for (const options of [{ imageProjectionVersion: 2 }, { maxNativeBytes: Infinity }, { historyPrefixCount: 0 },
    { imageProjectionVersion: 0, historyPrefixCount: 1, previousDigest: fingerprint({ messages: source }) }])
    await assert.rejects(f.encode(source, options), /projection version|byte limit|refresh prefix/);
});

test('an authenticated full-checkpoint image refresh keeps the same history once and accepts a later ordinary delta', async t => {
  const f = await fixture(t), original = imagePair(), local = pair('real local continuation'), full = [...original, ...local];
  const bootstrap = await f.encode(original, { imageProjectionVersion: 0, previousDigest: null });
  const refresh = await f.encode(full, { operationId: 'image-refresh', previousDigest: fingerprint({ messages: full }), historyPrefixCount: full.length });
  const delta = encodeContextPacket({ ...f.identity, messages: pair('next imported delta'), operationId: 'next-delta', previousDigest: fingerprint({ messages: full }) });
  const resolveArchive = await prepareArchiveResolver({ ...f.identity, root: f.root, contents: [bootstrap, refresh] });
  const meta = { id: f.identity.targetSessionId, cwd: f.root, timestamp: '2026-09-26T05:00:00Z' };
  const nativeMessages = [{ role: 'user', content: bootstrap }, ...local, { role: 'user', content: refresh }];
  const read = messages => decodeCompletedOwnedClaudeHistory({ ...f.identity, sessionId: f.identity.targetSessionId, resolveArchive,
    text: encodeClaude({ meta, messages }, f.identity.targetSessionId).text });
  const repaired = read(nativeMessages);
  assert.equal(repaired.common.messages.length, full.length);
  assert.equal(repaired.digest, fingerprint({ messages: full }));
  assert.equal(repaired.importedPackets, 2);
  assert.equal(refresh.filter(block => block.type === 'image').length, 1);
  const rows = encodeClaude({ meta, messages: nativeMessages }, f.identity.targetSessionId).rows;
  const parent = rows.filter(row => row.type === 'user').at(-1);
  Object.assign(parent, { version: '2.1.281', promptSource: 'sdk', queueTranscriptOnly: true,
    promptId: 'refresh-image-prompt', imagePasteIds: [1] });
  rows.push({ type: 'user', uuid: randomUUID(), parentUuid: parent.uuid, sessionId: f.identity.targetSessionId,
    cwd: f.root, timestamp: parent.timestamp, version: '2.1.281', isMeta: true, promptId: parent.promptId,
    message: { role: 'user', content: [{ type: 'text', text: `[Image: source: /private/tmp/claude-501/${f.root.replace(/[^a-zA-Z0-9]/g, '-')}/${f.identity.targetSessionId}/images/1.png]` }] } });
  const annotated = decodeCompletedOwnedClaudeHistory({ ...f.identity, sessionId: f.identity.targetSessionId, resolveArchive,
    text: rows.map(row => JSON.stringify(row)).join('\n') + '\n' });
  assert.equal(annotated.incompleteTail, false);
  assert.equal(annotated.digest, repaired.digest);
  assert.equal(annotated.common.messages.length, full.length);
  const continued = read([...nativeMessages, { role: 'user', content: delta }]);
  assert.equal(continued.common.messages.length, full.length + 2);
  assert.equal(continued.digest, fingerprint({ messages: [...full, ...pair('next imported delta')] }));
  assert.equal(continued.importedPackets, 3);
  assert.throws(() => read([...nativeMessages, { role: 'user', content: refresh }]), /repeated synchronization/);
});

test('refresh counts and prefix digests cannot replace or duplicate a different existing checkpoint', async t => {
  const f = await fixture(t), original = imagePair(), full = [...original, ...pair('later')];
  const bootstrap = await f.encode(original, { imageProjectionVersion: 0, previousDigest: null });
  const refresh = await f.encode(full, { operationId: 'refresh-with-tail', previousDigest: fingerprint({ messages: original }), historyPrefixCount: original.length });
  const resolver = await prepareArchiveResolver({ ...f.identity, root: f.root, contents: [bootstrap, refresh] });
  const meta = { id: f.identity.targetSessionId, cwd: f.root, timestamp: '2026-09-26T05:00:00Z' };
  const decodeNative = messages => decodeCompletedOwnedClaudeHistory({ ...f.identity, sessionId: f.identity.targetSessionId, resolveArchive: resolver,
    text: encodeClaude({ meta, messages }, f.identity.targetSessionId).text });
  const packet = content => ({ role: 'user', content });
  assert.equal(decodeNative([packet(bootstrap), packet(refresh)]).digest, fingerprint({ messages: full }));
  assert.throws(() => decodeNative([packet(bootstrap), ...pair('competing local'), packet(refresh)]), /synchronized prefix/);
  for (const count of [0, -1, full.length + 1, 1.5]) {
    const changed = structuredClone(refresh), envelope = JSON.parse(changed.at(-1).text.split('\n').slice(1).join('\n'));
    envelope.historyPrefixCount = count;
    changed.at(-1).text = '[Claudex context packet v2]\n' + JSON.stringify(envelope);
    resign(changed, f.identity.key);
    assert.throws(() => inspectArchivedContextPacket({ ...f.identity, content: changed }), /refresh prefix/);
  }
  await assert.rejects(f.encode(full, { previousDigest: fingerprint({ messages: original }), historyPrefixCount: 3 }), /refresh prefix/);
  await assert.rejects(f.encode(pair('no image'), { previousDigest: fingerprint({ messages: pair('no image') }), historyPrefixCount: 2 }), /refresh prefix/);
});
