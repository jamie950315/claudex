import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
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
