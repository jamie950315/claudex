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
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { crc32, zstdCompressSync } from 'node:zlib';
import { inspectFolderCache, MAX_CLAUDE_SOURCE_BYTES } from '../src/claude-folder-cache.mjs';
import { assetImports, transformFolderConsumer } from '../src/claude-frontend-anchors.mjs';
import { FRONTEND_ASSET_ROOT, resolveClaudeFrontendAdapters } from '../src/claude-frontend-graph.mjs';
import { buildClaudeRendererCandidate } from '../src/claude-renderer-adapters.mjs';
import { patchContracts, folderConsumerPatchContract } from '../test/fixtures/claude-frontend-contracts.mjs';

const run = promisify(execFile), adapters = ['folders', 'chatWake', 'ownerWake', 'commands'];
const usage = 'Usage: node dev/check-claude-frontend-entry.mjs --entry index-<hash>.js [--store DIR] [--report FILE]';
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
    if (!['--entry', '--store', '--report'].includes(argv[i]) || !argv[i + 1]) throw unavailable(usage);
    options[argv[i].slice(2)] = argv[i + 1];
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

/** A cache container for one vendor source in the layout the production
 * reader and its length-resizing writer accept. Only its source is real.
 */
export function publishedCacheEntry(url, decoded) {
  const key = Buffer.from(`1/0/${url}`), body = zstdCompressSync(decoded);
  const header = Buffer.alloc(24);
  header.writeBigUInt64LE(0xfcfb6d1ba7725c30n); header.writeUInt32LE(5, 8); header.writeUInt32LE(key.length, 12);
  const raw = Buffer.from(`HTTP/1.1 200\0content-length:${body.length}\0x-goog-stored-content-length:${body.length}\0\0`);
  const prefix = Buffer.alloc(40), padding = Buffer.alloc((4 - raw.length % 4) % 4);
  prefix.writeUInt32LE(prefix.length + raw.length + padding.length - 4, 0);
  prefix.writeUInt32LE(0x82476d03, 4); prefix.writeUInt32LE(6, 8);
  const time = 11644473600000000n + BigInt(Date.now() - 10_000) * 1000n;
  for (const at of [12, 20, 28]) prefix.writeBigInt64LE(time, at);
  prefix.writeUInt32LE(raw.length, 36);
  const metadata = Buffer.concat([prefix, raw, padding]);
  const footer = (flags, data, size) => {
    const bytes = Buffer.alloc(24);
    bytes.writeBigUInt64LE(0xf4fa6f45970d41d8n); bytes.writeUInt32LE(flags, 8);
    bytes.writeUInt32LE(crc32(data), 12); bytes.writeBigUInt64LE(BigInt(size), 16);
    return bytes;
  };
  return Buffer.concat([header, key, body, footer(1, body, 0), metadata, createHash('sha256').update(key).digest(), footer(3, metadata, metadata.length)]);
}

/** Selection, transform, syntax and wiring for every adapter of one graph. */
export async function checkPublishedGraph({ modules, entry, temporary }) {
  const root = join(temporary, 'state'), home = join(temporary, 'home');
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(home, { recursive: true, mode: 0o700 });
  const nodeCheck = async (source, name) => {
    const path = join(temporary, `${name}.mjs`);
    await writeFile(path, source, { mode: 0o600 });
    try { await run(process.execPath, ['--check', path], { maxBuffer: 4096 }); } finally { await rm(path, { force: true }); }
  };
  const matched = resolveClaudeFrontendAdapters(modules, FRONTEND_ASSET_ROOT + entry), results = {};
  for (const adapter of adapters) {
    const found = matched[adapter];
    if (found.status !== 'matched') { results[adapter] = { status: 'failed', phase: 'selection', reason: found.reason }; continue; }
    const { target, bindings, consumer } = found;
    try {
      if (target.oversized || !target.canonical) throw new Error('Target source is outside the production reader bounds');
      const candidate = await buildClaudeRendererCandidate({ root, home, adapter, matched: found,
        original: publishedCacheEntry(target.url, target.decoded) });
      const source = inspectFolderCache(candidate, { targetURL: target.url }).source;
      await nodeCheck(source, `${adapter}-target`);
      patchContracts[adapter](source, target.source, bindings);
      results[adapter] = { status: 'passed', asset: target.name, sourceSHA256: target.sourceHash };
      if (adapter === 'folders' && consumer) {
        const transformed = transformFolderConsumer(consumer.target.source, consumer.bindings);
        await nodeCheck(transformed, 'folders-consumer');
        folderConsumerPatchContract(transformed, consumer.target.source, consumer.bindings);
        results[adapter].consumer = { asset: consumer.target.name, sourceSHA256: consumer.target.sourceHash };
      }
    } catch (error) {
      results[adapter] = { status: 'failed', phase: 'transform', asset: target.name, reason: String(error.message).slice(0, 240) };
    }
  }
  return results;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const temporary = await mkdtemp(join(tmpdir(), 'claudex-frontend-entry-'));
  const report = { version: 1, entry: options.entry, scope: 'published-graph', staticOnly: true, checkedAt: new Date().toISOString() };
  try {
    const store = options.store ? resolve(options.store) : join(temporary, 'store');
    await mkdir(store, { recursive: true, mode: 0o700 });
    const graph = await loadPublishedGraph({ entry: options.entry, store });
    if (!graph.modules.get(FRONTEND_ASSET_ROOT + options.entry).source.includes('document.getElementById("root")'))
      throw unavailable('Entry bootstrap anchor is absent: not a frontend entry');
    Object.assign(report, { modules: graph.modules.size, bytes: graph.bytes, fetched: graph.fetched,
      outsideReaderBounds: [...graph.modules.values()].filter(m => m.oversized || !m.canonical).map(m => m.name) });
    report.adapters = await checkPublishedGraph({ modules: graph.modules, entry: options.entry, temporary });
    report.passed = adapters.every(adapter => report.adapters[adapter].status === 'passed');
  } catch (error) {
    if (!error.unavailable) throw error;
    report.unavailable = error.message; report.passed = false;
  } finally { await rm(temporary, { recursive: true, force: true }); }
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
