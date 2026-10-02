import test from 'node:test';
import assert from 'node:assert/strict';
import { toCommon } from 'txcript';
import { decodeClaude, encodeClaude } from '../src/claude.mjs';
import { encodeCodexProjection } from '../src/codex-projection.mjs';
import { decodeCodex } from '../src/native-drivers.mjs';
import { assertComplete, fingerprint } from '../src/history.mjs';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const nativeRow = (number, type, message) => ({
  type, uuid: id(number), parentUuid: number > 1 ? id(number - 1) : null,
  sessionId: id(99), cwd: '/synthetic/project', timestamp: '2026-10-02T00:00:00Z', message,
});
const commandText = (name, args = '') => `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`;
const commandRow = (name, args) => nativeRow(1, 'user', { role: 'user', content: commandText(name, args) });
const assistantRow = number => nativeRow(number, 'assistant', { role: 'assistant', content: [{ type: 'text', text: 'Complete.' }], stop_reason: 'end_turn' });
const outputRow = number => ({ ...nativeRow(number, 'system'), subtype: 'local_command', content: '<local-command-stdout></local-command-stdout>' });
const serialize = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const codec = text => JSON.parse(toCommon(text, 'claude_code'));

test('unpaired native local commands preserve their full original text without fabricating tool results', () => {
  for (const [name, args] of [['plugin-panel', ''], ['extension:inspect', 'one\ntwo <quoted> 你好']]) {
    const rows = [commandRow(name, args), nativeRow(2, 'user', { role: 'user', content: 'Continue the conversation.' }), assistantRow(3)];
    const before = structuredClone(rows), text = serialize(rows);
    assert.equal(codec(text).messages[0].content[0].type, 'tool_use', 'the pinned codec reproduces the false pending call');
    const common = decodeClaude(text);
    assert.deepEqual(common.messages[0].content, [{ type: 'text', text: `[Native local command]\n${commandText(name, args)}` }]);
    assert.equal(common.messages.flatMap(message => message.content).some(block => block.type === 'tool_result'), false);
    assertComplete(common);
    assert.deepEqual(rows, before);
    assert.equal(serialize(rows), text, 'native transcript bytes are never rewritten');
  }
});

test('normalized local-command history round-trips through both legacy projections without open native calls', () => {
  const common = decodeClaude(serialize([commandRow('extension:panel', 'keep all arguments'), assistantRow(2)]));
  const claude = encodeClaude(common, id(98));
  const codex = encodeCodexProjection(common, id(98));
  assert.equal(fingerprint(decodeClaude(claude.text)), fingerprint(common));
  assert.equal(fingerprint(decodeCodex(codex).common), fingerprint(common));
  assert.equal(codex.split('\n').filter(Boolean).map(JSON.parse).some(row => row.payload?.type === 'function_call'), false);
  assert.equal(claude.rows.some(row => Array.isArray(row.message?.content) && row.message.content.some(block => block.type === 'tool_use')), false);
});

test('native envelope indentation and CRLF preserve every original byte as inert command text', () => {
  for (const [newline, indent] of [['\n', '            '], ['\r\n', '\t  ']]) {
    const command = commandRow('extension:panel', 'first\nsecond');
    command.message.content = command.message.content.replaceAll('\n<', `${newline}${indent}<`);
    const text = serialize([command, assistantRow(2)]);
    const common = decodeClaude(text);
    assert.deepEqual(common.messages[0].content, [{ type: 'text', text: `[Native local command]\n${command.message.content}` }]);
    assertComplete(common);
    assert.equal(fingerprint(decodeClaude(encodeClaude(common, id(98)).text)), fingerprint(common));
    assert.equal(fingerprint(decodeCodex(encodeCodexProjection(common, id(98))).common), fingerprint(common));
  }
});

test('native skill invocation envelopes support both field orders and optional arguments', () => {
  for (const messageFirst of [false, true]) for (const withArgs of [false, true]) {
    const name = 'extension:review-workflow';
    const fields = [`<command-name>/${name}</command-name>`, `<command-message>${name}</command-message>`];
    if (messageFirst) fields.reverse();
    if (withArgs) fields.push('<command-args>review current changes</command-args>');
    const raw = fields.join('\n    ');
    const rows = [nativeRow(1, 'user', { role: 'user', content: raw }), assistantRow(2)];
    const common = decodeClaude(serialize(rows));
    assert.deepEqual(common.messages[0].content, [{ type: 'text', text: `[Native local command]\n${raw}` }]);
    assertComplete(common);
    assert.equal(fingerprint(decodeClaude(encodeClaude(common, id(98)).text)), fingerprint(common));
    assert.equal(fingerprint(decodeCodex(encodeCodexProjection(common, id(98))).common), fingerprint(common));
    const paired = serialize([rows[0], outputRow(2), assistantRow(3)]);
    assert.deepEqual(decodeClaude(paired), codec(paired), 'existing paired command fingerprints remain unchanged in either field order');
  }
});

test('paired native commands including clear retain their existing codec content and canonical fingerprints', () => {
  for (const name of ['clear', 'status']) {
    const text = serialize([commandRow(name), outputRow(2), assistantRow(3)]);
    const oldCommon = codec(text), common = decodeClaude(text);
    assert.deepEqual(common, oldCommon);
    assert.equal(fingerprint(common), fingerprint(oldCommon));
    assert.equal(common.messages[0].content[0].tool.command, `/${name}`);
    assert.equal(common.messages[1].content[0].tool_use_id, id(1));
    assertComplete(common);
  }
});

test('a local command at the transcript tail does not prove an assistant turn completed', () => {
  const common = decodeClaude(serialize([commandRow('panel')]));
  assert.equal(common.messages[0].content[0].type, 'text');
  assert.throws(() => assertComplete(common), /Wait for a complete assistant turn/);
});

test('real assistant Command and Bash tool calls remain pending without a native result', () => {
  for (const name of ['Command', 'Bash']) {
    const text = serialize([
      nativeRow(1, 'user', { role: 'user', content: 'Question.' }),
      nativeRow(2, 'assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 'real-call', name, input: { command: '/panel' } }], stop_reason: 'tool_use' }),
      assistantRow(3),
    ]);
    const common = decodeClaude(text);
    assert.deepEqual(common, codec(text));
    assert.throws(() => assertComplete(common), /Unfinished tool call/);
  }
});

test('structured user tools are not treated as native local command envelope records', () => {
  const text = serialize([
    nativeRow(1, 'user', { role: 'user', content: [{ type: 'tool_use', id: id(1), name: 'Command', input: { command: '/panel' } }] }),
    assistantRow(2),
  ]);
  const common = decodeClaude(text);
  assert.deepEqual(common, codec(text));
  assert.throws(() => assertComplete(common), /Unfinished tool call/);
});

test('a mismatched native role cannot authenticate a local command record', () => {
  const command = commandRow('panel');
  command.message.role = 'assistant';
  const text = serialize([command, assistantRow(2)]);
  const common = decodeClaude(text);
  assert.deepEqual(common, codec(text));
  assert.throws(() => assertComplete(common), /Unfinished tool call/);
});

test('a model tool sharing a native command identifier cannot disappear through normalization', () => {
  const text = serialize([
    commandRow('panel'),
    nativeRow(2, 'assistant', { role: 'assistant', content: [{ type: 'tool_use', id: id(1), name: 'Command', input: { command: '/panel' } }], stop_reason: 'tool_use' }),
    assistantRow(3),
  ]);
  const common = decodeClaude(text);
  assert.deepEqual(common, codec(text));
  assert.throws(() => assertComplete(common), /Duplicate open tool call/);
});

test('partial command envelopes do not gain the no-output local-command exception', () => {
  const command = commandRow('panel');
  command.message.content += '\nUnrecognized trailing native content';
  const text = serialize([command, assistantRow(2)]);
  const common = decodeClaude(text);
  assert.deepEqual(common, codec(text));
  assert.equal(common.messages[0].content[0].text, command.message.content);
});

test('stdout inserted into previously checkpointed command history remains a detectable history conflict', () => {
  const rows = [commandRow('panel'), assistantRow(2)];
  const before = decodeClaude(serialize(rows));
  assertComplete(before);
  const checkpoint = fingerprint(before);
  const after = decodeClaude(serialize([rows[0], outputRow(2), assistantRow(3)]));
  assert.equal(after.messages[0].content[0].type, 'tool_use');
  assert.notEqual(fingerprint(after, before.messages.length), checkpoint,
    'the existing checkpoint guard must refuse the changed prefix rather than silently rewrite it');
  assert.equal(fingerprint(before), checkpoint);
});

test('stdout appended after an already complete turn remains an unpaired-result error', () => {
  const rows = [commandRow('panel'), assistantRow(2)];
  const before = decodeClaude(serialize(rows));
  const after = decodeClaude(serialize([...rows, outputRow(3), assistantRow(4)]));
  assert.equal(fingerprint(after, before.messages.length), fingerprint(before));
  assert.throws(() => assertComplete(after), /Unpaired tool result/);
});
