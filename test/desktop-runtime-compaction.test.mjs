import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, appendFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { createClaudeSession, encodeClaude } from '../src/claude.mjs';
import { fingerprint } from '../src/history.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-local-compact-')));
  const cwd = join(root, 'project'), codexHome = join(root, 'codex'), claudeHome = join(root, 'claude');
  await Promise.all([cwd, codexHome, claudeHome].map(path => mkdir(path, { mode: 0o700 })));
  const id = randomUUID(), meta = { id, cwd, timestamp: '2026-09-26T04:00:00Z' };
  const pair = label => [{ role: 'user', content: [{ type: 'text', text: `Question ${label}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `Answer ${label}` }] }];
  const source = await createClaudeSession({ claudeHome, id, common: { meta, messages: pair('original') } });
  const runtime = await new DesktopRuntime({ root: join(root, 'state'), codexHome, claudeHome,
    ownerFactory() { throw new Error('Unmanaged Local inspection must not start a Claude owner.'); },
    clientFactory() { throw new Error('Unmanaged Local inspection must not start a Codex client.'); },
  }).initialize();
  const record = { side: 'claude', nativeId: id, path: source.path, cwd, managed: false, kind: 'original' };
  return { runtime, record, async compact({ incomplete = false, preserved = false } = {}) {
    const before = await readFile(source.path, 'utf8'), rows = before.trim().split('\n').map(JSON.parse);
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), parentUuid: null,
      logicalParentUuid: rows.filter(row => row.uuid && !row.isSidechain).at(-1).uuid,
      sessionId: id, cwd, version: '2.1.281', compactMetadata: { trigger: 'manual', ...(preserved ? { preservedMessages: {} } : {}) } };
    const summary = { type: 'user', uuid: randomUUID(), parentUuid: boundary.uuid, sessionId: id, cwd,
      isCompactSummary: true, isVisibleInTranscriptOnly: true, queueTranscriptOnly: true,
      message: { role: 'user', content: 'A readable native summary of the original question and answer.' } };
    const continuation = encodeClaude({ meta, messages: incomplete ? pair('later').slice(0, 1) : pair('later') }, id, summary.uuid).rows;
    await appendFile(source.path, [boundary, summary, ...continuation].map(row => JSON.stringify(row)).join('\n') + '\n');
    return before;
  } };
}

test('an unmanaged Local native compaction preserves the earlier Desktop checkpoint without creating a writer', async () => {
  const f = await fixture();
  try {
    const before = await f.runtime.inspect(f.record), sourceBytes = await f.compact();
    const after = await f.runtime.inspect(f.record);
    assert.equal(after.common.messages.length, 5);
    assert.equal(fingerprint(after.common, before.common.messages.length), before.digest);
    assert.equal(after.incompleteTail, false);
    assert.equal(after.common.meta.compaction.retainedHistory, true);
    assert.ok((await readFile(f.record.path, 'utf8')).startsWith(sourceBytes));
  } finally { await f.runtime.close(); }
});

test('an unmanaged compacted Local tail still waits for a real complete assistant continuation', async () => {
  const f = await fixture();
  try {
    const before = await f.runtime.inspect(f.record);
    await f.compact({ incomplete: true });
    const after = await f.runtime.inspect(f.record);
    assert.equal(after.digest, before.digest);
    assert.equal(after.incompleteTail, true);
    assert.equal(after.common.messages.length, 2);
  } finally { await f.runtime.close(); }
});

test('unmanaged Local compaction with an unfamiliar preserved-segment record keeps the whole history', async () => {
  const f = await fixture();
  try {
    const before = await f.runtime.inspect(f.record);
    await f.compact({ preserved: true });
    const after = await f.runtime.inspect(f.record);
    assert.equal(after.common.messages.length, 5);
    assert.equal(fingerprint(after.common, before.common.messages.length), before.digest);
    assert.equal(after.common.meta.compaction.retainedHistory, true);
  } finally { await f.runtime.close(); }
});

test('a Desktop fork carrying its parent session rows is an unsupported source, not an identity to adopt', async () => {
  const f = await fixture();
  try {
    const forkId = randomUUID();
    await assert.rejects(f.runtime.inspect({ ...f.record, nativeId: forkId }), /^Error: Forked Claude history belongs to another native session/);
  } finally { await f.runtime.close(); }
});

test('a transcript-only task notice leaves an original idle and byte-for-byte preserved', async () => {
  const f = await fixture();
  try {
    const before = await f.runtime.inspect(f.record);
    const original = await readFile(f.record.path, 'utf8');
    const parent = original.trim().split('\n').map(JSON.parse).findLast(row => row.type === 'assistant');
    const content = '<task-notification>\n<status>stopped</status>\n</task-notification>';
    const rows = [
      { type: 'queue-operation', operation: 'enqueue', sessionId: f.record.nativeId, content },
      { type: 'queue-operation', operation: 'dequeue', sessionId: f.record.nativeId },
      { type: 'user', uuid: randomUUID(), parentUuid: parent.uuid, sessionId: f.record.nativeId,
        cwd: f.record.cwd, userType: 'external', origin: { kind: 'task-notification' }, promptSource: 'system',
        queueTranscriptOnly: true, queueSkipAttachments: true, message: { role: 'user', content } },
    ];
    const expected = original + rows.map(JSON.stringify).join('\n') + '\n';
    await appendFile(f.record.path, expected.slice(original.length));
    const after = await f.runtime.inspect(f.record);
    assert.equal(after.digest, before.digest);
    assert.equal(after.incompleteTail, false);
    assert.equal(after.bytes, Buffer.byteLength(expected));
    await f.runtime.assertIdle(f.record);
    assert.equal(await readFile(f.record.path, 'utf8'), expected);
  } finally { await f.runtime.close(); }
});

test('an owned history the user compacts interactively keeps its prefix under the retained-history proof', async () => {
  const { claudeCompactionHistory } = await import('../src/compaction.mjs');
  const sessionId = randomUUID(), cwd = '/tmp/synthetic-project', base = { sessionId, cwd };
  const packet = { ...base, type: 'user', uuid: randomUUID(), parentUuid: null, promptSource: 'sdk', queueTranscriptOnly: true,
    message: { role: 'user', content: 'Synthetic authenticated packet.' } };
  const reply = { ...base, type: 'assistant', uuid: randomUUID(), parentUuid: packet.uuid,
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Synthetic reply.' }] } };
  const build = (mutate = () => {}) => {
    const boundary = { ...base, type: 'system', subtype: 'compact_boundary', uuid: randomUUID(), parentUuid: null,
      logicalParentUuid: reply.uuid, compactMetadata: { trigger: 'manual' } };
    // Desktop's own /compact writes a summary that was never queued input.
    const summary = { ...base, type: 'user', uuid: randomUUID(), parentUuid: boundary.uuid, isCompactSummary: true,
      isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'Synthetic readable summary.' } };
    boundary.compactMetadata.preservedSegment = { headUuid: reply.uuid, tailUuid: reply.uuid, anchorUuid: summary.uuid };
    boundary.compactMetadata.preservedMessages = { uuids: [reply.uuid], allUuids: [reply.uuid], anchorUuid: summary.uuid };
    const rows = [packet, reply, boundary, summary];
    mutate({ boundary, summary, rows });
    return rows;
  };
  // An owned history: its packet authenticator never accepts an assistant row.
  const authenticate = () => false;
  const read = rows => claudeCompactionHistory(rows.map(JSON.stringify).join('\n') + '\n', rows, authenticate);
  const result = read(build());
  assert.equal(result.metadata.retainedHistory, true);
  assert.equal(result.metadata.preservedAuthenticatedPackets, 0);
  assert.deepEqual(result.rows.slice(0, 2), [packet, reply]);
  assert.match(result.rows[3].message.content, /^\[Imported native compaction summary; complete earlier verified history is retained\.\]/);
  for (const [mutate, expected] of [
    // A queued summary keeps the stricter owned rule: one authenticated packet.
    [({ summary }) => { summary.queueTranscriptOnly = true; }, /preserved-segment/],
    // The boundary must follow the last row: otherwise earlier history is missing.
    [({ boundary }) => { boundary.logicalParentUuid = packet.uuid; }, /complete persisted prefix/],
    [({ summary }) => { summary.sessionId = randomUUID(); }, /exact native history link/],
  ]) assert.throws(() => read(build(mutate)), expected);
  // Flags and segment descriptions native may change do not alter what is kept.
  for (const mutate of [({ summary }) => { summary.queueTranscriptOnly = false; }, ({ summary }) => { delete summary.isVisibleInTranscriptOnly; },
    ({ boundary }) => { boundary.compactMetadata.preservedMessages.uuids = [randomUUID()]; },
    ({ boundary }) => { boundary.compactMetadata.preservedSegment.anchorUuid = randomUUID(); }])
    assert.deepEqual(read(build(mutate)).rows.slice(0, 2), [packet, reply]);
});
