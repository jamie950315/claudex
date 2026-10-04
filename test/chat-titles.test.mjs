import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrichChatTitles } from '../src/chat-titles.mjs';
import { readDesktopSessionMappings, readDesktopTitleMappings } from '../src/desktop.mjs';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const UI = '33333333-3333-3333-3333-333333333333';
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-titles-')));
  const codexHome = join(root, 'codex'), desktopHome = join(root, 'desktop');
  await mkdir(codexHome, { mode: 0o700 }); await mkdir(desktopHome, { mode: 0o700 });
  const chat = (provider, id = A) => ({ provider, nativeId: id, sessionId: id, cwd: root, chatId: `${provider}:${id}` });
  const index = rows => writeFile(join(codexHome, 'session_index.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const row = (id, thread_name, updated_at = '2026-09-28T12:00:00Z') => ({ id, thread_name, updated_at });
  const registry = (extra = {}) => writeFile(join(desktopHome, `local_${UI}.json`), JSON.stringify({ sessionId: `local_${UI}`, cliSessionId: A,
    cwd: root, title: 'Native title', lastActivityAt: 100, isArchived: false, ...extra }), { mode: 0o600 });
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

test('one untitled Claude record cannot hide a healthy registered recipient', async () => {
  const f = await fixture(); await f.registry();
  await writeFile(join(f.desktopHome, `local_${B}.json`), JSON.stringify({ sessionId: `local_${B}`, cliSessionId: B,
    cwd: f.root, lastActivityAt: 100, isArchived: false }), { mode: 0o600 });
  const result = await enrichChatTitles([f.chat('claude'), f.chat('claude', B)], f);
  assert.equal(result[0].title, 'Native title'); assert.equal(result[0].titleError, undefined);
  assert.equal(result[1].title, null); assert.match(result[1].titleError, /lacks exact/);
  await assert.rejects(readDesktopSessionMappings(f.desktopHome, [A, B]), /lacks exact/);
});

test('invalid Claude presentation metadata is isolated without an action mapping', async t => {
  for (const [field, value] of [['cwd', 'relative'], ['title', ''], ['title', 'Line\nbreak'],
    ['isArchived', 'false'], ['lastActivityAt', 1.5]]) {
    await t.test(`${field}: ${JSON.stringify(value)}`, async () => {
      const f = await fixture(); await f.registry();
      await writeFile(join(f.desktopHome, `local_${B}.json`), JSON.stringify({ sessionId: `local_${B}`,
        cliSessionId: B, cwd: f.root, title: 'Other title', lastActivityAt: 100, isArchived: false,
        [field]: value }), { mode: 0o600 });
      const metadata = await readDesktopTitleMappings(f.desktopHome, [A, B]);
      assert.equal(metadata.get(A).title, 'Native title');
      assert.deepEqual(metadata.get(B), { error: 'Desktop session mapping lacks exact cwd, title, activity or archive metadata.' });
      await assert.rejects(readDesktopSessionMappings(f.desktopHome, [A, B]), /lacks exact/);
      assert.equal((await readDesktopSessionMappings(f.desktopHome, [A])).get(A).nativeId, A);
    });
  }
});

test('duplicate or malformed Claude identities still fail the entire title lookup', async t => {
  for (const record of [
    { sessionId: `local_${B}`, cliSessionId: A, cwd: '/tmp', title: 'Duplicate', lastActivityAt: 100, isArchived: false },
    { sessionId: `local_${B}`, cliSessionId: 'invalid' },
    { sessionId: `local_${UI}`, cliSessionId: B },
  ]) {
    await t.test(record.cliSessionId === A ? 'duplicate CLI identity' : `ambiguous ${record.sessionId}`, async () => {
      const f = await fixture(); await f.registry();
      await writeFile(join(f.desktopHome, `local_${B}.json`), JSON.stringify(record), { mode: 0o600 });
      await assert.rejects(readDesktopTitleMappings(f.desktopHome, [A]), /Multiple|Ambiguous/);
      await assert.rejects(readDesktopSessionMappings(f.desktopHome, [A]), /Multiple|Ambiguous/);
      const [chat] = await enrichChatTitles([f.chat('claude')], f);
      assert.equal(chat.title, null); assert.match(chat.titleError, /Multiple|Ambiguous/);
    });
  }
});

test('unsafe unrelated Claude records cannot become isolated metadata errors', async t => {
  for (const kind of ['malformed', 'symlink', 'hardlink', 'foreign-writable']) {
    await t.test(kind, async () => {
      const f = await fixture(); await f.registry();
      const path = join(f.desktopHome, `local_${B}.json`);
      if (kind === 'symlink') await symlink(join(f.desktopHome, `local_${UI}.json`), path);
      else if (kind === 'hardlink') await link(join(f.desktopHome, `local_${UI}.json`), path);
      else {
        await writeFile(path, kind === 'malformed' ? '{' : JSON.stringify({ sessionId: `local_${B}`, cliSessionId: B }), { mode: 0o600 });
        if (kind === 'foreign-writable') await chmod(path, 0o666);
      }
      const [chat] = await enrichChatTitles([f.chat('claude')], f);
      assert.equal(chat.title, null); assert.match(chat.titleError, /Malformed|Symlinked|regular file/);
      await assert.rejects(readDesktopSessionMappings(f.desktopHome, [A]), /Malformed|Symlinked|regular file/);
    });
  }
});

test('Claude mapping proofs retain exact nanosecond file identities', async () => {
  const f = await fixture(); await f.registry();
  const info = await lstat(join(f.desktopHome, `local_${UI}.json`), { bigint: true });
  const legacy = await lstat(join(f.desktopHome, `local_${UI}.json`));
  const mapping = (await readDesktopSessionMappings(f.desktopHome, [A])).get(A);
  assert.equal(mapping.registryIdentity.mtimeNs, String(info.mtimeNs));
  assert.equal(mapping.registryIdentity.ctimeNs, String(info.ctimeNs));
  assert.equal(mapping.registryIdentity.ino, Number(info.ino));
  assert.equal(mapping.registryIdentity.mtimeMs, legacy.mtimeMs);
  assert.equal(mapping.registryIdentity.ctimeMs, legacy.ctimeMs);
  assert.ok(Number.isFinite(mapping.registryIdentity.mtimeMs) && Number.isFinite(mapping.registryIdentity.ctimeMs));
  assert.deepEqual(JSON.parse(JSON.stringify(mapping)), mapping);
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
