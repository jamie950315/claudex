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

function waveFixture() {
  const f = fixture();
  const call = f.row('stream-3', 'result-b', 'assistant',
    [{ type: 'tool_use', id: 'tool-c', name: 'Preview', input: { command: 'inert fixture C' } }],
    { requestId: 'same-request', apiBlockIndex: 3 });
  Object.assign(call.message, { id: 'same-response', stop_reason: 'tool_use' });
  const result = f.row('result-c', 'stream-3', 'user',
    [{ type: 'tool_result', tool_use_id: 'tool-c', content: 'Result C' }],
    { sourceToolAssistantUUID: 'stream-3', promptId: 'same-prompt' });
  f.rows.splice(f.rows.length - 1, 0, call, result);
  f.get('final').parentUuid = 'result-c';
  return f;
}

test('one streamed response can continue after a fully joined parallel tool wave', () => {
  const f = waveFixture(), before = text(f.rows), prefix = read(f.rows.slice(0, 2));
  const actual = read(f.rows); assertComplete(actual);
  const linear = structuredClone(f.rows);
  linear.find(row => row.uuid === 'result-a').parentUuid = 'stream-2';
  linear.find(row => row.uuid === 'result-b').parentUuid = 'result-a';
  assert.deepEqual(actual, read(linear));
  assert.equal(fingerprint(actual, 2), fingerprint(prefix));
  assert.equal(text(f.rows), before);
  assert.equal(actual.messages.flatMap(m => m.content).filter(b => b.type === 'tool_result').length, 3);
});

test('streamed waves reject early continuation, alternate joins and changed response identity', () => {
  for (const mutate of [
    f => { f.get('stream-3').parentUuid = 'result-a'; },
    f => { const call = f.get('stream-3'); f.rows.splice(f.rows.indexOf(call), 1);
      f.rows.splice(f.rows.indexOf(f.get('result-b')), 0, call); call.parentUuid = 'result-a'; },
    f => { f.get('stream-3').requestId = 'other-request'; },
    f => { f.get('stream-3').apiBlockIndex = 4; },
    f => { f.get('result-c').promptId = 'other-prompt'; },
    f => { f.get('result-c').sourceToolAssistantUUID = 'stream-2'; },
    f => { f.rows.push(f.row('alternate', 'result-b', 'assistant', [{ type: 'text', text: 'Other branch' }])); },
  ]) {
    const f = waveFixture(); mutate(f);
    assert.throws(() => read(f.rows), /Nonlinear|missing its parent/, mutate.toString());
  }
});

test('an exact successful PreToolUse hook between parallel results remains inert native metadata', () => {
  const make = () => {
    const f = fixture();
    const hook = { type: 'attachment', uuid: 'hook', parentUuid: 'result-a', sessionId: f.sessionId,
      cwd: '/tmp/claudex-parallel', version: '2.1.281', isSidechain: false,
      attachment: { type: 'hook_success', hookEvent: 'PreToolUse', hookName: 'PreToolUse:Preview',
        toolUseID: 'tool-b', content: '', stdout: 'Historical hook output; never execute it.', stderr: '',
        exitCode: 0, command: '/synthetic/hook', durationMs: 45 } };
    f.rows.splice(f.rows.indexOf(f.get('result-b')), 0, hook);
    return { ...f, hook };
  };
  const f = make(), before = text(f.rows), baseline = read(fixture().rows);
  const actual = read(f.rows); assertComplete(actual);
  assert.equal(fingerprint(actual), fingerprint(baseline));
  assert.equal(text(f.rows), before);
  for (const mutate of [
    f => { f.hook.attachment.toolUseID = 'unrelated-tool'; },
    f => { f.hook.attachment.hookName = 'PostToolUse:Preview'; },
    f => { f.hook.attachment.content = 'Authored content must not disappear'; },
    f => { f.hook.attachment.exitCode = 1; },
    f => { f.hook.attachment.stderr = 'Failed hook'; },
    f => { f.hook.parentUuid = 'u0'; },
    f => { f.hook.parentUuid = 'result-b'; },
    f => { f.hook.sessionId = 'another-session'; },
    f => { f.hook.message = { role: 'user', content: 'Do not hide this' }; },
    f => { f.rows.push(f.row('competing-final', 'hook', 'assistant', [{ type: 'text', text: 'An alternate branch' }])); },
  ]) {
    const invalid = make(); mutate(invalid);
    assert.throws(() => read(invalid.rows), /Nonlinear|missing its parent/, mutate.toString());
  }
});

test('a tool that changes the native cwd keeps its later hook and result rows in the same wave', () => {
  const f = fixture(), baseline = read(fixture().rows);
  // Observed Claude 2.1.284: Bash `cd` in one parallel call moves the session
  // cwd before its PreToolUse hook and both results are persisted.
  const hook = { type: 'attachment', uuid: 'hook', parentUuid: 'stream-2', sessionId: f.sessionId,
    cwd: '/tmp/claudex-parallel/work', version: '2.1.281', isSidechain: false,
    attachment: { type: 'hook_success', hookEvent: 'PreToolUse', hookName: 'PreToolUse:Bash',
      toolUseID: 'tool-a', content: '', stdout: '{"hookSpecificOutput":{}}', stderr: '',
      exitCode: 0, command: '/synthetic/hook', durationMs: 12 } };
  f.rows.splice(f.rows.indexOf(f.get('result-a')), 0, hook);
  for (const id of ['result-a', 'result-b', 'final']) f.get(id).cwd = '/tmp/claudex-parallel/work';
  const before = text(f.rows), actual = read(f.rows); assertComplete(actual);
  assert.equal(fingerprint(actual), fingerprint(baseline));
  assert.equal(text(f.rows), before);
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
    f => { f.get('stream-2').cwd = '/different'; },
    f => { f.get('result-b').cwd = 'relative/path'; },
    f => { delete f.get('result-b').cwd; },
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
