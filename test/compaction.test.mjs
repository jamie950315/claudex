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
