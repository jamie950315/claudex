import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectClaudeProjectRelocation } from '../src/claude-relocation.mjs';
import { sessionPath } from '../src/claude.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-relocation-')));
  const claudeHome = join(root, 'claude'), desktopRegistryRoot = join(root, 'desktop');
  const previousCwd = join(root, 'scratch'), cwd = join(root, 'project');
  for (const path of [claudeHome, desktopRegistryRoot, previousCwd, cwd]) await mkdir(path);
  const nativeId = randomUUID(), sessionId = `local_${randomUUID()}`;
  const record = { side: 'claude', kind: 'original', managed: false, nativeId, cwd: previousCwd,
    path: sessionPath(claudeHome, previousCwd, nativeId) };
  const path = sessionPath(claudeHome, cwd, nativeId);
  await mkdir(dirname(record.path), { recursive: true });
  await mkdir(dirname(path), { recursive: true });
  const mapping = { sessionId, cliSessionId: nativeId, cwd, title: 'Relocated project', isArchived: false, lastActivityAt: 1000 };
  const registryPath = join(desktopRegistryRoot, `${sessionId}.json`);
  const rows = [previousCwd, join(previousCwd, 'OldName'), previousCwd, cwd, join(cwd, 'src'), cwd].map((rowCwd, i) => ({
    type: i % 2 ? 'assistant' : 'user', sessionId: nativeId, cwd: rowCwd, uuid: `row-${i}`,
    parentUuid: i ? `row-${i - 1}` : null, message: { role: i % 2 ? 'assistant' : 'user', content: `Message ${i}` } }));
  const saveRows = () => writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  const saveMapping = () => writeFile(registryPath, JSON.stringify(mapping), { mode: 0o600 });
  await saveRows(); await saveMapping();
  return { root, claudeHome, desktopRegistryRoot, record, path, rows, mapping, registryPath, cwd,
    saveRows, saveMapping, inspect: overrides => inspectClaudeProjectRelocation({ claudeHome, desktopRegistryRoot, record, ...overrides }) };
}

test('native relocation verifies exact identity and stable bytes without changing native files', async () => {
  const f = await fixture(), before = await readFile(f.path), registry = await readFile(f.registryPath);
  const result = await f.inspect();
  assert.equal(result.path, f.path); assert.equal(result.cwd, f.cwd); assert.equal(result.nativeId, f.record.nativeId);
  assert.equal(result.previousPath, f.record.path); assert.equal(result.previousCwd, f.record.cwd);
  assert.equal(result.mapping.sessionId, f.mapping.sessionId); assert.notEqual(result.mapping.sessionId.slice(6), result.nativeId);
  assert.equal(result.snapshot.bytes, before.length); assert.equal(result.snapshot.rows.length, f.rows.length);
  assert.match(result.snapshot.hash, /^[a-f0-9]{64}$/); assert.equal(result.snapshot.identity.nlink, 1);
  assert.deepEqual(await readFile(f.path), before); assert.deepEqual(await readFile(f.registryPath), registry);
});

test('missing or unchanged authoritative mapping never adopts a same-ID transcript', async () => {
  const f = await fixture();
  assert.equal(await f.inspect({ desktopRegistryRoot: join(f.root, 'absent-registry') }), null);
  f.mapping.cwd = f.record.cwd; await f.saveMapping();
  assert.equal(await f.inspect(), null);
});

test('duplicate native registry mapping and a surviving source file both block relocation', async () => {
  const f = await fixture();
  await writeFile(f.record.path, 'old native transcript\n');
  await assert.rejects(f.inspect(), /still exists/);
  const g = await fixture(), duplicateId = `local_${randomUUID()}`;
  await writeFile(join(g.desktopRegistryRoot, `${duplicateId}.json`), JSON.stringify({ ...g.mapping, sessionId: duplicateId }));
  await assert.rejects(g.inspect(), /Multiple Desktop records/);
});

test('authored foreign identities, unexpected cwd and returning to the old project block relocation', async () => {
  for (const change of ['identity', 'foreignCwd', 'return', 'latest']) {
    const f = await fixture();
    if (change === 'identity') f.rows.at(-1).sessionId = randomUUID();
    if (change === 'foreignCwd') f.rows[1].cwd = join(f.root, 'foreign');
    if (change === 'return') f.rows.at(-2).cwd = f.record.cwd;
    if (change === 'latest') f.rows.at(-1).cwd = join(f.cwd, 'src');
    await f.saveRows();
    await assert.rejects(f.inspect(), /session identity|outside|returned|latest authored/);
  }
});

test('relocation does not follow working directory aliases', async () => {
  const f = await fixture(), alias = join(f.root, 'alias');
  await symlink(f.cwd, alias);
  f.mapping.cwd = alias; await f.saveMapping();
  const aliasTranscript = sessionPath(f.claudeHome, alias, f.record.nativeId);
  await mkdir(dirname(aliasTranscript)); await writeFile(aliasTranscript, await readFile(f.path));
  await assert.rejects(f.inspect(), /canonical owned directory/);
});

test('noncanonical records and path encoding collisions are rejected', async () => {
  const f = await fixture();
  await assert.rejects(f.inspect({ record: { ...f.record, path: f.path } }), /saved original identity/);
  await assert.rejects(f.inspect({ record: { ...f.record, managed: true } }), /saved original identity/);
  const g = await fixture();
  g.mapping.cwd = g.record.cwd.replace('scratch', 'scratc!');
  g.record.cwd = g.record.cwd.replace('scratch', 'scratc?');
  g.record.path = sessionPath(g.claudeHome, g.record.cwd, g.record.nativeId);
  await g.saveMapping(); await assert.rejects(g.inspect(), /encode to the same/);
});

test('hardlinked, oversized and incomplete transcripts are rejected', async () => {
  const f = await fixture(); await link(f.path, join(f.root, 'other-link'));
  await assert.rejects(f.inspect(), /owned regular file/);
  const g = await fixture(); await assert.rejects(g.inspect({ maxBytes: 1 }), /bounded/);
  const h = await fixture(); await writeFile(h.path, JSON.stringify(h.rows[0]));
  await assert.rejects(h.inspect(), error => error.code === undefined && /waits for a stable boundary/.test(error.message));
});

test('another verified move preserves explicitly bounded earlier project roots', async () => {
  const f = await fixture(), earlierProject = join(f.root, 'previous-project');
  f.rows[2].cwd = earlierProject; await f.saveRows();
  await assert.rejects(f.inspect(), /outside/);
  assert.equal((await f.inspect({ historicalCwds: [f.record.cwd, earlierProject] })).cwd, f.cwd);
  await assert.rejects(f.inspect({ historicalCwds: Array(17).fill(earlierProject) }), error => error.code === 'CLAUDE_RELOCATION_BLOCKED');
  await assert.rejects(f.inspect({ historicalCwds: [earlierProject + '/..'] }), /saved original identity/);
});
