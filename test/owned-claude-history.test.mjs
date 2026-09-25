import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { encodeClaude } from '../src/claude.mjs';
import { encodeContextPacket } from '../src/context-packet.mjs';
import { decodeOwnedClaudeHistory, completedClaudePrefix } from '../src/owned-claude-history.mjs';
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
