import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverSources } from '../src/discovery.mjs';
import { createClaudeSession } from '../src/claude.mjs';
import { serviceDefinition } from '../src/service.mjs';

test('Claude encoded-directory collisions do not leak into the project allowlist', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-discovery-test-')));
  const claudeHome = join(root, 'claude'); const codexHome = join(root, 'codex');
  const cwd = join(root, 'a.b'); const other = join(root, 'a_b');
  await Promise.all([claudeHome, codexHome, cwd, other].map(path => mkdir(path)));
  const common = path => ({ meta: { id: '', cwd: path, timestamp: new Date().toISOString() }, messages: [
    { role: 'user', content: [{ type: 'text', text: 'Question' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
  ] });
  const chosen = await createClaudeSession({ claudeHome, common: common(cwd) });
  await createClaudeSession({ claudeHome, common: common(other) });
  await createClaudeSession({ claudeHome, common: common(cwd), owner: '/another/bridge/root' });
  const result = await discoverSources({ claudeHome, codexHome, projects: [cwd], since: 0 });
  assert.deepEqual(result, [{ side: 'claude', path: chosen.path }]);
  assert.deepEqual(await discoverSources({ claudeHome, codexHome, projects: [cwd], since: 0 }, new Set([`claude:${chosen.id}`])), []);
});

test('service configuration escapes XML, uses exact executable arguments and no unbounded output log', () => {
  const result = serviceDefinition({ root: '/tmp/bridge & test', cli: '/tmp/a<b.mjs', node: '/bin/node', path: '/bin' });
  assert.match(result.plist, /bridge &amp; test/);
  assert.match(result.plist, /a&lt;b.mjs/);
  assert.match(result.plist, /<key>KeepAlive<\/key><false\/>/);
  assert.match(result.plist, /<key>StandardOutPath<\/key><string>\/dev\/null<\/string>/);
});

test('all-project discovery includes recent native activity without following links or importing owned copies', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-discovery-all-')));
  const claudeHome = join(root, 'claude'); const codexHome = join(root, 'codex');
  const sessions = join(codexHome, 'sessions'); const directory = join(claudeHome, 'projects', 'arbitrary-native-key');
  const outside = join(root, 'outside');
  await Promise.all([sessions, directory, outside].map(path => mkdir(path, { recursive: true })));
  const since = Date.now() - 60_000;
  const codex = async (name, payload) => {
    const path = join(sessions, `rollout-${name}.jsonl`);
    await writeFile(path, JSON.stringify({ type: 'session_meta', payload }) + '\n');
    return path;
  };
  const chosenCodex = await codex('chosen', { id: 'chosen', cwd: join(root, 'project-a') });
  const oldCodex = await codex('old', { id: 'old', cwd: join(root, 'project-b') });
  await utimes(oldCodex, new Date(0), new Date(0));
  await codex('relative', { id: 'relative', cwd: 'relative/path' });
  await codex('invalid', { id: 'invalid', cwd: { path: '/tmp' } });
  await codex('owned', { id: 'owned', cwd: '/tmp', originator: 'claudex' });
  await codex('known', { id: 'known', cwd: '/tmp' });
  const claude = async (id, rows, parent = directory) => {
    const path = join(parent, `${id}.jsonl`);
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    return path;
  };
  const chosenId = '11111111-1111-1111-1111-111111111111';
  const chosenClaude = await claude(chosenId, [{ cwd: join(root, 'project-b') }]);
  const oldClaude = await claude('22222222-2222-2222-2222-222222222222', [{ cwd: '/tmp' }]);
  await utimes(oldClaude, new Date(0), new Date(0));
  await claude('33333333-3333-3333-3333-333333333333', [{ cwd: '/tmp' }, { type: 'claudex-owner' }]);
  await claude('44444444-4444-4444-4444-444444444444', [{ cwd: 'relative/path' }]);
  await claude('55555555-5555-5555-5555-555555555555', [{ cwd: 42 }]);
  await claude('66666666-6666-6666-6666-666666666666', [{ cwd: '/tmp' }], outside);
  await symlink(outside, join(claudeHome, 'projects', 'linked-project'));
  await symlink(chosenClaude, join(directory, '77777777-7777-7777-7777-777777777777.jsonl'));
  const options = { codexHome, claudeHome, allProjects: true, since };
  assert.deepEqual(await discoverSources(options, new Set(['codex:known'])), [
    { side: 'codex', path: chosenCodex }, { side: 'claude', path: chosenClaude },
  ]);
  assert.deepEqual(await discoverSources({ ...options, allProjects: false }), []);
  assert.deepEqual(await discoverSources(options, new Set(['codex:known', 'codex:chosen', `claude:${chosenId}`])), []);
});
