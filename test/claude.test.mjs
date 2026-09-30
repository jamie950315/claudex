import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, readFile, appendFile, stat, rename, writeFile, symlink, rm, utimes } from 'node:fs/promises';
import { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeSession, appendClaudeSession, decodeClaude, projectDirectory } from '../src/claude.mjs';
import { snapshot } from '../src/storage.mjs';

const common = (text = 'Remember BLUE.') => ({ meta: { id: 'test', cwd: '/tmp/claudex-test', timestamp: '2026-09-24T00:00:00Z' }, messages: [
  { role: 'user', content: [{ type: 'text', text }] },
  { role: 'assistant', content: [{ type: 'text', text: 'BLUE noted.' }] },
] });

test('native projection preserves text and appends one linked batch without replacing original bytes', async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), 'claudex-claude-test-'));
  const result = await createClaudeSession({ claudeHome, common: common(), title: 'Bridge test' });
  const before = await readFile(result.path, 'utf8');
  const update = await appendClaudeSession({ path: result.path, id: result.id, common: common('Remember GREEN.'), expectedHash: result.hash });
  const after = await readFile(result.path, 'utf8');
  assert.ok(after.startsWith(before));
  assert.notEqual(update.hash, result.hash);
  const messages = decodeClaude(after).messages;
  assert.equal(messages.length, 4);
  assert.equal(messages[2].content[0].text, 'Remember GREEN.');
  const rows = after.trim().split('\n').map(JSON.parse).filter(row => row.uuid);
  assert.equal(new Set(rows.map(row => row.uuid)).size, 4);
  assert.equal(rows[2].parentUuid, rows[1].uuid);
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
});

test('source divergence fails closed', async () => {
  const claudeHome = await mkdtemp(join(tmpdir(), 'claudex-conflict-test-'));
  const result = await createClaudeSession({ claudeHome, common: common() });
  await appendFile(result.path, '{"type":"custom-title","customTitle":"Other writer"}\n');
  const before = await readFile(result.path, 'utf8');
  await assert.rejects(appendClaudeSession({ ...result, id: result.id, common: common(), expectedHash: result.hash }), /diverged/);
  assert.equal(await readFile(result.path, 'utf8'), before);
});

test('unchanged nanosecond timestamps append without a floating point millisecond comparison', async t => {
  const claudeHome = await mkdtemp(join(tmpdir(), 'claudex-precise-append-'));
  t.after(() => rm(claudeHome, { recursive: true, force: true }));
  const result = await createClaudeSession({ claudeHome, common: common() });
  const before = await readFile(result.path, 'utf8');
  // Real fractional timestamps can round differently when obtained directly as
  // mtimeMs and when converted from nanoseconds. Choose one where this occurs.
  let convertedDifferently = false;
  for (let offset = 0; offset < 256; offset++) {
    const seconds = 1790726400 + offset / 1e6;
    await utimes(result.path, seconds, seconds);
    const source = await snapshot(result.path), current = await stat(result.path);
    if (source.mtimeMs !== current.mtimeMs) { convertedDifferently = true; break; }
  }
  t.diagnostic(`Native timestamp conversion difference observed: ${convertedDifferently}`);
  await appendClaudeSession({ path: result.path, id: result.id, common: common('Next exact batch.'), expectedHash: result.hash });
  const after = await readFile(result.path, 'utf8');
  assert.ok(after.startsWith(before));
  assert.equal(decodeClaude(after).messages.length, 4);
});

for (const replacement of ['regular', 'symlink', 'missing']) {
  test(`append preserves a ${replacement} replacement introduced after its stable snapshot`, async t => {
    const claudeHome = await mkdtemp(join(tmpdir(), 'claudex-append-replacement-'));
    t.after(() => rm(claudeHome, { recursive: true, force: true }));
    const result = await createClaudeSession({ claudeHome, common: common() });
    const before = await readFile(result.path, 'utf8'), original = `${result.path}.original`;
    const originalOpen = fs.open;
    let replaced = false;
    const mock = t.mock.method(fs, 'open', async (path, flags, ...args) => {
      if (path === result.path && (flags === 'a' || (typeof flags === 'number' && (flags & constants.O_APPEND) !== 0))) {
        replaced = true;
        await rename(result.path, original);
        if (replacement === 'regular') {
          const previous = await stat(original);
          await writeFile(result.path, before, { mode: 0o600 });
          await utimes(result.path, previous.atime, previous.mtime);
        } else if (replacement === 'symlink') await symlink(original, result.path);
      }
      return originalOpen(path, flags, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    await assert.rejects(appendClaudeSession({ path: result.path, id: result.id, common: common('Unsafe batch.'), expectedHash: result.hash }));
    assert.equal(replaced, true);
    assert.equal(await readFile(original, 'utf8'), before);
    if (replacement !== 'missing') assert.equal(await readFile(result.path, 'utf8'), before);
    else await assert.rejects(stat(result.path), { code: 'ENOENT' });
  });
}

test('compacted sessions are not silently flattened', () => {
  assert.throws(() => decodeClaude('{"type":"system","subtype":"compact_boundary"}\n'), /compaction/);
});

test('project paths match Claude project encoding', () => {
  assert.equal(projectDirectory('/tmp/claude-home', '/Users/example/a.b_c'), '/tmp/claude-home/projects/-Users-example-a-b-c');
});

test('missing parents and competing branches are not silently flattened', () => {
  const row = (uuid, parentUuid, role) => ({ type: role, uuid, parentUuid, message: { role, content: 'text' } });
  assert.throws(() => decodeClaude(JSON.stringify(row('a', 'missing', 'user')) + '\n'), /missing its parent/);
  const rows = [row('a', null, 'user'), row('b', 'a', 'assistant'), row('c', 'a', 'assistant')];
  assert.throws(() => decodeClaude(rows.map(value => JSON.stringify(value)).join('\n') + '\n'), /Nonlinear/);
});
