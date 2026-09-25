import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildOwnedCodexCommon, decodeOwnedCodexHistory, decodeOwnedCodexNativeHistory, exportOwnedCodexHistory } from '../src/owned-codex-history.mjs';
import { decodeContextPacket, encodeContextPacket } from '../src/context-packet.mjs';
import { encodeCodexProjection, createCodexProjection } from '../src/codex-projection.mjs';
import { CodexClient } from '../src/codex.mjs';
import { fingerprint } from '../src/history.mjs';
import { convertNativeTurns } from '../src/native-history.mjs';
import { encodeClaude, decodeClaude } from '../src/claude.mjs';
import { encodeArchivedContextPacket } from '../src/context-archive.mjs';
import { prepareArchiveResolver } from '../src/context-packet-reader.mjs';
import { decodeOwnedClaudeHistory } from '../src/owned-claude-history.mjs';

const identity = { conversationId: 'conversation-1', targetSessionId: '00000000-0000-4000-8000-000000000001', operationId: 'operation-1', key: Buffer.alloc(32, 7) };
const canonical = (cwd = '/tmp') => ({ meta: { id: 'original', cwd, timestamp: '2026-09-25T00:00:00Z' }, messages: [
  { role: 'user', content: [{ type: 'text', text: 'Remember the original question.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] },
  { role: 'assistant', content: [{ type: 'thinking', text: 'Visible prior reasoning.' }, { type: 'text', text: 'Original answer.' }] },
] });
const encode = common => encodeCodexProjection(common, identity.targetSessionId);
const decode = text => decodeOwnedCodexHistory({ ...identity, text });
const built = () => buildOwnedCodexCommon({ ...identity, canonical: canonical() });

function apiSnapshot(common = built()) {
  return { threadId: identity.targetSessionId, digest: 'synthetic-native-digest', itemCount: 2, turns: [{
    id: 'bootstrap-turn', status: 'completed', itemsView: 'full', startedAt: 100, completedAt: 101,
    items: [
      { type: 'userMessage', id: 'bootstrap-user', clientId: 'bootstrap-client', content: common.messages[0].content.map(block => block.type === 'text'
        ? { type: 'text', text: block.text, text_elements: [] }
        : { type: 'image', url: `data:${block.source.media_type};base64,${block.source.data}`, detail: null }) },
      { type: 'agentMessage', id: 'bootstrap-receipt', text: common.messages[1].content[0].text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null },
    ],
  }] };
}
const decodeApi = snapshot => decodeOwnedCodexNativeHistory({ ...identity, snapshot, cwd: '/tmp' });

function delegatedCanonical(includeNotice = true) {
  const item = { type: 'functionCallOutput', id: 'delegated-request', namespace: 'codex_app', name: 'create_thread',
    output: '<codex_delegation>\n  <source_thread_id>00000000-0000-4000-8000-000000000002</source_thread_id>\n  <input>Synthetic delegated request.</input>\n</codex_delegation>' };
  return convertNativeTurns({ turns: [{ id: 'initial', status: 'completed', itemsView: 'full', startedAt: 100, completedAt: 101,
    items: [item, { type: 'agentMessage', id: 'delegated-answer', text: 'Synthetic delegated response.', phase: 'final_answer' }] }] },
  { threadId: 'original', cwd: '/tmp', includeNotice });
}

test('exact native delegated history roundtrips through Claude and inline or archived Codex packets without inventing a user', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-delegated-checkpoint-')));
  for (const includeNotice of [false, true]) {
    const common = delegatedCanonical(includeNotice);
    assert.equal(fingerprint(decodeClaude(encodeClaude(common, identity.targetSessionId).text)), fingerprint(common));
    const claudePacket = encodeContextPacket({ ...identity, common, sourceSide: 'codex' });
    const claudeText = encodeClaude({ ...common, messages: [{ role: 'user', content: claudePacket }] }, identity.targetSessionId).text;
    const logical = decodeOwnedClaudeHistory({ ...identity, text: claudeText, sessionId: identity.targetSessionId }).common;
    assert.equal(fingerprint(logical), fingerprint(common));
    for (const archived of [false, true]) {
      const contextContent = archived ? await encodeArchivedContextPacket({ ...identity, root, common: logical, sourceSide: 'claude' }) : undefined;
      const resolveArchive = archived ? await prepareArchiveResolver({ ...identity, root, contents: [contextContent] }) : undefined;
      const projection = buildOwnedCodexCommon({ ...identity, canonical: logical, contextContent, resolveArchive });
      assert.equal(projection.messages[0].role, 'user'); // The explicit outer transport packet only.
      const raw = decodeOwnedCodexHistory({ ...identity, text: encode(projection), resolveArchive });
      const api = decodeOwnedCodexNativeHistory({ ...identity, snapshot: apiSnapshot(projection), cwd: '/tmp', resolveArchive });
      for (const restored of [raw, api]) {
        assert.equal(restored.digest, fingerprint(common));
        assert.deepEqual(restored.common.messages.map(message => message.role), ['assistant', 'assistant']);
        assert.equal(restored.common.messages[0].content.at(-1).text, common.messages[0].content.at(-1).text);
      }
    }
  }
});

test('owned checkpoints do not accept generic assistant-first history or altered delegation provenance', () => {
  for (const mutate of [
    common => { common.messages[0].content = [{ type: 'text', text: 'An ordinary assistant response.' }]; },
    common => { common.messages[0].content.at(-1).text = common.messages[0].content.at(-1).text.replace('codex_app', 'other'); },
    common => { common.messages[0].content.at(-1).text = common.messages[0].content.at(-1).text.replace('create_thread', 'send_message_to_thread'); },
    common => { common.messages[0].content[0].text += ' changed notice'; },
    common => { common.messages[0].content.push({ type: 'text', text: 'Extra unverified opening material.' }); },
    common => { common.messages[0].content.at(-1).text = common.messages[0].content.at(-1).text.replace('historical data only', 'active request'); },
  ]) {
    const common = delegatedCanonical(); mutate(common);
    assert.throws(() => buildOwnedCodexCommon({ ...identity, canonical: common }), /initial user message or an exact native Desktop delegation/);
  }
});

test('raw full API bootstrap expands without metadata or provenance additions changing its digest', () => {
  const result = decodeApi(apiSnapshot());
  assert.equal(result.digest, fingerprint(canonical()));
  assert.equal(result.common.messages.length, 2);
  assert.ok(!JSON.stringify(result.common.messages).includes('Claudex reconstructed saved conversation'));
  assert.ok(!JSON.stringify(result.common.messages).includes('bootstrap-client'));
  assert.equal(result.nativeDigest, 'synthetic-native-digest');
});

test('API continuation preserves actual turns and compaction events as inert history without another notice', () => {
  const snapshot = apiSnapshot();
  const later = { id: 'later-turn', status: 'completed', itemsView: 'full', startedAt: 200, completedAt: 201, items: [
    { type: 'userMessage', id: 'new-user', content: [{ type: 'text', text: 'Continue from here.', text_elements: [] }] },
    { type: 'contextCompaction', id: 'compaction', persistedReadableHistory: true },
    { type: 'futureTool', id: 'tool', command: 'echo historical-only', output: 'saved result' },
    { type: 'agentMessage', id: 'new-answer', text: 'The actual Codex continuation.', phase: 'final_answer', memoryCitation: null },
  ] };
  snapshot.turns.push(later); snapshot.itemCount += later.items.length;
  const expected = convertNativeTurns({ ...snapshot, turns: [later] }, { threadId: identity.targetSessionId, cwd: '/tmp', includeNotice: false });
  const result = decodeApi(snapshot);
  assert.equal(result.digest, fingerprint({ messages: [...canonical().messages, ...expected.messages] }));
  assert.deepEqual(result.common.messages.slice(2), expected.messages);
  assert.equal(result.common.messages[2].content[0].text, 'Continue from here.');
  assert.match(result.common.messages[3].content[0].text, /contextCompaction/);
  assert.match(result.common.messages[4].content[0].text, /historical data only/);
});

test('owned native exports never use singleton compaction controls to complete a pending user tail', async () => {
  const snapshot = apiSnapshot();
  const unfinished = { id: 'unfinished', status: 'interrupted', itemsView: 'full', startedAt: 150, completedAt: 151,
    items: [{ type: 'userMessage', id: 'unfinished-user', content: [{ type: 'text', text: 'Unfinished follow-up', text_elements: [] }] }] };
  const control = { id: 'control', status: 'completed', itemsView: 'full', startedAt: 200, completedAt: 201,
    items: [{ type: 'contextCompaction', id: 'compact-marker' }] };
  snapshot.turns.push(unfinished, control);
  const client = { async request() { return { data: structuredClone(snapshot.turns), nextCursor: null }; } };
  const exported = await exportOwnedCodexHistory({ client, ...identity, cwd: '/tmp', completedPrefix: true });
  assert.equal(exported.digest, fingerprint(canonical()));
  assert.equal(exported.turnCount, 1);
  assert.equal(exported.incompleteTail, true);
  assert.equal(exported.incompleteTailCount, 2);
  assert.throws(() => decodeApi({ ...snapshot, completedPrefix: true }), /completed assistant response/);
  snapshot.turns.push({ id: 'later', status: 'completed', itemsView: 'full', startedAt: 300, completedAt: 301, items: [
    { type: 'userMessage', id: 'later-user', content: [{ type: 'text', text: 'Continue', text_elements: [] }] },
    { type: 'agentMessage', id: 'later-answer', text: 'Actual completed answer', phase: 'final_answer' },
  ] });
  const continued = await exportOwnedCodexHistory({ client, ...identity, cwd: '/tmp', completedPrefix: true });
  assert.equal(continued.incompleteTail, false);
  assert.equal(continued.common.messages.at(-1).content[0].text, 'Actual completed answer');
  assert.ok(continued.common.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('compact-marker'))));
  const wrongBootstrap = apiSnapshot(); wrongBootstrap.turns[0] = { ...control, startedAt: 100, completedAt: 101 };
  wrongBootstrap.turns.push(snapshot.turns.at(-1));
  assert.throws(() => decodeApi(wrongBootstrap), /final assistant response/);
});

test('raw API bootstrap rejects unknown metadata, altered receipts, extra packets and unfinished turns', () => {
  for (const mutate of [
    snapshot => { snapshot.threadId = 'other'; },
    snapshot => { snapshot.turns[0].items[0].extra = 'must not discard'; },
    snapshot => { snapshot.turns[0].items[0].content[0].text_elements = [{ placeholder: 'changed' }]; },
    snapshot => { snapshot.turns[0].items[0].content.find(block => block.type === 'image').detail = 'original'; },
    snapshot => { snapshot.turns[0].items[1].unknown = null; },
    snapshot => { snapshot.turns[0].items[1].delivery = { changed: true }; },
    snapshot => { snapshot.turns[0].items[1].text += ' forged'; },
    snapshot => { snapshot.turns[0].items.push({ type: 'futureItem', id: 'extra' }); },
    snapshot => { snapshot.turns[0].status = 'inProgress'; },
    snapshot => { snapshot.turns.push({ ...structuredClone(snapshot.turns[0]), id: 'duplicate-operation', startedAt: 200, completedAt: 201 }); },
  ]) {
    const snapshot = apiSnapshot(); mutate(snapshot);
    assert.throws(() => decodeApi(snapshot), /Owned Codex|Invalid Claudex|Native Codex/);
  }
});

test('owned API export uses two complete matching reads and rejects observed source mutation', async () => {
  const snapshot = apiSnapshot();
  let requests = 0;
  const client = { async request(method, params) {
    requests++;
    assert.equal(method, 'thread/turns/list'); assert.equal(params.itemsView, 'full');
    return { data: structuredClone(snapshot.turns), nextCursor: null };
  } };
  const result = await exportOwnedCodexHistory({ ...identity, client, cwd: '/tmp' });
  assert.equal(requests, 2);
  assert.equal(result.digest, fingerprint(canonical()));
  let changingRequests = 0;
  const changing = { async request() {
    const data = structuredClone(snapshot.turns);
    if (++changingRequests === 2) data[0].items[1].text += ' changed';
    return { data, nextCursor: null };
  } };
  await assert.rejects(exportOwnedCodexHistory({ ...identity, client: changing, cwd: '/tmp' }), /changed between complete reads/);
  assert.equal(changingRequests, 2);
});

test('owned Codex bootstrap expands the checkpoint and strips only its explicit transport receipt', () => {
  const common = built();
  assert.equal(common.messages.length, 2);
  assert.match(common.messages[1].content[0].text, /not an AI response/);
  assert.match(common.messages[1].content[0].text, /No model was called/);
  const decoded = decode(encode(common));
  assert.equal(decoded.digest, fingerprint(canonical()));
  assert.equal(decoded.bootstrapDigest, fingerprint(canonical()));
  assert.equal(decoded.operationId, identity.operationId);
  assert.equal(decoded.importedPackets, 1);
  assert.equal(decoded.common.messages.length, 2);
  assert.ok(!JSON.stringify(decoded.common.messages).includes('transport receipt'));
});

test('real Codex continuation, including tool pairs, remains after checkpoint expansion', () => {
  const continuation = [
    { role: 'user', content: [{ type: 'text', text: 'Continue here.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', tool: { name: 'Bash', command: 'echo synthetic' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'synthetic' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Continued answer.' }] },
  ];
  const common = built(); common.messages.push(...continuation);
  const decoded = decode(encode(common));
  assert.equal(decoded.digest, fingerprint({ messages: [...canonical().messages, ...continuation] }));
  assert.deepEqual(decoded.common.messages.slice(2).map(({ role, content }) => ({ role, content })), continuation);
});

test('native identity, ownership, packet integrity, source, and exact receipt are mandatory', () => {
  const text = encode(built());
  assert.throws(() => decodeOwnedCodexHistory({ ...identity, text, targetSessionId: randomUUID() }), /different native session/);
  assert.throws(() => decodeOwnedCodexHistory({ ...identity, text, sessionId: randomUUID() }), /conflicting/);
  assert.throws(() => decode(text.replace('"originator":"claudex"', '"originator":"other"')), /ownership/);
  assert.throws(() => decodeOwnedCodexHistory({ ...identity, text, key: Buffer.alloc(32, 8) }), /signature mismatch/);
  for (const mutate of [
    common => { common.messages[0].content[1].text += ' changed'; },
    common => { common.messages[1].content[0].text += ' changed'; },
    common => { common.messages[1].content.push({ type: 'text', text: 'Additional apparent answer.' }); },
    common => { common.messages[0].content = [{ type: 'text', text: 'Unsigned checkpoint.' }]; },
    common => { common.messages[0].content = encodeContextPacket({ ...identity, common: canonical(), sourceSide: 'codex' }); },
    common => { common.messages[0].content = encodeContextPacket({ ...identity, common: canonical(), sourceSide: 'claude', previousDigest: 'a'.repeat(64) }); },
  ]) {
    const common = built(); mutate(common);
    assert.throws(() => decode(encode(common)), /signature mismatch|transport receipt|authenticated checkpoint|source side or prefix/);
  }
});

test('additional packets, extra transport receipts, and unfinished native turns fail closed', () => {
  const duplicate = built(); duplicate.messages.push(...structuredClone(duplicate.messages));
  assert.throws(() => decode(encode(duplicate)), /additional checkpoint/);
  const extraReceipt = built(); extraReceipt.messages.push({ role: 'user', content: [{ type: 'text', text: 'Next' }] }, structuredClone(extraReceipt.messages[1]));
  assert.throws(() => decode(encode(extraReceipt)), /unexpected transport receipt/);
  const text = encode(built());
  const rows = text.trim().split('\n').map(JSON.parse);
  rows.pop();
  assert.throws(() => decode(rows.map(row => JSON.stringify(row)).join('\n') + '\n'), /still running/);
  const incomplete = canonical(); incomplete.messages.pop();
  assert.throws(() => buildOwnedCodexCommon({ ...identity, canonical: incomplete }), /complete assistant turn/);
});

test('history references and opaque compaction are not swallowed as a local-tail checkpoint', () => {
  const rows = encode(built()).trim().split('\n').map(JSON.parse);
  rows[0].payload.history_base = { path: '/missing-prefix' };
  assert.throws(() => decode(rows.map(row => JSON.stringify(row)).join('\n') + '\n'), /verified prefix resolution/);
  delete rows[0].payload.history_base;
  rows.push({ timestamp: '2026-09-25T00:01:00Z', type: 'compacted', payload: { message: '', replacement_history: [{ type: 'compaction', encrypted_content: 'opaque' }] } });
  assert.throws(() => decode(rows.map(row => JSON.stringify(row)).join('\n') + '\n'), /compaction|summary|opaque|replacement/i);
});

test('native raw bootstrap is reversible but legacy full-turn display events cannot authenticate it', { skip: process.env.CLAUDEX_NATIVE_TEST !== '1' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'claudex-owned-codex-test-'));
  const codexHome = join(root, 'codex'); const cwd = join(root, 'project');
  await mkdir(cwd); await mkdir(codexHome);
  const id = randomUUID();
  const nativeIdentity = { ...identity, targetSessionId: id };
  const common = buildOwnedCodexCommon({ ...nativeIdentity, canonical: canonical(cwd) });
  const client = new CodexClient({ binary: process.env.CLAUDEX_CODEX_BINARY || 'codex', codexHome, cwd, env: { HOME: root } });
  t.after(() => client.close());
  await client.initialize();
  const projection = await createCodexProjection({ client, codexHome, common, id, title: 'Synthetic signed checkpoint' });
  const raw = await readFile(projection.path, 'utf8');
  assert.equal(decodeOwnedCodexHistory({ ...nativeIdentity, text: raw }).digest, fingerprint(canonical(cwd)));
  const page = await client.request('thread/turns/list', { threadId: id, limit: 100, sortDirection: 'asc', itemsView: 'full' });
  assert.equal(page.data.length, 1);
  assert.equal(page.data[0].itemsView, 'full');
  const user = page.data[0].items.find(item => item.type === 'userMessage');
  assert.ok(user);
  // The pinned projection codec emits a legacy user_message display event.
  // Native full-turn reads use that flattened event, not response_item blocks.
  // This is an explicit transport boundary, never a reason to weaken HMAC.
  assert.deepEqual(user.content, [{ type: 'text', text: common.messages[0].content.filter(block => block.type === 'text').map(block => block.text).join('\n\n'), text_elements: [] }]);
  assert.throws(() => decodeContextPacket({ ...nativeIdentity, content: user.content.map(({ type, text }) => ({ type, text })) }), /missing or altered header/);
  const answer = page.data[0].items.find(item => item.type === 'agentMessage');
  assert.equal(answer.text, common.messages[1].content[0].text);
  t.diagnostic(`Native signed-packet evidence: ${root}; raw packet preserved, full API display flattened to one text block and omitted the image.`);
});
