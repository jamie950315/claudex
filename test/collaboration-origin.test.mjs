import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, writeFile, rm, symlink, link, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createOriginVerifier } from '../src/collaboration-origin.mjs';
import { sessionPath } from '../src/claude.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const CWD = '/fixture';
const params = { provider: 'claude', cwd: CWD, prompt: 'Do not persist this private prompt', requestId: 'origin-1',
  notifications: { mode: 'queue' } };
const receipt = { taskId: TASK, revision: 1, status: 'ready', originChallenge: 'a'.repeat(64) };
const fingerprint = createHash('sha256').update(JSON.stringify({ method: 'start', params })).digest('hex');
const input = provider => ({ provider, sessionId: ID, cwd: CWD, toolUseId: 'toolu_origin',
  ...(provider === 'codex' ? { turnId: 'turn-1' } : {}), expectedFingerprint: fingerprint, expectedReceipt: receipt });
const content = value => [{ type: 'text', text: JSON.stringify(value) }];
const clone = value => structuredClone(value);
const nativeItem = () => ({ turnId: 'turn-1', item: { type: 'mcpToolCall', id: 'toolu_origin', server: 'claudex-work',
  tool: 'claudex_start', status: 'completed', arguments: clone(params), error: null,
  result: { content: content(receipt), structuredContent: null } } });

function codexFixture({ item = nativeItem(), metadata = {}, pages, now } = {}) {
  const requests = []; let closed = 0, pageIndex = 0;
  const client = { initialize: async () => {}, close: async () => { closed++; }, request: async (method, args) => {
    requests.push({ method, args });
    if (method === 'thread/read') return { thread: { id: ID, sessionId: ID, cwd: CWD, parentThreadId: null,
      ephemeral: false, threadSource: 'user', source: 'vscode', ...metadata } };
    assert.equal(method, 'thread/items/list');
    return pages ? pages[pageIndex++] : { data: [item], nextCursor: null };
  } };
  return { verify: createOriginVerifier({ clientFactory: () => client, now }), requests, closed: () => closed };
}

test('Codex independently verifies exact completed native MCP result without reading all turns', async () => {
  const fixture = codexFixture({ now: () => 1234 });
  assert.deepEqual(await fixture.verify(input('codex')), { provider: 'codex', sessionId: ID, cwd: CWD,
    toolUseId: 'toolu_origin', turnId: 'turn-1', source: 'codex-native-mcp-result', verifiedAt: 1234 });
  assert.equal(fixture.closed(), 1);
  assert.equal(fixture.requests.filter(r => r.method === 'thread/items/list').length, 1);
  assert.ok(fixture.requests.filter(r => r.method === 'thread/read').every(r => r.args.includeTurns === false));
  assert.equal(fixture.requests.find(r => r.method === 'thread/items/list').args.turnId, 'turn-1');
});

test('Codex rejects wrong identity, auxiliary sources, unfinished or altered native calls', async t => {
  for (const [name, mutate] of Object.entries({
    server: i => { i.item.server = 'other'; }, tool: i => { i.item.tool = 'claudex_list'; },
    error: i => { i.item.error = { message: 'private failure' }; },
    isError: i => { i.item.result.isError = true; }, arguments: i => { i.item.arguments.requestId = 'other'; },
    replay: i => { i.item.result.content = content({ ...receipt, replayed: true }); },
    nonce: i => { i.item.result.content = content({ ...receipt, originChallenge: 'b'.repeat(64) }); },
    result: i => { i.item.result.content = content({ ...receipt, taskId: ID }); },
    structured: i => { i.item.result.structuredContent = { ...receipt, revision: 99 }; },
    extraContent: i => { i.item.result.content.push({ type: 'text', text: 'other' }); },
    turn: i => { i.turnId = 'other'; },
  })) await t.test(name, async () => {
    const item = nativeItem(); mutate(item); const f = codexFixture({ item });
    await assert.rejects(f.verify(input('codex')), { code: 'ORIGIN_PROOF_INVALID' }); assert.equal(f.closed(), 1);
  });
  for (const metadata of [{ id: TASK }, { cwd: '/other' }, { sessionId: TASK }, { ephemeral: true },
    { parentThreadId: TASK }, { threadSource: 'subagent' }, { source: { subAgent: {} } }, { source: 'exec' }]) {
    const f = codexFixture({ metadata });
    await assert.rejects(f.verify(input('codex')), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
    assert.equal(f.requests.length, 1);
  }
});

test('Codex inspects bounded exact-turn pages completely and rejects duplicate or incomplete evidence', async () => {
  const f = codexFixture({ pages: [{ data: [nativeItem()], nextCursor: 'next' }, { data: [], nextCursor: null }] });
  await f.verify(input('codex'));
  const duplicate = codexFixture({ pages: [{ data: [nativeItem()], nextCursor: 'next' }, { data: [nativeItem()], nextCursor: null }] });
  await assert.rejects(duplicate.verify(input('codex')), { code: 'ORIGIN_PROOF_INVALID' });
  const bounded = codexFixture({ pages: Array.from({ length: 4 }, (_, i) => ({ data: [], nextCursor: `page-${i}` })) });
  await assert.rejects(bounded.verify(input('codex')), { code: 'ORIGIN_PROOF_BOUND_EXCEEDED' });
  const missing = codexFixture({ pages: [{ data: [], nextCursor: null }] });
  await assert.rejects(missing.verify(input('codex')), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
  const withoutTurn = input('codex'); delete withoutTurn.turnId;
  await assert.rejects(f.verify(withoutTurn), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
});

test('native result not yet persisted remains unverified and can be checked again without replay', async () => {
  const item = nativeItem(); item.item.status = 'inProgress'; item.item.result = null;
  const fixture = codexFixture({ item });
  await assert.rejects(fixture.verify(input('codex')), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
  item.item.status = 'completed';
  await assert.rejects(fixture.verify(input('codex')), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
  item.item.result = nativeItem().item.result;
  await fixture.verify(input('codex'));
  assert.ok(fixture.requests.every(r => ['thread/read', 'thread/items/list'].includes(r.method)));
});

function claudeRows() {
  return [
    { type: 'assistant', uuid: 'assistant-1', parentUuid: null, sessionId: ID, cwd: CWD, isSidechain: false,
      version: '2.1.281', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_origin',
        name: 'mcp__claudex-work__claudex_start', input: clone(params) }] } },
    { type: 'user', uuid: 'result-1', parentUuid: 'assistant-1', sourceToolAssistantUUID: 'assistant-1',
      sessionId: ID, cwd: CWD, isSidechain: false, version: '2.1.281', message: { role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_origin', content: content(receipt) }] } },
  ];
}
const serialize = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
function claudeFixture({ rows = claudeRows(), mapping = {}, changeMapping = false, readClaude, now } = {}) {
  let reads = 0; const paths = [];
  const map = { nativeId: ID, sessionId: `local_${ID}`, cwd: CWD, isArchived: false, registryPath: '/native/record', ...mapping };
  return { paths, verify: createOriginVerifier({ claudeHome: '/native/home', now,
    mappings: async (_root, ids) => { assert.deepEqual(ids, [ID]); return new Map([[ID,
      { ...map, ...(changeMapping && reads++ ? { isArchived: true } : {}) }]]); },
    readClaude: readClaude ?? (async path => { paths.push(path); return serialize(rows); }),
  }) };
}

test('Claude verifies the exact Desktop-mapped native call/result and exports no private content', async () => {
  const f = claudeFixture({ now: () => 1234 });
  assert.deepEqual(await f.verify(input('claude')), { provider: 'claude', sessionId: ID, cwd: CWD,
    toolUseId: 'toolu_origin', source: 'claude-native-mcp-result', verifiedAt: 1234 });
  assert.deepEqual(f.paths, [sessionPath('/native/home', CWD, ID)]);
});

test('Claude rejects forged pair, copied session, sidechain, replay, projection and changed registry', async t => {
  for (const [name, mutate] of Object.entries({
    source: rows => { rows[1].sourceToolAssistantUUID = 'other'; },
    parent: rows => { rows[1].parentUuid = 'missing'; },
    role: rows => { rows[0].message.role = 'user'; },
    session: rows => { rows[0].sessionId = TASK; },
    cwd: rows => { rows[1].cwd = '/other'; },
    sidechain: rows => { rows[0].isSidechain = true; },
    tool: rows => { rows[0].message.content[0].name = 'Bash'; },
    failed: rows => { rows[1].message.content[0].is_error = true; },
    nonce: rows => { rows[1].message.content[0].content = content({ ...receipt, originChallenge: 'b'.repeat(64) }); },
    replay: rows => { rows[1].message.content[0].content = content({ ...receipt, replayed: true }); },
    duplicate: rows => { rows.push(clone(rows[0])); },
    projection: rows => { rows.push({ type: 'claudex-owner', sessionId: ID }); },
  })) await t.test(name, async () => {
    const rows = claudeRows(); mutate(rows);
    await assert.rejects(claudeFixture({ rows }).verify(input('claude')), { code: 'ORIGIN_PROOF_INVALID' });
  });
  for (const mapping of [{ nativeId: TASK }, { cwd: '/other' }, { isArchived: true }, { sessionId: null }])
    await assert.rejects(claudeFixture({ mapping }).verify(input('claude')), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
  await assert.rejects(claudeFixture({ changeMapping: true }).verify(input('claude')), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
});

test('Claude permits a verified bounded intervening parent chain but rejects missing output and partial input', async () => {
  const rows = claudeRows(); rows[1].parentUuid = 'intervening';
  rows.push({ type: 'system', uuid: 'intervening', parentUuid: 'assistant-1', sessionId: ID, cwd: CWD, isSidechain: false });
  await claudeFixture({ rows }).verify(input('claude'));
  await assert.rejects(claudeFixture({ rows: claudeRows().slice(0, 1) }).verify(input('claude')), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
  await assert.rejects(claudeFixture({ readClaude: async () => serialize(claudeRows()).trimEnd() }).verify(input('claude')),
    { code: 'ORIGIN_PROOF_UNAVAILABLE' });
});

test('default Claude reader accepts native 0755 directories but rejects foreign writes, aliases and hardlinks', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-origin-')));
  await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), path = sessionPath(home, CWD, ID);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Set the native mode explicitly: a test-process umask must not hide this
  // actual Desktop state and make a private-directory-only verifier look valid.
  await chmod(home, 0o755); await chmod(dirname(path), 0o755);
  await writeFile(path, serialize(claudeRows()), { mode: 0o600 });
  const verify = createOriginVerifier({ claudeHome: home, mappings: async () => new Map([[ID,
    { nativeId: ID, sessionId: `local_${ID}`, cwd: CWD, isArchived: false }]]) });
  await verify(input('claude'));
  await chmod(dirname(path), 0o775);
  await assert.rejects(verify(input('claude')), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
  await chmod(dirname(path), 0o755);
  const alias = join(root, 'alias'); await link(path, alias);
  await assert.rejects(verify(input('claude')), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
  await rm(alias);
  const homeAlias = join(root, 'home-alias'); await symlink(home, homeAlias);
  const aliasVerify = createOriginVerifier({ claudeHome: homeAlias, mappings: async () => new Map([[ID,
    { nativeId: ID, sessionId: `local_${ID}`, cwd: CWD, isArchived: false }]]) });
  await assert.rejects(aliasVerify(input('claude')), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
});

test('receipt preconditions, byte bounds and deadline failures never expose native private details', async () => {
  for (const change of [{ expectedReceipt: { ...receipt, replayed: true } }, { expectedReceipt: { ...receipt, originChallenge: 'bad' } },
    { expectedFingerprint: 'bad' }, { sessionId: '../other' }])
    await assert.rejects(claudeFixture().verify({ ...input('claude'), ...change }), { code: 'ORIGIN_PROOF_INVALID' });
  await assert.rejects(claudeFixture({ readClaude: async () => 'x'.repeat(16 * 1024 * 1024 + 1) }).verify(input('claude')),
    { code: 'ORIGIN_PROOF_BOUND_EXCEEDED' });
  await assert.rejects(claudeFixture({ readClaude: async () => { throw new Error('PRIVATE PROMPT CONTENT'); } }).verify(input('claude')),
    error => error.code === 'ORIGIN_PROOF_UNAVAILABLE' && !error.message.includes('PRIVATE'));
  let time = 0;
  await assert.rejects(claudeFixture({ now: () => time += 2000 }).verify(input('claude')), { code: 'ORIGIN_PROOF_UNAVAILABLE' });
});
