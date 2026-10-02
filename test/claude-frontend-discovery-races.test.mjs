import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheBytes, frontendBuild, writeFrontend } from './fixtures/claude-frontend.mjs';
import { claudeCacheDirectory, discoverClaudeFrontend, verifyClaudeFrontendGraph } from '../src/claude-frontend-graph.mjs';
import { ensureClaudeRendererAdapters } from '../src/claude-renderer-adapters.mjs';
import { startClaudeRendererMaintenance } from '../src/claude-renderer-maintenance.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-discovery-race-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'state'), home = join(base, 'home');
  await mkdir(root, { mode: 0o700 }); await chmod(root, 0o700);
  await mkdir(home, { mode: 0o700 }); await chmod(home, 0o700);
  const resources = await writeFrontend(home, frontendBuild());
  const directory = claudeCacheDirectory(home); await chmod(directory, 0o700);
  for (const resource of Object.values(resources)) await chmod(resource.path, 0o600);
  return { root, home, resources, directory };
}

// The file runs in its own Node test process. Replace one built-in operation
// only around the awaited discovery and always restore its live ESM bindings.
async function withFilesystemHook(method, wrapper, run) {
  const original = fs.promises[method];
  fs.promises[method] = wrapper(original); syncBuiltinESMExports();
  try { return await run(); }
  finally { fs.promises[method] = original; syncBuiltinESMExports(); }
}

test('an unrelated entry evicted after inventory refuses the pass with a native-cache code', async t => {
  const f = await fixture(t), victim = join(f.directory, '0000000000000000_0');
  await writeFile(victim, cacheBytes('https://example.test/image.png', 'image', Date.now()), { mode: 0o600 });
  await chmod(victim, 0o600);
  let evicted = false;
  await withFilesystemHook('readdir', original => async (...args) => {
    const names = await original(...args);
    if (args[0] === f.directory && !evicted) { evicted = true; await unlink(victim); }
    return names;
  }, () => assert.rejects(discoverClaudeFrontend(f), { code: 'CLAUDEX_FRONTEND_CACHE_MISSING' }));
  assert.equal(evicted, true);
  const graph = await discoverClaudeFrontend(f);
  assert.ok(Object.values(graph.adapters).every(adapter => adapter.status === 'matched'));
  for (const resource of Object.values(f.resources)) assert.deepEqual(await readFile(resource.path), resource.bytes);
});

test('two real unrelated inventory evictions recover on the final vanished-entry hint without idle rescans', async t => {
  const f = await fixture(t), victims = ['0000000000000000_0', '0000000000000001_0'];
  for (const name of victims) {
    const path = join(f.directory, name);
    await writeFile(path, cacheBytes('https://example.test/image.png', 'image', Date.now()), { mode: 0o600 });
    await chmod(path, 0o600);
  }
  let maintenance, notify, evicted = 0, calls = 0, resolveReady;
  const statuses = [], ready = new Promise(resolve => { resolveReady = resolve; });
  try {
    maintenance = await withFilesystemHook('readdir', original => async (...args) => {
      const names = await original(...args);
      if (args[0] === f.directory && evicted < victims.length) await unlink(join(f.directory, victims[evicted++]));
      return names;
    }, () => startClaudeRendererMaintenance({ ...f, settleMs: 0,
      maintain: async (...args) => { calls++; return ensureClaudeRendererAdapters(...args); },
      watchFactory: (_path, listener) => {
        notify = listener; const watcher = new EventEmitter; watcher.close = () => {}; return watcher;
      },
      writeStatus: async (_path, status) => { statuses.push(status); if (status.state === 'ready') resolveReady(); },
    }));
    assert.equal(calls, 2); assert.equal(evicted, 2);
    assert.deepEqual(statuses.map(status => [status.state, status.failure.code]),
      [['skipped', 'cache-entry-missing'], ['skipped', 'cache-entry-missing']]);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, 2, 'no third attempt without another native cache event');
    for (const resource of Object.values(f.resources)) assert.deepEqual(await readFile(resource.path), resource.bytes);

    notify('rename', victims[1]);
    let timeout;
    try {
      await Promise.race([ready, new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Maintenance did not recover on the eviction hint')), 3000);
      })]);
    } finally { clearTimeout(timeout); }
    assert.equal(calls, 3);
    assert.ok(Object.values(statuses.at(-1).adapters).every(adapter => adapter.status === 'installed'));
    for (const [adapter, directory] of Object.entries({ folders: 'ui-folders', chatWake: 'ui-chat-wake', ownerWake: 'ui-owner-wake' })) {
      const resource = f.resources[adapter];
      assert.deepEqual(await readFile(join(f.root, directory, resource.filename, 'ui-folder-compat', 'original.cache')), resource.bytes);
    }
    notify('rename', victims[0]);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls, 3, 'healthy unknown deletions return to normal hint filtering');
  } finally { await maintenance?.close(); }
});

test('a missing native cache directory and a lost publication proof are native-cache failures', async t => {
  const f = await fixture(t), graph = await discoverClaudeFrontend(f), held = `${f.directory}-held`;
  await rename(f.directory, held);
  await assert.rejects(discoverClaudeFrontend(f), { code: 'CLAUDEX_FRONTEND_CACHE_MISSING' });
  await rename(held, f.directory);
  await unlink(f.resources.client.path);
  await assert.rejects(verifyClaudeFrontendGraph(graph), { code: 'CLAUDEX_FRONTEND_CACHE_MISSING' });
});

test('dependency eviction during publication retains typed adapter failures and immutable recovery evidence', async t => {
  const f = await fixture(t), graph = await discoverClaudeFrontend(f);
  let evicted = false;
  const result = await ensureClaudeRendererAdapters({ ...f, graph }, { beforeReplace: async () => {
    if (!evicted) { evicted = true; await unlink(f.resources.client.path); }
  } });
  assert.equal(evicted, true);
  for (const adapter of Object.values(result.adapters)) {
    assert.equal(adapter.status, 'skipped');
    assert.deepEqual(adapter.failure, { code: 'cache-entry-missing' });
    assert.ok(!JSON.stringify(adapter).includes(f.home));
  }
  const resource = f.resources.folders, journal = join(f.root, 'ui-folders', resource.filename, 'ui-folder-compat');
  assert.deepEqual(await readFile(resource.path), resource.bytes);
  assert.deepEqual(await readFile(join(journal, 'original.cache')), resource.bytes);
  assert.equal(JSON.parse(await readFile(join(journal, 'manifest.json'), 'utf8')).phase, 'prepared');
});

test('publication classifies raw missing files only when bound to the exact native cache target', async t => {
  const f = await fixture(t), graph = await discoverClaudeFrontend(f);
  await unlink(f.resources.folders.path);
  const evicted = await ensureClaudeRendererAdapters({ ...f, graph });
  assert.deepEqual(evicted.adapters.folders.failure, { code: 'cache-entry-missing' });
  await writeFile(f.resources.folders.path, f.resources.folders.bytes, { mode: 0o600 });
  await chmod(f.resources.folders.path, 0o600);
  const missing = await ensureClaudeRendererAdapters(f, { beforeReplace: async () => {
    throw Object.assign(new Error('Private dependency missing'), { code: 'ENOENT', path: join(f.root, 'private-dependency') });
  } });
  for (const adapter of Object.values(missing.adapters)) {
    assert.equal(adapter.status, 'skipped');
    assert.deepEqual(adapter.failure, { code: 'required-file-missing' });
    assert.ok(!JSON.stringify(adapter).includes(f.root));
  }
});

test('a known installation with a missing immutable original fails as recovery evidence, not cache churn', async t => {
  const f = await fixture(t);
  const installed = await ensureClaudeRendererAdapters(f);
  assert.ok(Object.values(installed.adapters).every(adapter => adapter.status === 'installed'));
  const resource = f.resources.folders, before = await readFile(resource.path);
  const journal = join(f.root, 'ui-folders', resource.filename, 'ui-folder-compat');
  await unlink(join(journal, 'original.cache'));
  await assert.rejects(discoverClaudeFrontend(f), { code: 'CLAUDEX_FRONTEND_EVIDENCE_MISSING' });
  assert.deepEqual(await readFile(resource.path), before);
});

for (const point of ['first-read', 'recheck']) test(`a known receipt disappearing during ${point} remains missing recovery evidence`, async t => {
  const f = await fixture(t); await ensureClaudeRendererAdapters(f);
  const resource = f.resources.folders, before = await readFile(resource.path);
  const journal = join(f.root, 'ui-folders', resource.filename, 'ui-folder-compat');
  const manifest = join(journal, 'manifest.json'), originalPath = join(journal, 'original.cache');
  let removed = false;
  await withFilesystemHook('open', original => async (...args) => {
    if (!removed && args[0] === (point === 'first-read' ? manifest : originalPath)) {
      removed = true; await unlink(manifest);
    }
    return original(...args);
  }, () => assert.rejects(discoverClaudeFrontend(f), { code: 'CLAUDEX_FRONTEND_EVIDENCE_MISSING' }));
  assert.equal(removed, true);
  assert.deepEqual(await readFile(resource.path), before);
});

test('native cache permission and symlink failures are never classified as an eviction', async t => {
  const f = await fixture(t);
  await withFilesystemHook('open', original => async (...args) => {
    if (args[0] === f.resources.entry.path) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return original(...args);
  }, () => assert.rejects(discoverClaudeFrontend(f), { code: 'EACCES' }));
  await unlink(f.resources.entry.path);
  await fs.promises.symlink(f.resources.folders.path, f.resources.entry.path);
  await assert.rejects(discoverClaudeFrontend(f), error => error.code !== 'CLAUDEX_FRONTEND_CACHE_MISSING');
});

for (const privateEvidence of [false, true]) test(`a changed snapshot is transient only for native cache; private evidence=${privateEvidence}`, async t => {
  const f = await fixture(t);
  if (privateEvidence) await ensureClaudeRendererAdapters(f);
  const target = privateEvidence
    ? join(f.root, 'ui-folders', f.resources.folders.filename, 'ui-folder-compat', 'original.cache')
    : f.resources.entry.path;
  const bytes = await readFile(target); let opens = 0;
  await withFilesystemHook('open', original => async (...args) => {
    // Native entries are first opened by the inventory key reader. Alter the
    // inode after snapshot lstat(), immediately before its actual open().
    if (args[0] === target && ++opens === (privateEvidence ? 1 : 2)) {
      const replacement = `${target}.replacement`;
      await writeFile(replacement, bytes, { mode: 0o600 }); await chmod(replacement, 0o600);
      await rename(replacement, target);
    }
    return original(...args);
  }, () => assert.rejects(discoverClaudeFrontend(f), privateEvidence
    ? error => error.code !== 'CLAUDEX_FRONTEND_CACHE_CHANGED' && error.message === 'Claude folder installation: file changed while opening'
    : { code: 'CLAUDEX_FRONTEND_CACHE_CHANGED' }));
  assert.deepEqual(await readFile(target), bytes);
});
