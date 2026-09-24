import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { encodeClaude } from '../src/claude.mjs';
import { encodeContextPacket } from '../src/context-packet.mjs';
import { decodeOwnedClaudeHistory } from '../src/owned-claude-history.mjs';
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
