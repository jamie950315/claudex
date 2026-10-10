import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCodex } from '../src/native-drivers.mjs';
import { decodeClaude } from '../src/claude.mjs';
import { provenance } from '../src/compaction.mjs';
import { mkdtemp, mkdir, realpath, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeDrivers } from '../src/native-drivers.mjs';
import { Bridge } from '../src/bridge.mjs';
import { encodeCodexProjection } from '../src/codex-projection.mjs';
import { appendClaudeSession } from '../src/claude.mjs';
import { publishExclusive, snapshot } from '../src/storage.mjs';

const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const id = '00000000-0000-4000-8000-000000000001';
const meta = { type: 'session_meta', payload: { id, cwd: '/tmp', timestamp: '2026-09-25T00:00:00Z' } };
const message = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });

test('referenced rollout tails cannot silently omit their earlier history', () => {
  const referenced = { ...meta, payload: { ...meta.payload, history_base: { thread_id: id, end_ordinal_exclusive: 5, end_byte_offset: 999 } } };
  const tail = [message('user', 'Tail question'), message('assistant', 'Tail answer')];
  assert.throws(() => decodeCodex(jsonl([referenced, ...tail])), /Referenced Codex history/);
  const compacted = decodeCodex(jsonl([referenced, { type: 'compacted', payload: { message: 'Readable native summary of the referenced prefix.' } }, ...tail]));
  assert.equal(compacted.common.messages.length, 3);
  assert.match(compacted.common.messages[0].content[0].text, /Readable native summary/);
});

test('Codex readable compaction replaces earlier history and retains complete continuation', () => {
  const text = jsonl([meta, message('user', 'Discard old verbatim'), message('assistant', 'Old answer'),
    { type: 'compacted', payload: { message: 'Remember BLUE.' } }, message('user', 'Continue'), message('assistant', 'BLUE continued')]);
  const result = decodeCodex(text).common;
  assert.equal(result.messages.length, 3);
  assert.match(result.messages[0].content[0].text, /Imported native compaction summary/);
  assert.match(result.messages[0].content[0].text, /Remember BLUE/);
  assert.equal(result.meta.compaction.source, 'codex');
  assert.ok(result.meta.compaction.offset > 0);
  assert.ok(!JSON.stringify(result).includes('Discard old verbatim'));
});

test('opaque latest compaction cannot reuse an older readable summary', () => {
  assert.throws(() => decodeCodex(jsonl([meta, { type: 'compacted', payload: { message: 'Earlier summary' } },
    { type: 'compacted', payload: { message: '', replacement_history: [{ type: 'compaction', encrypted_content: 'opaque' }] } }, message('assistant', 'Done')])), /no readable native summary/);
});

const claude = (uuid, parentUuid, type, content, extra = {}) => ({ uuid, parentUuid, type, sessionId: id, cwd: '/tmp', timestamp: '2026-09-25T00:00:00Z', message: { role: type, content }, ...extra });
test('Claude explicit linked summary establishes a new independent semantic baseline', () => {
  const rows = [claude('old', null, 'user', 'Discard me'), { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId: id },
    claude('summary', 'boundary', 'user', 'Remember GREEN.', { isCompactSummary: true }),
    claude('question', 'summary', 'user', 'Continue'), claude('reply', 'question', 'assistant', 'GREEN continued')];
  const result = decodeClaude(jsonl(rows));
  assert.equal(result.messages.length, 3);
  assert.match(result.messages[0].content[0].text, /Imported native compaction summary/);
  assert.equal(result.meta.compaction.source, 'claude');
  assert.ok(!JSON.stringify(result).includes('Discard me'));
  rows[2].parentUuid = 'old';
  assert.throws(() => decodeClaude(jsonl(rows)), /explicitly linked/);
});

test('Claude preserved-segment and missing summary boundaries fail explicitly', () => {
  assert.throws(() => decodeClaude(jsonl([{ type: 'system', subtype: 'compact_boundary', uuid: 'b' }])), /explicitly linked/);
  assert.throws(() => decodeClaude(jsonl([{ type: 'system', subtype: 'compact_boundary', uuid: 'b', compactMetadata: { preservedSegment: {} } }])), /preserved-segment/);
});

test('provenance checks prior UTF-8 bytes without semantic-prefix substitutions', () => {
  const before = '中文\n';
  const record = { bytes: Buffer.byteLength(before), rawHash: provenance(before).rawHash };
  assert.equal(provenance(before + 'next\n', record).prefixUnchanged, true);
  assert.equal(provenance('改文\nnext\n', record).prefixUnchanged, false);
  assert.equal(provenance(before, {}).prefixUnchanged, false);
});

test('native readable compaction crosses a saved checkpoint and resumes both native projections', { skip: process.env.CLAUDEX_NATIVE_TEST !== '1', timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-compaction-test-')));
  const cwd = join(root, 'project'); const codexHome = join(root, 'codex'); const claudeHome = join(root, 'claude'); const stateRoot = join(root, 'state');
  await Promise.all([cwd, codexHome, claudeHome].map(path => mkdir(path)));
  const native = await nativeDrivers({ root: stateRoot, codexHome, claudeHome, claudeBinary: process.env.CLAUDEX_CLAUDE_BINARY || 'claude' });
  const common = { meta: { id: randomUUID(), cwd, timestamp: new Date().toISOString() }, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Remember BLUE and GREEN.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Remembered.' }] },
  ] };
  const source = { side: 'codex', nativeId: common.meta.id, path: join(codexHome, 'source.jsonl') };
  await publishExclusive(source.path, encodeCodexProjection(common, source.nativeId));
  try {
    const bridge = new Bridge({ root: stateRoot, drivers: native.drivers });
    const { conversationId } = await bridge.track({ side: 'codex', path: source.path });
    await bridge.sync(conversationId, 'codex');
    const before = bridge.current(await bridge.status(), conversationId, 'codex');
    await appendFile(source.path, jsonl([{ timestamp: common.meta.timestamp, type: 'compacted', payload: { message: 'The agreed colors are BLUE and GREEN.' } }, message('user', 'Continue after compaction'), message('assistant', 'BLUE and GREEN retained.') ]));
    const inspected = await native.drivers.codex.inspect(before);
    assert.equal(inspected.prefixUnchanged, true);
    assert.equal(inspected.compactionOffset, before.bytes);
    assert.equal((await bridge.sync(conversationId, 'codex')).changed, true);
    const target = bridge.current(await bridge.status(), conversationId, 'claude');
    const translated = await native.drivers.claude.inspect(target);
    assert.match(translated.common.messages[0].content[0].text, /Imported native compaction summary/);
    await appendClaudeSession({ path: target.path, id: target.nativeId, common, expectedHash: (await snapshot(target.path)).hash });
    const result = await bridge.sync(conversationId, 'claude');
    assert.equal(result.changed, true);
    const final = bridge.current(await bridge.status(), conversationId, 'codex');
    const decoded = await native.drivers.codex.inspect(final);
    assert.equal(decoded.common.messages.length, 5);
    assert.match(decoded.common.messages[0].content[0].text, /BLUE and GREEN/);
    t.diagnostic(`Native compaction evidence: ${root}`);
  } finally { await native.close(); }
});

test('rows native persists a second time before a later /compact are inert copies', () => {
  const at = { sessionId: id, cwd: '/tmp' };
  const row = (uuid, parentUuid, type, text, extra = {}) => ({ uuid, parentUuid, type, ...at, timestamp: `t-${uuid}`,
    message: { role: type, content: [{ type: 'text', text }], usage: { input_tokens: 1 } }, ...extra });
  const boundary = (uuid, logicalParentUuid, head, summary) => ({ type: 'system', subtype: 'compact_boundary', uuid,
    parentUuid: null, logicalParentUuid, ...at, compactMetadata: {
      preservedSegment: { headUuid: head, anchorUuid: summary, tailUuid: logicalParentUuid },
      preservedMessages: { anchorUuid: summary, uuids: [head, logicalParentUuid], allUuids: [head, logicalParentUuid] } } });
  const summary = (uuid, parent) => row(uuid, parent, 'user', 'Summary text', { isCompactSummary: true, isVisibleInTranscriptOnly: true });
  const first = [row('q0', null, 'user', 'First'), row('a0', 'q0', 'assistant', 'One'),
    boundary('b1', 'a0', 'q0', 's1'), summary('s1', 'b1'),
    row('q1', 's1', 'user', 'Second', { promptId: 'p1', toolUseResult: { stdout: 'long' } }), row('a1', 'q1', 'assistant', 'Two')];
  // The observed rewrite: the first boundary, its summary, the relinked
  // preserved rows and the following generation, with volatile fields changed.
  const copies = (change = value => value) => [first[2], { ...first[3], promptId: 'p9' },
    { ...first[0], parentUuid: 's1', slug: 'later' }, { ...first[1], message: { ...first[1].message, usage: { input_tokens: 9 } } },
    change({ ...first[4], promptId: 'p9', toolUseResult: { stdout: '' } }), first[5]];
  const rest = [boundary('b2', 'a1', 'q1', 's2'), summary('s2', 'b2'), row('q2', 's2', 'user', 'Third'), row('a2', 'q2', 'assistant', 'Three')];
  const expected = decodeClaude(jsonl([...first, ...rest]), { preserveCompactionHistory: true });
  const result = decodeClaude(jsonl([...first, ...copies(), ...rest]), { preserveCompactionHistory: true });
  assert.deepEqual(result.messages.map(message => message.content), expected.messages.map(message => message.content));
  assert.equal(result.messages.length, 8);
  // A reused identity with other content is not a copy.
  for (const change of [value => ({ ...value, message: { ...value.message, content: [{ type: 'text', text: 'Other' }] } }),
    value => ({ ...value, timestamp: 'later' }), value => ({ ...value, type: 'assistant' })])
    assert.throws(() => decodeClaude(jsonl([...first, ...copies(change), ...rest]), { preserveCompactionHistory: true }),
      /ambiguous|preserved-segment|summary/);
});

test('a native original retains a /compact preserved segment that only references its existing prefix', () => {
  const at = { sessionId: id, cwd: '/tmp' };
  const row = (uuid, parentUuid, type, text, extra = {}) => ({ uuid, parentUuid, type, ...at,
    message: { role: type, content: [{ type: 'text', text }] }, ...extra });
  const build = (preservedMessages = { anchorUuid: 'summary', uuids: ['q1', 'a1'], allUuids: ['q1', 'unpersisted', 'a1'] }) => [
    row('q0', null, 'user', 'First'), row('a0', 'q0', 'assistant', 'One'),
    row('q1', 'a0', 'user', 'Second'), row('a1', 'q1', 'assistant', 'Two'),
    { type: 'system', subtype: 'compact_boundary', uuid: 'boundary', parentUuid: null, logicalParentUuid: 'a1', ...at,
      compactMetadata: { preservedSegment: { headUuid: 'q1', anchorUuid: 'summary', tailUuid: 'a1' }, preservedMessages } },
    row('summary', 'boundary', 'user', 'Summary text', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    row('q2', 'summary', 'user', 'Third'), row('a2', 'q2', 'assistant', 'Three')];
  const result = decodeClaude(jsonl(build()), { preserveCompactionHistory: true });
  assert.deepEqual(result.messages.map(message => message.content[0].text.split('\n').at(-1)),
    ['First', 'One', 'Second', 'Two', 'Summary text', 'Third', 'Three']);
  assert.match(result.messages[4].content[0].text, /complete earlier verified history is retained/);
  // Without full-history retention the segment would be a dependency.
  assert.throws(() => decodeClaude(jsonl(build())), /preserved-segment/);
  // A missing, broken or reordered chain is still unsupported.
  for (const preserved of [{ anchorUuid: 'summary', uuids: ['q1', 'gone'], allUuids: ['q1', 'gone'] },
    { anchorUuid: 'summary', uuids: ['q0', 'a1'], allUuids: ['q0', 'a1'] },
    { anchorUuid: 'summary', uuids: ['q1', 'a1'], allUuids: ['a1', 'q1'] },
    { anchorUuid: 'other', uuids: ['q1', 'a1'], allUuids: ['q1', 'a1'] }])
    assert.throws(() => decodeClaude(jsonl(build(preserved)), { preserveCompactionHistory: true }), /preserved-segment/);
});
