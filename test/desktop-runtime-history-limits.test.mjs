import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { NATIVE_HISTORY_LIMITS, convertNativeTurns } from '../src/native-history.mjs';
import { buildOwnedCodexCommon } from '../src/owned-codex-history.mjs';
import { encodeArchivedContextPacket } from '../src/context-archive.mjs';
import { prepareArchiveResolver } from '../src/context-packet-reader.mjs';
import { fingerprint } from '../src/history.mjs';

const apiTurn = (index, content, answer) => ({ id: `turn-${index}`, status: 'completed', itemsView: 'full', items: [
  { id: `user-${index}`, type: 'userMessage', content: content.map(block => ({ ...block, text_elements: [] })) },
  { id: `answer-${index}`, type: 'agentMessage', text: answer, phase: 'final_answer' },
] });

async function fixture(t, { managed = false, text = 'Complete source answer', count = 1, ...options } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cldx-runtime-limits-')));
  const root = join(base, 'state'), codexHome = join(base, 'codex'), claudeHome = join(base, 'claude'), cwd = join(base, 'project');
  await Promise.all([codexHome, claudeHome, cwd].map(path => mkdir(path)));
  const nativeId = randomUUID(), conversationId = randomUUID(), path = join(codexHome, 'sessions', `rollout-${nativeId}.jsonl`);
  await mkdir(join(codexHome, 'sessions'));
  await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: nativeId, cwd } }) + '\n');
  const calls = [], turns = [];
  const client = {
    async initialize() { return { codexHome }; }, async close() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/read') return { thread: { id: nativeId, cwd, path, status: { type: 'idle' } } };
      assert.equal(method, 'thread/turns/list');
      const offset = params.cursor ? Number(params.cursor) : 0, next = offset + params.limit;
      return { data: turns.slice(offset, next), nextCursor: next < turns.length ? String(next) : null };
    },
  };
  const runtime = await new DesktopRuntime({ root, codexHome, claudeHome, ...options,
    clientFactory: async () => client, ownerFactory() { throw new Error('No Claude worker is needed'); } }).initialize();
  t.after(() => runtime.close());
  const common = { meta: { id: nativeId, cwd }, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Complete source request' }] },
    { role: 'assistant', content: [{ type: 'text', text }] },
  ] };
  if (managed) {
    const identity = { conversationId, targetSessionId: nativeId, operationId: 'synthetic-bootstrap', key: runtime.key };
    const content = await encodeArchivedContextPacket({ ...identity, root, common, sourceSide: 'claude', archiveVersion: 2, maxViewBytes: 1024 });
    const resolveArchive = await prepareArchiveResolver({ ...identity, root, contents: [content] });
    const projected = buildOwnedCodexCommon({ ...identity, canonical: common, contextContent: content, resolveArchive });
    turns.push(apiTurn(0, projected.messages[0].content, projected.messages[1].content[0].text));
  } else turns.push(apiTurn(0, common.messages[0].content, text));
  for (let index = 1; index < count; index++) turns.push(apiTurn(index, [{ type: 'text', text: `Request ${index}` }], `Answer ${index}`));
  const record = { side: 'codex', nativeId, conversationId, path, cwd, managed, kind: managed ? 'snapshot' : 'original' };
  return { runtime, record, common, turns, calls };
}

test('Desktop native history defaults retain 16 MiB and 100-turn pages on both export paths', async t => {
  for (const managed of [false, true]) {
    const f = await fixture(t, { managed });
    assert.equal(f.runtime.nativeHistoryMaxBytes, 16 * 1024 * 1024);
    assert.equal(f.runtime.nativeHistoryPageSize, 100);
    await f.runtime.inspect(f.record);
    const reads = f.calls.filter(call => call.method === 'thread/turns/list');
    assert.equal(reads.length, 2);
    assert.ok(reads.every(call => call.params.limit === 100 && call.params.itemsView === 'full'));
  }
});

test('explicit page sizes reach both native readers without changing stable two-pass history', async t => {
  for (const managed of [false, true]) {
    const f = await fixture(t, { managed, count: 7, nativeHistoryPageSize: 5, nativeHistoryMaxBytes: 64 * 1024 * 1024 });
    const data = await f.runtime.inspect(f.record);
    const reads = f.calls.filter(call => call.method === 'thread/turns/list');
    assert.equal(data.turnCount, 7);
    assert.equal(reads.length, 4);
    assert.ok(reads.every(call => call.params.limit === 5));
    assert.deepEqual(reads.map(call => call.params.cursor), [undefined, '5', undefined, '5']);
    assert.equal(data.incompleteTail, false);
  }
});

test('normal full API history and a matching verified prefix never request late raw proof', async t => {
  for (const managed of [false, true]) {
    const f = await fixture(t, { managed });
    const continuation = apiTurn(1, [{ type: 'text', text: 'Historical command request' }], 'Completed answer');
    continuation.items.splice(1, 0, { type: 'commandExecution', id: randomUUID(), source: 'unifiedExecStartup',
      status: 'failed', command: 'Historical command', aggregatedOutput: 'Historical output', exitCode: -1 });
    f.turns.push(continuation);
    // This deliberately refuses the late resolver's strict private-file guard.
    // No large fixture is needed: entering raw proof would fail immediately.
    await chmod(f.record.path, 0o644);
    const before = await readFile(f.record.path);
    const fresh = await f.runtime.inspect(f.record);
    assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, 2);
    Object.assign(f.record, { verified: true, checkpoint: { count: fresh.common.messages.length, digest: fresh.digest } });
    f.calls.length = 0;
    const verified = await f.runtime.inspect(f.record);
    assert.equal(verified.digest, fresh.digest);
    assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, 2);
    assert.deepEqual(await readFile(f.record.path), before);
  }
});

test('a verified prefix mismatch invokes strict late proof and preserves native refusal without replay', async t => {
  for (const managed of [false, true]) {
    const f = await fixture(t, { managed });
    const continuation = apiTurn(1, [{ type: 'text', text: 'Historical command request' }], 'Completed answer');
    const command = { type: 'commandExecution', id: randomUUID(), source: 'unifiedExecStartup',
      status: 'failed', command: 'Historical command', aggregatedOutput: 'Original output', exitCode: -1 };
    continuation.items.splice(1, 0, command); f.turns.push(continuation);
    await chmod(f.record.path, 0o644);
    const baseline = await f.runtime.inspect(f.record), before = await readFile(f.record.path);
    Object.assign(f.record, { verified: true, checkpoint: { count: baseline.common.messages.length, digest: baseline.digest } });
    command.aggregatedOutput = 'Changed historical output'; f.calls.length = 0;
    await assert.rejects(f.runtime.inspect(f.record), /Native Codex late item: source must be a private, owned, single-link bounded regular file/);
    assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, 3);
    assert.deepEqual(await readFile(f.record.path), before);
    assert.deepEqual(f.record.checkpoint, { count: baseline.common.messages.length, digest: baseline.digest });
  }
});

test('a configured original-history byte budget rejects oversized raw pages without a partial result or retry', async t => {
  const text = 'Every byte must be preserved. '.repeat(1000);
  const f = await fixture(t, { text, nativeHistoryMaxBytes: 4096 });
  await assert.rejects(f.runtime.inspect(f.record), error =>
    /Native Codex history export: byte limit exceeded; no partial export is returned/.test(error.message)
    && error.message.includes(f.record.nativeId));
  assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, 1);
  f.runtime.nativeHistoryMaxBytes = 65536;
  const data = await f.runtime.inspect(f.record);
  const expected = convertNativeTurns({ turns: f.turns }, { threadId: f.record.nativeId, cwd: f.record.cwd });
  assert.equal(data.digest, fingerprint(expected));
  assert.equal(data.common.messages.at(-1).content[0].text, text);
});

test('managed history applies the configured byte budget after exact archive expansion', async t => {
  const f = await fixture(t, { managed: true, text: 'Complete archived bytes. '.repeat(1000), nativeHistoryMaxBytes: 4096 });
  assert.ok(Buffer.byteLength(JSON.stringify({ data: f.turns, nextCursor: null })) < 4096);
  await assert.rejects(f.runtime.inspect(f.record), error =>
    /Owned Codex history exceeds the converted byte limit; no partial history was returned/.test(error.message)
    && error.message.includes(f.record.nativeId));
  assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, 2);
  f.runtime.nativeHistoryMaxBytes = 65536;
  const data = await f.runtime.inspect(f.record);
  assert.equal(data.digest, fingerprint(f.common));
  assert.deepEqual(data.common.messages, f.common.messages);
});

test('smaller explicit pages do not raise the unchanged 256-page ceiling', async t => {
  const f = await fixture(t, { count: 257, nativeHistoryPageSize: 1, nativeHistoryMaxBytes: 64 * 1024 * 1024 });
  await assert.rejects(f.runtime.inspect(f.record), /page limit exceeded; no partial export is returned/);
  assert.equal(f.calls.filter(call => call.method === 'thread/turns/list').length, 256);
  assert.equal(NATIVE_HISTORY_LIMITS.maxItems, 25000);
  assert.equal(NATIVE_HISTORY_LIMITS.maxPages, 256);
});

test('invalid Desktop byte or page limits fail before native clients or owners are created', () => {
  const options = { root: '/unused', codexHome: '/unused-codex', claudeHome: '/unused-claude',
    clientFactory() { assert.fail('No native client may be started'); }, ownerFactory() { assert.fail('No native owner may be started'); } };
  for (const nativeHistoryMaxBytes of [null, 0, 1023, 1.5, '16777216', Infinity, NaN, 64 * 1024 * 1024 + 1])
    assert.throws(() => new DesktopRuntime({ ...options, nativeHistoryMaxBytes }), /nativeHistoryMaxBytes must be an integer/);
  for (const nativeHistoryPageSize of [null, 0, 101, 1.5, '5', Infinity, NaN])
    assert.throws(() => new DesktopRuntime({ ...options, nativeHistoryPageSize }), /nativeHistoryPageSize must be an integer/);
  assert.doesNotThrow(() => new DesktopRuntime({ ...options, nativeHistoryMaxBytes: 1024, nativeHistoryPageSize: 1 }));
  assert.doesNotThrow(() => new DesktopRuntime({ ...options, nativeHistoryMaxBytes: 64 * 1024 * 1024, nativeHistoryPageSize: 100 }));
});
