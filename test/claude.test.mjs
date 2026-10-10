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

test('a missing parent is refused and a replaced reply is left out', () => {
  const row = (uuid, parentUuid, role) => ({ type: role, uuid, parentUuid, message: { role, content: 'text' } });
  assert.throws(() => decodeClaude(JSON.stringify(row('a', 'missing', 'user')) + '\n'), /missing its parent/);
  // A second reply to the same input replaces the first: the last one is the conversation.
  const rows = [row('a', null, 'user'), row('b', 'a', 'assistant'), row('c', 'a', 'assistant')];
  rows[1].message.content = 'first reply'; rows[2].message.content = 'second reply';
  const decoded = JSON.stringify(decodeClaude(rows.map(value => JSON.stringify(value)).join('\n') + '\n').messages);
  assert.ok(decoded.includes('second reply')); assert.ok(!decoded.includes('first reply'));
});

test('a rewound branch is left out and other forks are read by what they are', () => {
  const base = { sessionId: '11111111-1111-4111-8111-111111111111', cwd: '/tmp/claudex-rewind', version: '2.1.281',
    timestamp: '2026-10-06T00:00:00.000Z', isSidechain: false, userType: 'external' };
  const row = (uuid, parentUuid, type, content, extra = {}) => ({ ...base, uuid, parentUuid, type,
    message: { role: type, content, ...(type === 'assistant' ? { id: 'msg-' + uuid, model: 'synthetic-fixture',
      stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } } : {}) }, ...extra });
  const text = rows => rows.map(value => JSON.stringify(value)).join('\n') + '\n';
  const reply = (uuid, parent, value) => row(uuid, parent, 'assistant', [{ type: 'text', text: value }]);
  const start = [row('u1', null, 'user', 'First question'), reply('a1', 'u1', 'First answer')];
  const replacedBranch = [row('u2', 'a1', 'user', 'Replaced question'), reply('a2', 'u2', 'Replaced answer')];
  const kept = [row('u3', 'a1', 'user', 'Rewritten question'), reply('a3', 'u3', 'Rewritten answer')];
  const texts = common => common.messages.map(message => message.content.map(block => block.text).join(''));
  assert.deepEqual(texts(decodeClaude(text([...start, ...replacedBranch, ...kept]))),
    ['First question', 'First answer', 'Rewritten question', 'Rewritten answer']);
  assert.deepEqual(decodeClaude(text([...start, ...replacedBranch, ...kept])).messages, decodeClaude(text([...start, ...kept])).messages);
  // Rewinding twice from the same point keeps only the last branch.
  const again = [row('u4', 'a1', 'user', 'Third wording'), reply('a4', 'u4', 'Third answer')];
  assert.deepEqual(texts(decodeClaude(text([...start, ...replacedBranch, ...kept, ...again]))).slice(2), ['Third wording', 'Third answer']);
  // A regenerated reply replaces the earlier one.
  assert.deepEqual(texts(decodeClaude(text([...start, reply('a1b', 'u1', 'Competing answer')]))), ['First question', 'Competing answer']);
  // Two results for one call are both kept, never one chosen: the completeness check names the problem.
  const call = row('c1', 'u3', 'assistant', [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }]);
  const result = uuid => row(uuid, 'c1', 'user', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done ' + uuid }]);
  const doubled = JSON.stringify(decodeClaude(text([...start, kept[0], call, result('r1'), result('r2')])).messages);
  assert.ok(doubled.includes('done r1') && doubled.includes('done r2'));
});
