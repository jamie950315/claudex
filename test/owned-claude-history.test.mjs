import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { decodeClaude, encodeClaude } from '../src/claude.mjs';
import { encodeContextPacket } from '../src/context-packet.mjs';
import { decodeOwnedClaudeHistory, completedClaudePrefix, decodeCompletedOwnedClaudeHistory } from '../src/owned-claude-history.mjs';
import { fingerprint } from '../src/history.mjs';

const key = randomBytes(32);
const sessionId = randomUUID();
const conversationId = 'owned-history-proof';
const meta = { id: sessionId, cwd: '/tmp', timestamp: '2026-09-25T00:00:00Z' };
const turn = label => [
  { role: 'user', content: [{ type: 'text', text: `Question ${label}` }] },
  { role: 'assistant', content: [{ type: 'text', text: `Answer ${label}` }] },
];
function packet(messages, operationId, previousDigest = null) {
  return { role: 'user', content: encodeContextPacket({ messages, operationId, previousDigest, key,
    conversationId, targetSessionId: sessionId, sourceSide: 'codex' }) };
}
const decode = messages => decodeOwnedClaudeHistory({ text: encodeClaude({ meta, messages }, sessionId).text,
  conversationId, sessionId, key });

test('owned history expands imports once and retains locally authored Claude turns', () => {
  const a = turn('Codex A'), b = turn('Claude B'), c = turn('Codex C');
  const result = decode([packet(a, 'a'), ...b, packet(c, 'c', fingerprint({ messages: [...a, ...b] }))]);
  assert.equal(result.digest, fingerprint({ messages: [...a, ...b, ...c] }));
  assert.equal(result.importedPackets, 2);
  assert.equal(result.common.messages.length, 6);
  assert.ok(!JSON.stringify(result.common.messages).includes('Claudex context packet'));
});

test('duplicate operations and changed prefixes are conflicts, never new authored history', () => {
  const a = turn('A'), b = turn('B');
  assert.throws(() => decode([packet(a, 'a'), packet(a, 'a')]), /repeated synchronization/);
  assert.throws(() => decode([packet(a, 'a'), ...b, packet(turn('C'), 'c', fingerprint({ messages: a }))]), /synchronized prefix/);
});

test('unsigned incomplete user turns and wrong native identities cannot be published', () => {
  assert.throws(() => decode([...turn('A'), { role: 'user', content: [{ type: 'text', text: 'Still working' }] }]), /complete assistant/);
  const text = encodeClaude({ meta, messages: [packet(turn('A'), 'a')] }, sessionId).text;
  assert.throws(() => decodeOwnedClaudeHistory({ text, conversationId, sessionId: randomUUID(), key }), /different native session/);
});

test('completed source prefix stays publishable while a newer user turn is unfinished', () => {
  const text = encodeClaude({ meta, messages: [packet(turn('A'), 'a'), ...turn('B'),
    { role: 'user', content: [{ type: 'text', text: 'Work in progress' }] }] }, sessionId).text;
  const prefix = completedClaudePrefix({ text, conversationId, sessionId, key });
  assert.equal(prefix.incompleteTail, true);
  const result = decodeOwnedClaudeHistory({ text: prefix.text, conversationId, sessionId, key });
  assert.equal(result.digest, fingerprint({ messages: [...turn('A'), ...turn('B')] }));
  const importedOnly = encodeClaude({ meta, messages: [packet(turn('A'), 'a')] }, sessionId).text;
  assert.equal(completedClaudePrefix({ text: importedOnly, conversationId, sessionId, key }).incompleteTail, false);
});

test('the exact native resumed no-query placeholder is not an authored assistant turn', () => {
  const a = turn('A'), b = turn('B');
  const placeholder = { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] };
  const rows = encodeClaude({ meta, messages: [packet(a, 'a'), placeholder, packet(b, 'b', fingerprint({ messages: a }))] }, sessionId).rows;
  const receipt = rows.find(row => row.type === 'assistant');
  receipt.message.model = '<synthetic>';
  receipt.message.stop_reason = 'stop_sequence';
  receipt.message.stop_sequence = '';
  receipt.message.usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const read = () => decodeOwnedClaudeHistory({ text: rows.map(row => JSON.stringify(row)).join('\n') + '\n', conversationId, sessionId, key });
  assert.equal(read().digest, fingerprint({ messages: [...a, ...b] }));
  receipt.message.model = 'real-model';
  assert.throws(read, /synchronized prefix/);
  receipt.message.model = '<synthetic>'; receipt.message.usage.output_tokens = 1;
  assert.throws(read, /synchronized prefix/);
  receipt.message.usage.output_tokens = 0; receipt.message.content[0].text = 'A real answer';
  assert.throws(read, /synchronized prefix/);
  const actual = decode([packet(a, 'a'), { role: 'user', content: [{ type: 'text', text: 'Say no response requested.' }] }, placeholder]);
  assert.equal(actual.common.messages.at(-1).content[0].text, 'No response requested.');
  assert.equal(actual.common.messages.length, 4);
});

test('native image-source sidecars do not become authored turns or break the next packet prefix', () => {
  const a = turn('image A'), b = turn('B');
  a[0].content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
  const annotation = { role: 'user', content: [{ type: 'text', text: `[Image: source: /private/tmp/claude-501/-tmp/${sessionId}/images/1.png, original 2400x1600, displayed at 2000x1333. Multiply coordinates by 1.20 to map to original image.]` }] };
  const placeholder = { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] };
  const rows = encodeClaude({ meta, messages: [packet(a, 'image-a'), annotation, placeholder, packet(b, 'image-b', fingerprint({ messages: a }))] }, sessionId).rows;
  const authored = rows.filter(row => row.type === 'user' || row.type === 'assistant');
  Object.assign(authored[0], { version: '2.1.281', promptSource: 'sdk', queueTranscriptOnly: true, promptId: 'native-prompt', imagePasteIds: [1] });
  Object.assign(authored[1], { version: '2.1.281', isMeta: true, promptId: 'native-prompt' });
  Object.assign(authored[2].message, { model: '<synthetic>', stop_reason: 'stop_sequence', stop_sequence: '', usage: { input_tokens: 0, output_tokens: 0 } });
  const read = (versionPolicy = 'strict') => decodeOwnedClaudeHistory({ text: rows.map(row => JSON.stringify(row)).join('\n') + '\n', conversationId, sessionId, key, versionPolicy });
  assert.equal(read().digest, fingerprint({ messages: [...a, ...b] }));
  authored[1].isMeta = false;
  assert.throws(read, /synchronized prefix/);
  authored[1].isMeta = true; authored[1].promptId = 'another-prompt';
  assert.throws(read, /synchronized prefix/);
  authored[1].promptId = 'native-prompt'; authored[1].message.content[0].text += ' Additional instructions';
  assert.throws(read, /synchronized prefix/);
  authored[1].message.content[0].text = annotation.content[0].text;
  authored[0].version = '2.2.1'; authored[1].version = '2.2.1';
  assert.throws(read, /synchronized prefix/);
  assert.equal(read('warn').digest, fingerprint({ messages: [...a, ...b] }));
  authored[0].promptSource = 'user';
  assert.throws(() => read('warn'), /synchronized prefix/);
  authored[0].promptSource = 'sdk'; authored[1].promptId = 'unrelated';
  assert.throws(() => read('warn'), /synchronized prefix/);
  authored[1].promptId = 'native-prompt'; authored[0].message.content[0].text += ' tampered';
  assert.throws(() => read('warn'), /signature|digest|packet/);
});

function appendNativeCompaction(rows, messages = turn('after compact')) {
  const boundary = { type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), parentUuid: null,
    logicalParentUuid: rows.filter(row => row.uuid && !row.isSidechain).at(-1)?.uuid,
    sessionId, cwd: meta.cwd, version: '2.1.281', compactMetadata: { trigger: 'manual', preTokens: 919, postTokens: 766 } };
  const summary = { type: 'user', uuid: randomUUID(), parentUuid: boundary.uuid, sessionId, cwd: meta.cwd,
    version: '2.1.281', isCompactSummary: true, isVisibleInTranscriptOnly: true, queueTranscriptOnly: true,
    message: { role: 'user', content: 'Native readable summary of the preceding verified history.' } };
  rows.push(boundary, summary, ...encodeClaude({ meta, messages }, sessionId, summary.uuid).rows);
  return { boundary, summary };
}
const ownedRows = () => encodeClaude({ meta, messages: [packet(turn('imported'), 'imported'), ...turn('authored')] }, sessionId).rows;
const textRows = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const readRows = rows => decodeCompletedOwnedClaudeHistory({ text: textRows(rows), conversationId, sessionId, key });

test('fresh native full compaction keeps the authenticated canonical prefix and subsequent complete continuation', () => {
  const rows = ownedRows(), before = readRows(rows);
  appendNativeCompaction(rows);
  const after = readRows(rows);
  assert.equal(after.importedPackets, 1);
  assert.equal(after.common.messages.length, before.common.messages.length + 3);
  assert.equal(fingerprint(after.common, before.common.messages.length), before.digest);
  assert.equal(after.incompleteTail, false);
  assert.match(after.common.messages[before.common.messages.length].content[0].text, /complete earlier verified history is retained/);
  assert.equal(after.common.meta.compaction.retainedHistory, true);
  assert.equal(after.common.meta.compaction.boundaries, 1);
  // The legacy adapter's explicit summary-baseline policy stays unchanged.
  assert.equal(decodeClaude(textRows(rows)).messages.length, 3);
});

test('a later authenticated delta and a second native compaction retain the full earlier digest chain', () => {
  const rows = ownedRows();
  appendNativeCompaction(rows);
  const compacted = readRows(rows);
  const delta = packet(turn('next delta'), 'next-delta', compacted.digest);
  rows.push(...encodeClaude({ meta, messages: [delta] }, sessionId, rows.filter(row => row.uuid).at(-1).uuid).rows);
  const delivered = readRows(rows);
  assert.equal(delivered.importedPackets, 2);
  assert.equal(fingerprint(delivered.common, compacted.common.messages.length), compacted.digest);
  appendNativeCompaction(rows, turn('second compact continuation'));
  const second = readRows(rows);
  assert.equal(second.importedPackets, 2);
  assert.equal(second.common.meta.compaction.boundaries, 2);
  assert.equal(fingerprint(second.common, delivered.common.messages.length), delivered.digest);
});

test('compaction plus an unfinished continuation cannot advance the completed owned checkpoint', () => {
  const rows = ownedRows(), before = readRows(rows);
  appendNativeCompaction(rows, [{ role: 'user', content: [{ type: 'text', text: 'Still responding' }] }]);
  const partial = readRows(rows);
  assert.equal(partial.digest, before.digest);
  assert.equal(partial.common.messages.length, before.common.messages.length);
  assert.equal(partial.incompleteTail, true);
});

test('owned compaction does not legitimize absent, changed, duplicate, or unlinked earlier native history', () => {
  for (const kind of ['no-packet', 'tampered-packet', 'wrong-logical-parent', 'missing-logical-parent',
    'wrong-summary-parent', 'wrong-session', 'opaque-summary', 'missing-summary-flag', 'duplicate-identity', 'missing-identity', 'missing-parent']) {
    const rows = ownedRows();
    const { boundary, summary } = appendNativeCompaction(rows);
    if (kind === 'no-packet') rows.splice(0, rows.indexOf(boundary));
    if (kind === 'tampered-packet') rows.find(row => row.type === 'user').message.content[1].text += ' altered';
    if (kind === 'wrong-logical-parent') boundary.logicalParentUuid = rows.find(row => row.uuid).uuid;
    if (kind === 'missing-logical-parent') delete boundary.logicalParentUuid;
    if (kind === 'wrong-summary-parent') summary.parentUuid = boundary.logicalParentUuid;
    if (kind === 'wrong-session') boundary.sessionId = randomUUID();
    if (kind === 'opaque-summary') summary.message.content = '';
    if (kind === 'missing-summary-flag') delete summary.isVisibleInTranscriptOnly;
    if (kind === 'duplicate-identity') rows.splice(1, 0, structuredClone(rows[0]));
    if (kind === 'missing-identity') delete rows.find(row => row.type === 'user').uuid;
    if (kind === 'missing-parent') rows.find(row => row.type === 'assistant').parentUuid = 'missing';
    assert.throws(() => readRows(rows), /packet|checkpoint|signature|summary|compaction|parent|identit/i, kind);
  }
});

test('preserved-segment dependencies are refused even when followed by another readable compaction', () => {
  for (const field of ['preservedSegment', 'preservedMessages']) {
    const rows = ownedRows();
    const first = appendNativeCompaction(rows);
    appendNativeCompaction(rows, turn('later summary'));
    first.boundary.compactMetadata[field] = {};
    assert.throws(() => readRows(rows), /preserved-segment/);
  }
});

function preservedPacketFixture() {
  const rows = ownedRows();
  appendNativeCompaction(rows);
  const before = readRows(rows);
  rows.push(...encodeClaude({ meta, messages: [packet(turn('preserved delta'), 'preserved-delta', before.digest)] },
    sessionId, rows.filter(row => row.uuid).at(-1).uuid).rows);
  const preserved = rows.filter(row => row.type === 'user').at(-1);
  Object.assign(preserved, { version: '2.1.281', promptSource: 'sdk', queueTranscriptOnly: true });
  const prefix = readRows(rows), { boundary, summary } = appendNativeCompaction(rows, turn('second real continuation'));
  boundary.compactMetadata.preservedSegment = { headUuid: preserved.uuid, anchorUuid: summary.uuid, tailUuid: preserved.uuid };
  boundary.compactMetadata.preservedMessages = { anchorUuid: summary.uuid, uuids: [preserved.uuid], allUuids: [preserved.uuid] };
  return { rows, preserved, prefix, boundary, summary };
}

test('the observed single authenticated no-query tail packet survives native preserved-message compaction exactly once', () => {
  const f = preservedPacketFixture(), after = readRows(f.rows);
  assert.equal(after.importedPackets, 2);
  assert.equal(fingerprint(after.common, f.prefix.common.messages.length), f.prefix.digest);
  assert.equal(after.common.meta.compaction.boundaries, 2);
  assert.equal(after.common.meta.compaction.preservedAuthenticatedPackets, 1);
  assert.equal(after.common.messages.length, f.prefix.common.messages.length + 3);
  assert.throws(() => decodeClaude(textRows(f.rows), { preserveCompactionHistory: true }), /preserved-segment/);
  assert.throws(() => decodeClaude(textRows(f.rows)), /preserved-segment/);
});

test('preserved-packet support rejects metadata ambiguity, extra messages, changed HMAC and missing native identity', () => {
  for (const kind of ['missing-segment', 'missing-messages', 'extra-key', 'multiple-uuids', 'different-all-uuids',
    'wrong-anchor', 'wrong-tail', 'missing-reference', 'wrong-session', 'wrong-cwd', 'not-sdk', 'not-noquery',
    'meta-user', 'wrong-version', 'changed-hmac', 'duplicate-physical-row']) {
    const f = preservedPacketFixture(), { boundary, summary, preserved, rows } = f;
    const segment = boundary.compactMetadata.preservedSegment, messages = boundary.compactMetadata.preservedMessages;
    if (kind === 'missing-segment') delete boundary.compactMetadata.preservedSegment;
    if (kind === 'missing-messages') delete boundary.compactMetadata.preservedMessages;
    if (kind === 'extra-key') messages.unknown = true;
    if (kind === 'multiple-uuids') messages.uuids.push(summary.uuid);
    if (kind === 'different-all-uuids') messages.allUuids[0] = summary.uuid;
    if (kind === 'wrong-anchor') segment.anchorUuid = preserved.uuid;
    if (kind === 'wrong-tail') segment.tailUuid = summary.uuid;
    if (kind === 'missing-reference') rows.splice(rows.indexOf(preserved), 1);
    if (kind === 'wrong-session') preserved.sessionId = randomUUID();
    if (kind === 'wrong-cwd') preserved.cwd = '/different';
    if (kind === 'not-sdk') preserved.promptSource = 'user';
    if (kind === 'not-noquery') preserved.queueTranscriptOnly = false;
    if (kind === 'meta-user') preserved.isMeta = true;
    if (kind === 'wrong-version') preserved.version = '2.2.0';
    if (kind === 'changed-hmac') preserved.message.content[1].text += ' forged';
    if (kind === 'duplicate-physical-row') rows.splice(rows.indexOf(boundary), 0, structuredClone(preserved));
    assert.throws(() => readRows(rows), /preserved-segment|signature|packet|identity|identities|compaction|parent/i, kind);
  }
});

function imageSidecarTail(extra = []) {
  const original = turn('completed image checkpoint');
  original[0].content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
  const annotation = { role: 'user', content: [{ type: 'text', text: `[Image: source: /private/tmp/claude-501/-tmp/${sessionId}/images/1.png]` }] };
  const rows = encodeClaude({ meta, messages: [packet(original, 'image-tail'), annotation, ...extra] }, sessionId).rows;
  const authored = rows.filter(row => row.type === 'user' || row.type === 'assistant');
  Object.assign(authored[0], { version: '2.1.281', promptSource: 'sdk', queueTranscriptOnly: true,
    promptId: 'image-tail-prompt', imagePasteIds: [1] });
  Object.assign(authored[1], { version: '2.1.281', isMeta: true, promptId: 'image-tail-prompt' });
  return { original, rows, packetRow: authored[0], sidecar: authored[1] };
}

test('one exact authenticated image-source sidecar does not leave a completed no-query packet unfinished', () => {
  const f = imageSidecarTail(), text = textRows(f.rows);
  const prefix = completedClaudePrefix({ text, conversationId, sessionId, key });
  assert.equal(prefix.incompleteTail, false);
  assert.equal(prefix.text, text);
  const result = readRows(f.rows);
  assert.equal(result.incompleteTail, false);
  assert.equal(result.importedPackets, 1);
  assert.equal(result.digest, fingerprint({ messages: f.original }));
});

test('altered, unmatched and arbitrary metadata tails remain withheld instead of becoming completion boundaries', () => {
  for (const change of [
    f => { f.sidecar.message.content[0].text += ' additional instructions'; },
    f => { f.sidecar.promptId = 'another-prompt'; },
    f => { f.sidecar.timestamp = '2026-09-26T00:00:00Z'; },
    f => { f.sidecar.isMeta = false; },
    f => { f.sidecar.message.content[0].text = 'Arbitrary metadata content'; },
    f => { f.packetRow.promptSource = 'user'; },
  ]) {
    const f = imageSidecarTail(); change(f);
    const result = readRows(f.rows);
    assert.equal(result.incompleteTail, true);
    assert.equal(result.digest, fingerprint({ messages: f.original }));
  }
});

test('a real unfinished user after an image sidecar still stays local and a broken parent graph is rejected', () => {
  const f = imageSidecarTail([{ role: 'user', content: [{ type: 'text', text: 'Real new work is still running.' }] }]);
  const result = readRows(f.rows);
  assert.equal(result.incompleteTail, true);
  assert.equal(result.digest, fingerprint({ messages: f.original }));
  const broken = imageSidecarTail(); broken.sidecar.parentUuid = 'missing-parent';
  assert.throws(() => readRows(broken.rows), /missing its parent|native parent/);
});
