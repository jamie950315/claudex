import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { decodeClaude } from '../src/claude.mjs';
import { assertComplete, fingerprint, portableMessages } from '../src/history.mjs';
import { completedClaudePrefix, decodeCompletedOwnedClaudeHistory } from '../src/owned-claude-history.mjs';
import { encodeContextPacket } from '../src/context-packet.mjs';

const text = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
function fixture() {
  const base = { sessionId: randomUUID(), cwd: '/tmp/claudex-parallel', version: '2.1.281',
    timestamp: '2026-09-27T00:00:00.000Z', isSidechain: false, userType: 'external' };
  const row = (uuid, parentUuid, type, content, extra = {}) => ({ ...base, uuid, parentUuid, type,
    message: { role: type, content, ...(type === 'assistant' ? { id: 'msg-' + uuid,
      model: 'synthetic-fixture', stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } } : {}) }, ...extra });
  const rows = [row('u0', null, 'user', 'Remember the prior turn'), row('a0', 'u0', 'assistant', [{ type: 'text', text: 'Remembered' }]),
    row('u1', 'a0', 'user', 'Run both tools')];
  const blocks = [{ type: 'thinking', thinking: 'Visible fixture reasoning', signature: 'fixture' },
    { type: 'tool_use', id: 'tool-a', name: 'Bash', input: { command: 'inert fixture A' } },
    { type: 'tool_use', id: 'tool-b', name: 'Preview', input: { command: 'inert fixture B' } }];
  for (let index = 0; index < blocks.length; index++) {
    const value = row('stream-' + index, index ? 'stream-' + (index - 1) : 'u1', 'assistant', [blocks[index]],
      { requestId: 'same-request', apiBlockIndex: index });
    Object.assign(value.message, { id: 'same-response', stop_reason: 'tool_use' }); rows.push(value);
  }
  rows.push({ type: 'custom-title', sessionId: base.sessionId, customTitle: 'Inert metadata' });
  rows.push(row('result-a', 'stream-1', 'user', [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'Result A' }],
    { sourceToolAssistantUUID: 'stream-1', promptId: 'same-prompt' }));
  rows.push(row('result-b', 'stream-2', 'user', [{ type: 'tool_result', tool_use_id: 'tool-b', content: 'Result B' }],
    { sourceToolAssistantUUID: 'stream-2', promptId: 'same-prompt' }));
  rows.push(row('final', 'result-b', 'assistant', [{ type: 'text', text: 'Both tools completed' }]));
  return { rows, row, get: id => rows.find(row => row.uuid === id), sessionId: base.sessionId };
}
const read = rows => decodeClaude(text(rows), { preserveCompactionHistory: true });

test('the observed native parallel-tool graph preserves both results and its saved prefix without rewriting rows', () => {
  const f = fixture(), before = text(f.rows), prefix = read(f.rows.slice(0, 2));
  const actual = read(f.rows); assertComplete(actual);
  const linear = structuredClone(f.rows);
  linear.find(row => row.uuid === 'result-a').parentUuid = 'stream-2';
  linear.find(row => row.uuid === 'result-b').parentUuid = 'result-a';
  assert.deepEqual(actual, read(linear));
  assert.equal(fingerprint(actual, 2), fingerprint(prefix));
  assert.equal(text(f.rows), before);
  const tools = actual.messages.flatMap(message => message.content).filter(block => ['tool_use', 'tool_result'].includes(block.type));
  assert.deepEqual(tools.map(block => block.type), ['tool_use', 'tool_use', 'tool_result', 'tool_result']);
});

test('completion order and inert final anchors do not select a branch or lose a result', () => {
  const f = fixture(), a = f.rows.indexOf(f.get('result-a')), b = f.rows.indexOf(f.get('result-b'));
  [f.rows[a], f.rows[b]] = [f.rows[b], f.rows[a]];
  f.get('final').parentUuid = 'anchor';
  f.rows.splice(f.rows.length - 1, 0, { type: 'attachment', uuid: 'anchor', parentUuid: 'result-a', sessionId: f.sessionId });
  assertComplete(read(f.rows));
  const incomplete = fixture(); incomplete.rows.pop();
  const prefix = completedClaudePrefix({ text: text(incomplete.rows) });
  assert.equal(prefix.incompleteTail, true);
  assert.equal(fingerprint(read(prefix.text.trim().split('\n').map(JSON.parse))), fingerprint(read(incomplete.rows.slice(0, 2))));
});

test('parallel completion also preserves an authenticated owned checkpoint without replaying imports', () => {
  const f = fixture(), key = randomBytes(32), conversationId = 'parallel-owned';
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Imported context' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Context retained' }] }];
  f.get('u0').message.content = encodeContextPacket({ messages, operationId: 'initial', key, conversationId,
    sourceSide: 'codex', targetSessionId: f.sessionId });
  Object.assign(f.get('a0').message, { model: '<synthetic>', stop_reason: 'stop_sequence',
    content: [{ type: 'text', text: 'No response requested.' }] });
  const result = decodeCompletedOwnedClaudeHistory({ text: text(f.rows), conversationId, sessionId: f.sessionId, key });
  assert.equal(result.importedPackets, 1); assert.equal(result.incompleteTail, false);
  assert.equal(fingerprint(result.common, 2), fingerprint({ messages }));
  assert.equal(portableMessages(result.common.messages).flatMap(message => message.content).filter(block => block.type === 'tool_result').length, 2);
});

test('ambiguous tool metadata, missing results and real competing continuations stay blocked', () => {
  const mutations = [
    f => { f.get('stream-2').message.id = 'different-response'; },
    f => { f.get('stream-2').requestId = 'different-request'; },
    f => { f.get('stream-2').apiBlockIndex = 3; },
    f => { f.get('stream-2').message.stop_reason = 'end_turn'; },
    f => { f.get('stream-2').message.model = 'different-model'; },
    f => { f.get('stream-2').isApiErrorMessage = true; },
    f => { f.get('stream-0').parentUuid = 'final'; },
    f => { for (const row of f.rows.filter(row => row.uuid?.startsWith('stream-') || row.uuid?.startsWith('result-'))) row.sessionId = 'foreign-session'; },
    f => { f.get('result-a').sourceToolAssistantUUID = 'stream-2'; },
    f => { f.get('result-a').message.content[0].tool_use_id = 'different-tool'; },
    f => { f.get('result-a').message.content.push({ type: 'text', text: 'An actual user request' }); },
    f => { f.get('result-b').promptId = 'different-prompt'; },
    f => { f.get('result-b').sessionId = randomUUID(); },
    f => { f.get('result-b').cwd = '/different'; },
    f => { f.get('result-b').version = 'different'; },
    f => { f.rows.splice(f.rows.indexOf(f.get('result-b')), 1); f.get('final').parentUuid = 'result-a'; },
    f => { f.rows.splice(f.rows.length - 1, 0, f.row('duplicate', 'stream-1', 'user',
      [{ type: 'tool_result', tool_use_id: 'tool-a', content: 'Conflicting result' }], { sourceToolAssistantUUID: 'stream-1', promptId: 'same-prompt' })); },
    f => { f.get('final').parentUuid = 'result-a'; },
    f => { f.rows.push(f.row('competing-final', 'result-b', 'assistant', [{ type: 'text', text: 'Another branch' }])); },
    f => { f.rows.push({ type: 'attachment', uuid: 'branch-anchor', parentUuid: 'result-a' },
      f.row('competing-final', 'branch-anchor', 'assistant', [{ type: 'text', text: 'Another branch' }])); },
    f => { f.rows.splice(f.rows.indexOf(f.get('result-b')), 0, f.row('intervening-user', 'result-a', 'user', 'Another branch')); },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.throws(() => read(f.rows), /Nonlinear|missing its parent/, mutate.toString());
  }
});
