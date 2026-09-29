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

test('unmanaged Local preserved-segment compaction remains explicit rather than inventing a history link', async () => {
  const f = await fixture();
  try {
    await f.compact({ preserved: true });
    await assert.rejects(f.runtime.inspect(f.record), /preserved-segment/);
  } finally { await f.runtime.close(); }
});

test('a Desktop fork carrying its parent session rows is an unsupported source, not an identity to adopt', async () => {
  const f = await fixture();
  try {
    const forkId = randomUUID();
    await assert.rejects(f.runtime.inspect({ ...f.record, nativeId: forkId }), /^Error: Forked Claude history belongs to another native session/);
  } finally { await f.runtime.close(); }
});
