import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { frontendBuild } from './fixtures/claude-frontend.mjs';
import { FRONTEND_ASSET_ROOT } from '../src/claude-frontend-graph.mjs';
import { inspectFolderCache, replaceFolderCacheSource } from '../src/claude-folder-cache.mjs';
import { checkPublishedGraph, loadPublishedGraph, publishedCacheEntry } from '../dev/check-claude-frontend-entry.mjs';

async function published(t, build) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-published-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const store = join(base, 'store'), temporary = join(base, 'work'), requested = [];
  await mkdir(store, { mode: 0o700 }); await mkdir(temporary, { mode: 0o700 });
  const sources = new Map(Object.entries(build.names).map(([kind, name]) => [FRONTEND_ASSET_ROOT + name, build.sources[kind]]));
  const fetchSource = async url => { requested.push(url); return Buffer.from(sources.get(url)); };
  return { store, temporary, requested, fetchSource, entry: build.names.entry };
}

test('a published graph is fetched once, reused from its store and passes every adapter', async t => {
  const build = frontendBuild('a', 11, { split: true, helpers: true }), f = await published(t, build);
  const graph = await loadPublishedGraph(f);
  assert.equal(graph.modules.size, new Set(Object.values(build.names)).size);
  assert.equal(graph.fetched, f.requested.length);
  const results = await checkPublishedGraph({ modules: graph.modules, entry: f.entry, temporary: f.temporary });
  assert.deepEqual(Object.values(results).map(r => r.status), ['passed', 'passed', 'passed', 'passed']);
  assert.equal(results.folders.consumer.asset, build.names.consumer);
  // Only the two state directories remain: no vendor or patched source.
  assert.deepEqual((await readdir(f.temporary)).sort(), ['home', 'state']);
  const again = await loadPublishedGraph(f);
  assert.equal(again.fetched, 0);
  assert.equal(again.modules.size, graph.modules.size);
});

test('an adapter that cannot be selected fails alone and names its phase', async t => {
  const build = frontendBuild('a');
  build.sources.commands = build.sources.commands.replace('getSupportedCommands', 'getOtherCommands');
  const f = await published(t, build), graph = await loadPublishedGraph(f);
  const results = await checkPublishedGraph({ modules: graph.modules, entry: f.entry, temporary: f.temporary });
  assert.equal(results.commands.status, 'failed');
  assert.equal(results.commands.phase, 'selection');
  for (const adapter of ['folders', 'chatWake', 'ownerWake']) assert.equal(results[adapter].status, 'passed');
});

test('an unavailable asset stops the check instead of reporting adapters', async t => {
  const f = await published(t, frontendBuild('a'));
  const fetchSource = async url => {
    if (url.endsWith('native-a.js')) throw Object.assign(new Error('Download refused: native-a.js (HTTP 404)'), { unavailable: true });
    return f.fetchSource(url);
  };
  await assert.rejects(loadPublishedGraph({ ...f, fetchSource }), error => error.unavailable === true);
});

test('the reconstructed container is read and resized by the production codec', () => {
  const url = `${FRONTEND_ASSET_ROOT}resize-a.js`, source = 'export const value=1;';
  const original = publishedCacheEntry(url, Buffer.from(source));
  assert.equal(inspectFolderCache(original, { targetURL: url }).source, source);
  // A longer body changes the digit count of both recorded lengths.
  const longer = source + `\nconst filler=${JSON.stringify(Array.from({ length: 4000 }, (_, i) => (i * 2654435761 >>> 0).toString(36)).join(''))};`;
  const resized = replaceFolderCacheSource(original, longer, { targetURL: url });
  assert.equal(inspectFolderCache(resized, { targetURL: url }).source, longer);
  assert.notEqual(String(inspectFolderCache(resized, { targetURL: url }).body.length).length,
    String(inspectFolderCache(original, { targetURL: url }).body.length).length);
});
