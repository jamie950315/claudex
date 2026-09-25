import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopRuntime } from '../src/desktop-runtime.mjs';
import { DesktopBridge } from '../src/desktop-bridge.mjs';
import { ColdImporter } from '../src/cold-import.mjs';
import { fingerprint } from '../src/history.mjs';
import { appendClaudeSession, createClaudeSession, sessionPath } from '../src/claude.mjs';
import { snapshot, writeJSON } from '../src/storage.mjs';

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'cldx-cold-import-')));
  const root = join(base, 'state'), codexHome = join(base, 'codex'), claudeHome = join(base, 'claude'), cwd = join(base, 'project');
  await Promise.all([codexHome, claudeHome, cwd].map(path => mkdir(path)));
  const nativeId = randomUUID(), path = join(codexHome, `${nativeId}.jsonl`);
  await writeFile(path, 'Synthetic original bytes\n');
  const common = { meta: { id: nativeId, cwd, title: 'Original title', timestamp: '2026-09-25T00:00:00.000Z' }, messages: [
    { role: 'user', content: [{ type: 'text', text: 'A historical question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'A historical answer' }] },
  ] };
  const runtime = await new DesktopRuntime({ root, codexHome, claudeHome, contextMode: 'archive',
    ownerFactory() { throw new Error('Cold imports must not start an owner'); } }).initialize();
  const inspect = runtime.inspect.bind(runtime);
  runtime.inspect = record => record.side === 'codex'
    ? Promise.resolve({ nativeId, path, common: structuredClone(common), digest: fingerprint(common), bytes: 25, incompleteTail: false })
    : inspect(record);
  const bridge = new DesktopBridge({ root, adapters: runtime.adapters });
  const importer = new ColdImporter({ root, runtime, bridge });
  const input = { nativeId, path, expectedDigest: fingerprint(common), expectedCount: common.messages.length };
  return { base, root, runtime, bridge, importer, input, common, path };
}

test('cold import creates one authenticated original pair without inference or source changes', async () => {
  const f = await fixture(), before = await readFile(f.path);
  const entry = await f.importer.publish(f.input);
  assert.equal(entry.phase, 'paired');
  assert.equal((await f.runtime.inspect(entry.target)).digest, fingerprint(f.common));
  assert.deepEqual(await readFile(f.path), before);
  const state = await f.bridge.status();
  assert.equal(state.records.length, 2);
  assert.ok(state.records.every(record => !record.managed && record.kind === 'original'));
  assert.equal(state.conversations[entry.conversationId].discoveryMode, 'cold-import');
  assert.deepEqual(await f.bridge.sync(entry.conversationId), { changed: false, incompleteTail: false });
  assert.equal(f.runtime.owners.size, 0);
  assert.equal((await f.importer.publish(f.input)).target.nativeId, entry.target.nativeId);
  assert.equal((await f.bridge.status()).records.length, 2);
  await f.runtime.close();
});

test('changed source fails before allocating a cold import', async () => {
  const f = await fixture();
  f.common.messages[1].content[0].text = 'Changed source';
  await assert.rejects(f.importer.publish(f.input), /changed since preflight/);
  assert.deepEqual((await f.importer.status()).sources, {});
  assert.equal((await f.bridge.status()).records.length, 0);
  await f.runtime.close();
});

test('a known pending handoff prevents new cold-import allocation or publication', async () => {
  const f = await fixture(), state = await f.bridge.status();
  state.pending = { phase: 'prepared', operationId: 'synthetic-pending-handoff' };
  await f.bridge.save(state);
  await assert.rejects(f.importer.publish(f.input), /unfinished desktop handoff.*before allocating/);
  assert.deepEqual((await f.importer.status()).sources, {});
  assert.deepEqual(await readdir(f.runtime.claudeHome), []);
  assert.equal(f.runtime.owners.size, 0);
  await f.runtime.close();
});

test('publication recovery reuses its reserved identity without rewriting the native file', async () => {
  const f = await fixture(), pair = f.bridge.trackImportedPair.bind(f.bridge);
  f.bridge.trackImportedPair = async () => { throw new Error('Synthetic crash before pairing'); };
  await assert.rejects(f.importer.publish(f.input), /Synthetic crash/);
  const entry = (await f.importer.status()).sources[f.input.nativeId];
  const before = await readFile(entry.target.path);
  assert.equal(entry.phase, 'prepared');
  f.bridge.trackImportedPair = pair;
  const resumed = await f.importer.publish(f.input);
  assert.equal(resumed.target.nativeId, entry.target.nativeId);
  assert.deepEqual(await readFile(entry.target.path), before);
  await f.runtime.close();
});

test('a changed pending destination is preserved and blocks pairing, not overwritten', async () => {
  const f = await fixture(), pair = f.bridge.trackImportedPair.bind(f.bridge);
  f.bridge.trackImportedPair = async () => { throw new Error('Synthetic crash'); };
  await assert.rejects(f.importer.publish(f.input), /Synthetic crash/);
  const entry = (await f.importer.status()).sources[f.input.nativeId];
  await appendFile(entry.target.path, '{malformed\n');
  const before = await readFile(entry.target.path);
  f.bridge.trackImportedPair = pair;
  await assert.rejects(f.importer.publish(f.input), /Malformed/);
  assert.deepEqual(await readFile(entry.target.path), before);
  assert.equal((await f.bridge.status()).records.length, 0);
  await f.runtime.close();
});

test('a valid JSON transcript with a tampered prepared packet fails authentication without replacement', async () => {
  const f = await fixture(), pair = f.bridge.trackImportedPair.bind(f.bridge);
  f.bridge.trackImportedPair = async () => { throw new Error('Synthetic crash'); };
  await assert.rejects(f.importer.publish(f.input), /Synthetic crash/);
  const entry = (await f.importer.status()).sources[f.input.nativeId];
  const rows = (await readFile(entry.target.path, 'utf8')).trim().split('\n').map(JSON.parse);
  rows.find(row => row.type === 'user').message.content[0].text += ' tampered';
  await writeFile(entry.target.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const before = await readFile(entry.target.path);
  f.bridge.trackImportedPair = pair;
  await assert.rejects(f.importer.publish(f.input), /archive|signature|packet/);
  assert.deepEqual(await readFile(entry.target.path), before);
  assert.equal((await f.bridge.status()).records.length, 0);
  await f.runtime.close();
});

test('Desktop adoption is not claimed until native registry ownership is verified', async () => {
  const f = await fixture(), entry = await f.importer.publish(f.input);
  const desktopHome = join(f.base, 'desktop');
  await assert.rejects(f.importer.verifyAdopted(f.input.nativeId, desktopHome), /has not adopted/);
  await mkdir(desktopHome);
  const uiId = randomUUID();
  await writeFile(join(desktopHome, `local_${uiId}.json`), JSON.stringify({ sessionId: `local_${uiId}`, cliSessionId: entry.target.nativeId }), { mode: 0o600 });
  assert.equal((await f.importer.verifyAdopted(f.input.nativeId, desktopHome)).phase, 'adopted');
  assert.equal((await readdir(desktopHome)).length, 1);
  await f.runtime.close();
});

test('Desktop ownership alone cannot mark a journal as adopted when its paired ledger identity changed', async () => {
  const f = await fixture(), entry = await f.importer.publish(f.input), desktopHome = join(f.base, 'desktop');
  await mkdir(desktopHome);
  const uiId = randomUUID();
  await writeFile(join(desktopHome, `local_${uiId}.json`), JSON.stringify({ sessionId: `local_${uiId}`, cliSessionId: entry.target.nativeId }), { mode: 0o600 });
  const state = await f.bridge.status();
  state.records.find(record => record.nativeId === entry.target.nativeId).conversationId = randomUUID();
  await f.bridge.save(state);
  await assert.rejects(f.importer.verifyAdopted(f.input.nativeId, desktopHome), /does not match the paired ledger/);
  assert.equal((await f.importer.status()).sources[f.input.nativeId].phase, 'paired');
  await f.runtime.close();
});

test('a durable pair with a stale prepared journal recovers after new source work without resending', async () => {
  const f = await fixture(), pair = f.bridge.trackImportedPair.bind(f.bridge);
  f.bridge.trackImportedPair = async input => { await pair(input); throw new Error('Synthetic crash after pairing'); };
  await assert.rejects(f.importer.publish(f.input), /Synthetic crash after pairing/);
  const entry = (await f.importer.status()).sources[f.input.nativeId];
  assert.equal(entry.phase, 'prepared');
  assert.equal((await f.bridge.status()).records.length, 2);
  const before = await readFile(entry.target.path);
  f.common.messages.push({ role: 'user', content: [{ type: 'text', text: 'Later Codex request' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Later Codex answer' }] });
  f.bridge.trackImportedPair = async () => { throw new Error('Recovery must not pair again'); };
  const recovered = await f.importer.publish(f.input);
  assert.equal(recovered.phase, 'paired');
  assert.equal(recovered.target.nativeId, entry.target.nativeId);
  assert.deepEqual(await readFile(entry.target.path), before);
  assert.equal((await f.bridge.status()).records.length, 2);
  assert.equal(f.runtime.owners.size, 0);
  await f.runtime.close();
});

test('public pair enrollment rejects malformed identities and mismatched native identities', async () => {
  const f = await fixture(), entry = await f.importer.publish(f.input);
  const source = { side: 'codex', nativeId: f.input.nativeId, path: f.path, managed: false, kind: 'original' };
  const input = { conversationId: entry.conversationId, source, target: entry.target };
  const before = await f.bridge.status();
  for (const change of [{ source: { ...source, nativeId: 'not-a-uuid' } },
    { target: { ...entry.target, nativeId: 'not-a-uuid' } },
    { target: { ...entry.target, importPacket: false } },
    { target: { ...entry.target, managed: true } },
  ]) await assert.rejects(f.bridge.trackImportedPair({ ...input, ...change }), /Invalid cold-import pair/);
  await assert.rejects(f.bridge.trackImportedPair({ ...input, source: { ...source, nativeId: randomUUID() } }), /different enrollment/);
  assert.deepEqual(await f.bridge.status(), before);
  await f.runtime.close();
});

test('a syntactically valid forged source identity is rejected by native pair inspection', async () => {
  const f = await fixture(), pair = f.bridge.trackImportedPair.bind(f.bridge);
  f.bridge.trackImportedPair = async () => { throw new Error('Synthetic pre-pair stop'); };
  await assert.rejects(f.importer.publish(f.input), /Synthetic pre-pair stop/);
  const entry = (await f.importer.status()).sources[f.input.nativeId];
  await assert.rejects(pair({ conversationId: entry.conversationId,
    source: { side: 'codex', nativeId: randomUUID(), path: f.path, managed: false, kind: 'original' },
    target: entry.target }), /Native source identity changed/);
  assert.equal((await f.bridge.status()).records.length, 0);
  assert.equal(f.runtime.owners.size, 0);
  await f.runtime.close();
});

test('pairing rechecks source content and cwd before saving any enrollment', async () => {
  for (const mutate of [data => { data.common.meta.cwd += '-changed'; },
    data => { data.common.messages[1].content[0].text = 'Changed while pairing'; }]) {
    const f = await fixture(), pair = f.bridge.trackImportedPair.bind(f.bridge);
    f.bridge.trackImportedPair = async () => { throw new Error('Synthetic pre-pair stop'); };
    await assert.rejects(f.importer.publish(f.input), /Synthetic pre-pair stop/);
    const entry = (await f.importer.status()).sources[f.input.nativeId];
    const inspect = f.runtime.adapters.codex.inspect;
    let reads = 0;
    f.runtime.adapters.codex.inspect = async record => {
      const data = await inspect(record);
      if (++reads === 2) mutate(data);
      return data;
    };
    await assert.rejects(pair({ conversationId: entry.conversationId,
      source: { side: 'codex', nativeId: f.input.nativeId, path: f.path, managed: false, kind: 'original' },
      target: entry.target }), /Source changed during cold import/);
    assert.equal((await f.bridge.status()).records.length, 0);
    await f.runtime.close();
  }
});

test('journal identity collisions never adopt another existing pair', async () => {
  const f = await fixture(), entry = await f.importer.publish(f.input);
  const journal = await f.importer.status();
  journal.sources[f.input.nativeId].target.conversationId = randomUUID();
  await writeJSON(f.importer.path, journal);
  const before = await readFile(entry.target.path);
  await assert.rejects(f.importer.publish(f.input), /Invalid cold-import journal entry/);
  assert.deepEqual(await readFile(entry.target.path), before);
  assert.equal((await f.bridge.status()).records.length, 2);
  await f.runtime.close();
});

test('a Local imported reply returns through Codex to a separate managed Claude owner without mutating either original', async () => {
  const f = await fixture(), entry = await f.importer.publish(f.input);
  const codexOriginalBytes = await readFile(f.path), projections = new Map(), owners = [];
  const calls = { plans: 0, archived: [], removed: [] };
  let dependent = true;
  const originalInspect = f.runtime.adapters.codex.inspect;
  Object.assign(f.runtime.adapters.codex, {
    async inspect(record) {
      if (record.nativeId === f.input.nativeId) return originalInspect(record);
      const projection = projections.get(record.nativeId);
      assert.ok(projection);
      return { nativeId: record.nativeId, path: record.path, common: structuredClone(projection.common), bytes: 100 };
    },
    async assertIdle() {},
    async assertCanArchiveOriginal(record) {
      assert.equal(record.managed, false);
      if (dependent) throw new Error('Original has dependent threads');
    },
    async archiveOriginal(record) { await this.assertCanArchiveOriginal(record); calls.archived.push(record.nativeId); return { path: record.path }; },
    async plan({ nativeId }) { calls.plans++; return { nativeId, path: join(f.runtime.codexHome, `${nativeId}.jsonl`), kind: 'snapshot' }; },
    async operationApplied(record) { return projections.has(record.nativeId); },
    async apply(record, common) { projections.set(record.nativeId, { common: structuredClone(common) }); },
    async exists(record) { return record.nativeId === f.input.nativeId || projections.has(record.nativeId); },
    async hide() {},
    async remove(record) { assert.equal(record.managed, true); calls.removed.push(record.nativeId); projections.delete(record.nativeId); },
  });
  f.runtime.ownerFactory = settings => {
    const sessionId = randomUUID(), path = sessionPath(f.runtime.claudeHome, settings.cwd, sessionId), operations = new Set();
    const saved = { sessionId, path, closed: false }; owners.push(saved);
    return {
      async start() {}, async connect() {}, async close() { saved.closed = true; },
      status() { return { sessionId, transcriptPath: path, nativeState: 'idle', closed: saved.closed }; },
      async hasAppend({ operationId }) { return operations.has(operationId); },
      async append({ operationId, content }) {
        assert.equal(operations.size, 0);
        await createClaudeSession({ claudeHome: f.runtime.claudeHome, id: sessionId, title: settings.title,
          common: { meta: { cwd: settings.cwd, timestamp: '2026-09-25T00:00:00.000Z' }, messages: [{ role: 'user', content }] } });
        operations.add(operationId);
      },
      async inspectTranscript() { return snapshot(path); },
    };
  };
  const localTurn = [
    { role: 'user', content: [{ type: 'text', text: 'Local Desktop request' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Local Desktop reply' }] },
  ];
  await appendClaudeSession({ path: entry.target.path, id: entry.target.nativeId,
    expectedHash: (await snapshot(entry.target.path)).hash,
    common: { meta: { cwd: entry.cwd, timestamp: '2026-09-25T00:01:00.000Z' }, messages: localTurn } });
  const localOriginalBytes = await readFile(entry.target.path);
  await assert.rejects(f.bridge.sync(entry.conversationId), /dependent threads/);
  assert.equal(calls.plans, 0);
  assert.equal(owners.length, 0);
  dependent = false;
  await f.bridge.sync(entry.conversationId);
  let state = await f.bridge.status();
  const codex = f.bridge.current(state, entry.conversationId, 'codex');
  assert.equal(codex.managed, true);
  assert.deepEqual(calls.archived, [f.input.nativeId]);
  assert.equal(owners.length, 0);
  const codexTurn = [
    { role: 'user', content: [{ type: 'text', text: 'Later Codex request' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Later Codex reply' }] },
  ];
  projections.get(codex.nativeId).common.messages.push(...codexTurn);
  await f.bridge.sync(entry.conversationId);
  state = await f.bridge.status();
  const currentClaude = f.bridge.current(state, entry.conversationId, 'claude');
  assert.equal(currentClaude.managed, true);
  assert.equal(currentClaude.kind, 'owner');
  assert.notEqual(currentClaude.nativeId, entry.target.nativeId);
  assert.equal(owners.length, 1);
  assert.equal((await f.runtime.inspect(currentClaude)).digest, fingerprint({ messages: [...f.common.messages, ...localTurn, ...codexTurn] }));
  for (const nativeId of [f.input.nativeId, entry.target.nativeId]) {
    const original = state.records.find(record => record.nativeId === nativeId);
    assert.equal(original.status, 'original');
    assert.equal(original.managed, false);
    assert.ok(!calls.removed.includes(nativeId));
  }
  assert.deepEqual(await readFile(f.path), codexOriginalBytes);
  assert.deepEqual(await readFile(entry.target.path), localOriginalBytes);
  assert.equal((await f.importer.publish(f.input)).target.nativeId, entry.target.nativeId);
  assert.equal(owners.length, 1);
  await f.runtime.close();
});
