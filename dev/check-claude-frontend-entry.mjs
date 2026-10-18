#!/usr/bin/env node
// Developer check of one published Claude frontend entry against the current
// adapters, without Claude Desktop. It downloads the entry's public import
// graph, applies the production selection and transforms to static copies and
// reports per adapter. It never executes vendor modules, starts inference or
// reads or writes a live cache or Claudex state.
//
// The entry name itself is not discoverable here: the page that names it is
// served behind a browser check that this script does not attempt. Pass the
// name a real Claude Desktop reported (renderer status `entry.asset`).
//
// Exit status: 0 every adapter passed, 1 at least one adapter failed,
// 2 the graph could not be obtained (network, bounds or usage).
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assetImports, FRONTEND_ASSET_ROOT } from '../test/fixtures/frontend-static.mjs';
import { checkStaticGraph, rustChecker } from './frontend-check-support.mjs';
const MAX_CLAUDE_SOURCE_BYTES = 4 * 1024 * 1024;

const adapters = ['folders', 'chatWake', 'ownerWake', 'commands'];
const usage = 'Usage: node dev/check-claude-frontend-entry.mjs --entry index-<hash>.js [--store DIR] [--report FILE] [--rust-checker EXECUTABLE]';
// The published graph is larger than any cache (2,919 modules and 117 MB were
// observed on 2026-10-12, against 1,223 cached). These bounds only stop a
// runaway download; they are not the production cache bounds.
const MAX_MODULES = 8192, MAX_GRAPH_BYTES = 512 * 1024 * 1024, CONCURRENCY = 16, FETCH_TIMEOUT_MS = 60_000;
const assetName = value => typeof value === 'string' && /^[A-Za-z0-9_-]+\.js$/.test(value);
const isAsset = url => url.startsWith(FRONTEND_ASSET_ROOT) && assetName(url.slice(FRONTEND_ASSET_ROOT.length));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = message => Object.assign(new Error(message), { unavailable: true });

function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--entry', '--store', '--report', '--rust-checker'].includes(argv[i]) || !argv[i + 1]) throw unavailable(usage);
    options[argv[i] === '--rust-checker' ? 'rustChecker' : argv[i].slice(2)] = argv[i + 1];
  }
  if (!assetName(options.entry) || !/^index-/.test(options.entry)) throw unavailable(usage);
  return options;
}

/** The published assets are immutable and named by content hash, so a stored
 * copy is reused as is. A store is vendor code: keep it out of the repository.
 */
export async function loadPublishedGraph({ entry, store, fetchSource = fetchAsset }) {
  const modules = new Map(), queue = [FRONTEND_ASSET_ROOT + entry], queued = new Set(queue);
  let bytes = 0, fetched = 0, active = 0, failure;
  async function load(url) {
    const name = url.slice(FRONTEND_ASSET_ROOT.length), path = join(store, name);
    let decoded;
    try { decoded = await readFile(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      decoded = await fetchSource(url); fetched++;
      await writeFile(`${path}.partial`, decoded, { mode: 0o600 }); await rename(`${path}.partial`, path);
    }
    bytes += decoded.length;
    if (bytes > MAX_GRAPH_BYTES) throw unavailable('Published graph exceeds the download bound');
    const source = decoded.toString('utf8');
    // The production reader refuses these; record them rather than guess.
    const oversized = decoded.length > MAX_CLAUDE_SOURCE_BYTES, canonical = Buffer.from(source).equals(decoded);
    const module = { url, name, source, decoded, sourceHash: sha256(decoded), oversized, canonical };
    modules.set(url, module);
    // Passing the module keeps the binding provenance the adapter proofs read.
    for (const spec of assetImports(source, module)) {
      const target = new URL(spec, url).href;
      if (!isAsset(target) || queued.has(target)) continue;
      if (queued.size >= MAX_MODULES) throw unavailable('Published graph exceeds the module bound');
      queued.add(target); queue.push(target);
    }
  }
  await new Promise(done => {
    const pump = () => {
      if (failure || !queue.length) { if (!active) done(); return; }
      while (active < CONCURRENCY && queue.length) {
        active++;
        load(queue.pop()).catch(error => { failure ??= error; }).finally(() => { active--; pump(); });
      }
    };
    pump();
  });
  if (failure) throw failure;
  return { modules, bytes, fetched };
}

async function fetchAsset(url) {
  let response;
  try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); }
  catch (error) { throw unavailable(`Download failed: ${basename(url)} (${error.name})`); }
  if (!response.ok) throw unavailable(`Download refused: ${basename(url)} (HTTP ${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

/** Selection, transform, syntax and wiring for every adapter of one graph. */
export async function checkPublishedGraph({ modules, entry, temporary, rustChecker: override }) {
  const checker = await rustChecker(override), root = join(temporary, 'state'), home = join(temporary, 'home');
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(home, { recursive: true, mode: 0o700 });
  const manifest = join(temporary, 'published.json'), sources = join(temporary, 'sources'), output = join(temporary, 'rust');
  await mkdir(sources, { mode: 0o700 });
  try {
    const rows = [];
    for (const module of modules.values()) {
      const path = join(sources, module.name);
      await writeFile(path, module.decoded, { mode: 0o600 }); rows.push({ url: module.url, path });
    }
    await writeFile(manifest, JSON.stringify(rows), { mode: 0o600 });
    return (await checkStaticGraph({ checker, root, home, output, published: manifest, entry })).adapters;
  } finally {
    await rm(manifest, { force: true }); await rm(sources, { recursive: true, force: true }); await rm(output, { recursive: true, force: true });
  }
}

/** The complete report for one entry. A graph that cannot be obtained is
 * reported as unavailable, never as failed adapters.
 */
export async function checkPublishedEntry({ entry, store, fetchSource, rustChecker: override }) {
  if (!assetName(entry) || !/^index-/.test(entry)) throw unavailable(usage);
  const checker = await rustChecker(override);
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'claudex-frontend-entry-')));
  const report = { version: 1, engine: 'rust', entry, scope: 'published-graph', staticOnly: true, checkedAt: new Date().toISOString() };
  try {
    const directory = store ? resolve(store) : join(temporary, 'store');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const graph = await loadPublishedGraph({ entry, store: directory, ...(fetchSource ? { fetchSource } : {}) });
    if (!graph.modules.get(FRONTEND_ASSET_ROOT + entry).source.includes('document.getElementById("root")'))
      throw unavailable('Entry bootstrap anchor is absent: not a frontend entry');
    Object.assign(report, { modules: graph.modules.size, bytes: graph.bytes, fetched: graph.fetched,
      outsideReaderBounds: [...graph.modules.values()].filter(m => m.oversized || !m.canonical).map(m => m.name) });
    report.adapters = await checkPublishedGraph({ modules: graph.modules, entry, temporary, rustChecker: checker });
    report.passed = adapters.every(adapter => report.adapters[adapter].status === 'passed');
  } catch (error) {
    if (!error.unavailable) throw error;
    report.unavailable = error.message; report.passed = false;
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return report;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await checkPublishedEntry(options);
  if (options.report) {
    const path = resolve(options.report);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.unavailable ? 2 : report.passed ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try { await main(); }
  catch (error) {
    if (!error.unavailable) throw error;
    process.stderr.write(`${error.message}\n`); process.exitCode = 2;
  }
}
