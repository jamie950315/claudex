import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { encodeArchivedContextPacket } from '../src/context-archive.mjs';
import { encodeClaude, sessionPath } from '../src/claude.mjs';
import { fingerprint } from '../src/history.mjs';

const turn = label => [
  { role: 'user', content: [{ type: 'text', text: `Question ${label}` }] },
  { role: 'assistant', content: [{ type: 'text', text: `Answer ${label}` }] },
];

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cldx-cold-import-')));
  const root = join(base, 'state'), codexHome = join(base, 'codex'), claudeHome = join(base, 'claude'), cwd = join(base, 'project');
  await Promise.all([codexHome, claudeHome, cwd].map(path => mkdir(path)));
  const conversationId = randomUUID(), nativeId = randomUUID(), path = sessionPath(claudeHome, cwd, nativeId);
  const calls = { owner: 0, codex: 0 };
  const runtime = await new DesktopRuntime({ root, codexHome, claudeHome, contextMode: 'archive',
    ownerFactory() { calls.owner++; throw new Error('The native Desktop owns this cold imported session.'); },
    clientFactory() { calls.codex++; throw new Error('No native backend is needed for this read.'); },
  }).initialize();
  const record = { side: 'claude', kind: 'original', managed: false, importPacket: true, packetVersion: 2,
    conversationId, nativeId, path, cwd, title: 'Synthetic cold import', verified: true };
  const messages = turn('imported');
  messages[1].content[0].text += '\nComplete archived content. '.repeat(2000);
  const content = await encodeArchivedContextPacket({ root, archiveVersion: 2, messages, conversationId,
    targetSessionId: nativeId, operationId: 'cold-bootstrap', sourceSide: 'codex', key: runtime.key, maxViewBytes: 1024 });
  const bootstrap = { role: 'user', content };
  await mkdir(dirname(path), { recursive: true });
  const writeNative = nativeMessages => writeFile(path, encodeClaude({
    meta: { id: nativeId, cwd, timestamp: '2026-09-25T00:00:00.000Z' }, messages: nativeMessages,
  }, nativeId).text);
  await writeNative([bootstrap]);
  return { runtime, record, calls, messages, bootstrap, writeNative };
}

test('cold imported originals expand the full authenticated archive without activating any writer', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.record.path, 'utf8');
    assert.ok(before.length < f.messages[1].content[0].text.length);
    const data = await f.runtime.inspect(f.record);
    assert.deepEqual(data.common.messages, f.messages);
    assert.equal(data.digest, fingerprint({ messages: f.messages }));
    assert.equal(data.nativeId, f.record.nativeId);
    assert.equal(data.importedPackets, 1);
    assert.equal(data.incompleteTail, false);
    await f.runtime.assertIdle(f.record);
    assert.equal(await f.runtime.needsMaintenance(f.record), false);
    await f.runtime.completePromotion(f.record);
    assert.deepEqual(f.calls, { owner: 0, codex: 0 });
    assert.equal(f.runtime.owners.size, 0);
    assert.equal(await readFile(f.record.path, 'utf8'), before);
  } finally { await f.runtime.close(); }
});

test('missing exact tracked history pauses explicitly without searching or adopting another path', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.record.path, 'utf8');
    for (const path of [join(dirname(f.record.path), 'missing', 'session.jsonl'), join(f.record.path, 'session.jsonl')]) {
      const record = { ...f.record, path };
      await assert.rejects(f.runtime.inspect(record), error => {
        assert.equal(error.code, 'CLAUDEX_TRACKED_HISTORY_UNAVAILABLE');
        assert.equal(error.side, 'claude'); assert.equal(error.nativeId, record.nativeId);
        assert.equal(error.savedPath, path); assert.equal(error.conversationId, record.conversationId);
        assert.ok(['ENOENT', 'ENOTDIR'].includes(error.cause.code));
        return true;
      });
      await assert.rejects(f.runtime.inspect({ ...record, verified: false }), error => ['ENOENT', 'ENOTDIR'].includes(error.code));
    }
    assert.equal(await readFile(f.record.path, 'utf8'), before);
    assert.deepEqual(f.calls, { owner: 0, codex: 0 });
    const unrelated = Object.assign(new Error('Unrelated native component is unavailable'), { code: 'ENOENT' });
    f.runtime.inspectNative = async () => { throw unrelated; };
    await assert.rejects(f.runtime.inspect(f.record), error => error === unrelated);
    const permission = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    f.runtime.inspectNative = async () => { throw permission; };
    await assert.rejects(f.runtime.inspect({ ...f.record, path: join(dirname(f.record.path), 'missing.jsonl') }), error => error === permission);
  } finally { await f.runtime.close(); }
});

test('cold imports retain later authored turns and withhold an unfinished Desktop tail', async () => {
  const f = await fixture(), authored = turn('authored in Desktop');
  try {
    await f.writeNative([f.bootstrap, ...authored]);
    const complete = await f.runtime.inspect(f.record);
    assert.equal(complete.digest, fingerprint({ messages: [...f.messages, ...authored] }));
    assert.deepEqual(complete.common.messages.slice(0, f.messages.length), f.messages);
    assert.deepEqual(complete.common.messages.slice(f.messages.length).map(({ role, content }) => ({ role, content })), authored);
    await f.runtime.assertIdle(f.record);
    await f.writeNative([f.bootstrap, ...authored, { role: 'user', content: [{ type: 'text', text: 'Still being answered' }] }]);
    const before = await readFile(f.record.path, 'utf8');
    const active = await f.runtime.inspect(f.record);
    assert.equal(active.incompleteTail, true);
    assert.equal(active.digest, complete.digest);
    await assert.rejects(f.runtime.assertIdle(f.record), /Claude turn is still running/);
    assert.equal(await readFile(f.record.path, 'utf8'), before);
    assert.deepEqual(f.calls, { owner: 0, codex: 0 });
  } finally { await f.runtime.close(); }
});

test('cold import authentication failures never fall back to ordinary transcript decoding', async () => {
  const f = await fixture();
  try {
    const key = f.runtime.key;
    f.runtime.key = randomBytes(32);
    await assert.rejects(f.runtime.inspect(f.record), /signature/);
    f.runtime.key = key;
    const changed = structuredClone(f.bootstrap);
    changed.content[0].text += ' Altered transport text';
    await f.writeNative([changed]);
    await assert.rejects(f.runtime.inspect(f.record), /archive|signature|packet/);
    await f.writeNative(turn('replacement without a packet'));
    await assert.rejects(f.runtime.inspect(f.record), /missing its authenticated bootstrap packet/);
    assert.deepEqual(f.calls, { owner: 0, codex: 0 });
  } finally { await f.runtime.close(); }
});

test('incompatible cold import record combinations fail before a native runtime is accessed', async () => {
  const f = await fixture();
  try {
    for (const change of [
      { side: 'codex' }, { kind: 'owner' }, { kind: 'snapshot' }, { managed: true }, { managed: undefined },
      { packetVersion: 1 }, { packetVersion: undefined }, { contextReset: true }, { readResetSourceForOperation: 'reset' },
    ]) {
      const record = { ...f.record, ...change };
      for (const method of ['inspect', 'needsMaintenance', 'completePromotion', 'assertIdle'])
        await assert.rejects(f.runtime[method](record), /unmanaged original Claude sessions with packet version 2/);
    }
    assert.deepEqual(f.calls, { owner: 0, codex: 0 });
  } finally { await f.runtime.close(); }
});

test('cold imported originals cannot use mutation, owner activation, or retirement paths', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.record.path, 'utf8');
    for (const method of ['apply', 'operationApplied', 'activateNormalOwner'])
      await assert.rejects(f.runtime[method](f.record), /read-only to Claudex/);
    for (const method of ['hide', 'remove'])
      await assert.rejects(f.runtime[method](f.record), /Only verified owned Codex snapshots can be retired/);
    assert.equal(await readFile(f.record.path, 'utf8'), before);
    assert.deepEqual(f.calls, { owner: 0, codex: 0 });
  } finally { await f.runtime.close(); }
});
