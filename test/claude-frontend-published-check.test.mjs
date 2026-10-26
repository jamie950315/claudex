import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { frontendBuild, writeFrontend } from './fixtures/claude-frontend.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rustChecker, invokeChecker, sandboxDirectories } from '../dev/frontend-check-support.mjs';
import { FRONTEND_ASSET_ROOT } from './fixtures/frontend-static.mjs';
import { checkPublishedEntry, checkPublishedGraph, loadPublishedGraph } from '../dev/check-claude-frontend-entry.mjs';

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

test('a missing checker fails explicitly before downloading any vendor modules', async () => {
  let fetched = false;
  await assert.rejects(checkPublishedEntry({ entry: 'index-a.js', rustChecker: '/missing/frontend-check',
    fetchSource: async () => { fetched = true; } }), /cargo build --locked -p claudex-app --example frontend-check/);
  assert.equal(fetched, false);
});

test('published entry metadata identifies the Rust engine', async t => {
  const build = frontendBuild('engine'), f = await published(t, build);
  const report = await checkPublishedEntry({ entry: f.entry, store: f.store, fetchSource: f.fetchSource });
  assert.equal(report.engine, 'rust'); assert.equal(report.passed, true);
});

test('copied native caches use Rust installation, watcher reapplication and exact restore', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-copied-frontend-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home'), root = join(base, 'state'), report = join(base, 'report.json');
  await mkdir(home, { mode: 0o700 }); await mkdir(root, { mode: 0o700 });
  await writeFrontend(home, frontendBuild('old', 11, { shared: true }), Date.now() - 20000);
  await writeFrontend(home, frontendBuild('new', 11, { split: true, helpers: true }), Date.now() - 10000);
  await promisify(execFile)(process.execPath, [new URL('../dev/verify-claude-frontend-builds.mjs', import.meta.url).pathname,
    '--home', home, '--root', root, '--report', report], { timeout: 180000, maxBuffer: 65536 });
  const result = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(result.engine, 'rust'); assert.equal(result.passed, true);
  assert.equal(result.builds.length, 2); assert.equal(result.transitions.length, 1);
  assert.equal(result.transitions[0].entryPoint, 'frontend_maintenance::Maintenance');
  assert.equal(result.transitions[0].actualFilesystemNotifications, true);
  assert.equal(result.transitions[0].oldOriginalsAndReceipts, 'unchanged');
  assert.equal(result.transitions[0].restore, 'passed');
});

test('mutation commands require an explicit isolated sandbox, not just a native home', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-checker-boundary-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home'), root = join(base, 'state');
  await mkdir(home, { mode: 0o700 }); await mkdir(root, { mode: 0o700 });
  const checker = await rustChecker();
  await assert.rejects(invokeChecker(checker, { root, home, sandbox: base, operation: 'install', output: join(base, 'output') }), /frontend-check-sandbox/);
  assert.deepEqual(await readdir(root), []);
  await sandboxDirectories(base);
  await assert.rejects(invokeChecker(checker, { root, home, sandbox: base, operation: 'install', output: join(base, '..', 'outside-sandbox') }), /Installed output must be new and isolated/);
  assert.deepEqual(await readdir(root), []);
});

test('a refused selected graph skips maintenance transition without waiting for ready', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'claudex-refused-frontend-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home'), root = join(base, 'state'), report = join(base, 'report.json');
  await mkdir(home, { mode: 0o700 }); await mkdir(root, { mode: 0o700 });
  const previous = frontendBuild('refused');
  previous.sources.commands = previous.sources.commands.replaceAll('getSupportedCommands', 'getOtherCommands');
  await writeFrontend(home, previous, Date.now() - 20000);
  await writeFrontend(home, frontendBuild('current'), Date.now() - 10000);
  await assert.rejects(promisify(execFile)(process.execPath, [new URL('../dev/verify-claude-frontend-builds.mjs', import.meta.url).pathname,
    '--home', home, '--root', root, '--report', report], { timeout: 30000, maxBuffer: 65536 }));
  const result = JSON.parse(await readFile(report, 'utf8'));
  assert.equal(result.passed, false); assert.equal(result.builds[0].adapters.commands.status, 'failed');
  assert.ok(Object.values(result.builds[1].adapters).every(adapter => adapter.status === 'passed'));
  assert.equal(result.transitions[0].status, 'skipped');
  assert.equal(result.transitions[0].reason, 'Initial or selected graph failed adapter acceptance');
});
