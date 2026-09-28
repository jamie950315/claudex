import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrichChatTitles } from '../src/chat-titles.mjs';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const UI = '33333333-3333-3333-3333-333333333333';
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-titles-')));
  const codexHome = join(root, 'codex'), desktopHome = join(root, 'desktop');
  await mkdir(codexHome); await mkdir(desktopHome);
  const chat = (provider, id = A) => ({ provider, nativeId: id, sessionId: id, cwd: root, chatId: `${provider}:${id}` });
  const index = rows => writeFile(join(codexHome, 'session_index.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const row = (id, thread_name, updated_at = '2026-09-28T12:00:00Z') => ({ id, thread_name, updated_at });
  const registry = (extra = {}) => writeFile(join(desktopHome, `local_${UI}.json`), JSON.stringify({ sessionId: `local_${UI}`, cliSessionId: A,
    cwd: root, title: 'Native title', lastActivityAt: 100, isArchived: false, ...extra }));
  return { root, codexHome, desktopHome, chat, index, row, registry };
}

test('Codex titles use newest exact-ID metadata and preserve duplicate titles', async () => {
  const f = await fixture();
  await f.index([f.row(A, 'Old'), f.row(A, 'Renamed', '2026-09-28T13:00:00Z'), f.row(B, 'Renamed'), f.row(UI, 'Unregistered')]);
  const original = [f.chat('codex'), f.chat('codex', B)];
  const result = await enrichChatTitles(original, f);
  assert.deepEqual(result.map(chat => chat.title), ['Renamed', 'Renamed']);
  assert.equal(result.length, 2);
  assert.equal(result[0].nativeId, A);
  assert.equal(result[0].titleSource, 'codex-session-index');
  assert.equal(original[0].title, undefined);
  await f.index([f.row(A, 'Latest', '2026-09-28T14:00:00Z')]);
  assert.equal((await enrichChatTitles(original, f))[0].title, 'Latest');
});

test('equal-time conflicting Codex titles refuse identity until a newer record', async () => {
  const f = await fixture();
  await f.index([f.row(A, 'First'), f.row(A, 'Second')]);
  let [result] = await enrichChatTitles([f.chat('codex')], f);
  assert.equal(result.title, null); assert.match(result.titleError, /Conflicting/);
  await f.index([f.row(A, 'First'), f.row(A, 'Second'), f.row(A, 'Resolved', '2026-09-28T14:00:00Z')]);
  [result] = await enrichChatTitles([f.chat('codex')], f);
  assert.equal(result.title, 'Resolved'); assert.equal(result.titleError, undefined);
});

test('Claude maps native ID rather than UI filename and flags moved registrations', async () => {
  const f = await fixture();
  await f.registry({ isArchived: true });
  let result = await enrichChatTitles([f.chat('claude'), f.chat('claude', UI)], f);
  assert.equal(result[0].title, 'Native title'); assert.equal(result[0].archived, true);
  assert.equal(result[0].titleSource, 'claude-desktop-registry');
  assert.equal(result[1].title, null);
  await f.registry({ title: 'Renamed', cwd: '/another-project' });
  result = await enrichChatTitles([f.chat('claude')], f);
  assert.equal(result[0].title, 'Renamed'); assert.equal(result[0].cwd, f.root);
  assert.equal(result[0].nativeId, A); assert.match(result[0].titleError, /refresh/);
});

test('missing and unsupported metadata do not fabricate titles', async () => {
  const f = await fixture();
  const result = await enrichChatTitles([f.chat('codex'), f.chat('claude'), f.chat('claude', 'unsupported')], f);
  assert.deepEqual(result.map(chat => chat.title), [null, null, null]);
  assert.match(result[0].titleError, /unavailable/);
  assert.match(result[1].titleError, /no matching/);
  assert.equal(result[2].titleError, undefined);
});

test('symlinked index and parent storage are refused without affecting other provider', async () => {
  const f = await fixture();
  await f.registry();
  const external = join(f.root, 'index.jsonl');
  await writeFile(external, JSON.stringify(f.row(A, 'Unsafe')));
  await symlink(external, join(f.codexHome, 'session_index.jsonl'));
  let result = await enrichChatTitles([f.chat('codex'), f.chat('claude')], f);
  assert.equal(result[0].title, null); assert.match(result[0].titleError, /regular/);
  assert.equal(result[1].title, 'Native title');
  const alias = join(f.root, 'alias'); await symlink(f.root, alias);
  result = await enrichChatTitles([f.chat('codex'), f.chat('claude')], {
    codexHome: join(alias, 'codex'), desktopHome: join(alias, 'desktop'),
  });
  assert.ok(result.every(chat => chat.title === null && /canonical/.test(chat.titleError)));
});

test('malformed and oversized indexes report explicit provider errors', async () => {
  const f = await fixture();
  const path = join(f.codexHome, 'session_index.jsonl');
  await writeFile(path, '{bad json}\n');
  assert.match((await enrichChatTitles([f.chat('codex')], f))[0].titleError, /Malformed/);
  await writeFile(path, '\n'.repeat(100_001));
  assert.match((await enrichChatTitles([f.chat('codex')], f))[0].titleError, /line limit/);
  await writeFile(path, Buffer.alloc(32 * 1024 * 1024 + 1));
  assert.match((await enrichChatTitles([f.chat('codex')], f))[0].titleError, /bounded/);
});
