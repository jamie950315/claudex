#!/usr/bin/env node
// Developer acceptance using local static assets, never live cache writes,
// renderer evaluation, service/app control, native sessions or model inference.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { inspectFolderCache, sha256 } from '../src/claude-folder-cache.mjs';
import { snapshotClaudeCache, validateClaudeCacheManifest } from '../src/claude-folder-install.mjs';
import { assetImports, folderAnchors, chatAnchors, ownerAnchors, commandCatalogAnchors, syntax } from '../src/claude-frontend-anchors.mjs';
import { FRONTEND_ASSET_ROOT, claudeCacheDirectory, discoverClaudeFrontend } from '../src/claude-frontend-graph.mjs';
import { buildClaudeRendererCandidate, ensureClaudeRendererAdapters, restoreClaudeRendererAdapter } from '../src/claude-renderer-adapters.mjs';
import { startClaudeRendererMaintenance } from '../src/claude-renderer-maintenance.mjs';
import { patchContracts, folderConsumerPatchContract } from '../test/fixtures/claude-frontend-contracts.mjs';
import { transformFolderConsumer } from '../src/claude-frontend-anchors.mjs';

const run = promisify(execFile), adapters = ['folders', 'chatWake', 'ownerWake', 'commands'];
const dirs = { folders: 'ui-folders', chatWake: 'ui-chat-wake', ownerWake: 'ui-owner-wake', commands: 'ui-commands' };
const probes = { folders: folderAnchors, chatWake: chatAnchors, ownerWake: ownerAnchors, commands: commandCatalogAnchors };
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const isJS = u => u.startsWith(FRONTEND_ASSET_ROOT) && /^[A-Za-z0-9_-]+\.js$/.test(u.slice(FRONTEND_ASSET_ROOT.length));
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--home', '--root', '--report', '--last-builds'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node dev/verify-claude-frontend-builds.mjs [--home HOME] [--root ROOT] [--report FILE] [--last-builds COUNT]');
  if (args[i] === '--last-builds') {
    const count = Number(args[i + 1]);
    if (!Number.isInteger(count) || count < 2 || count > 64) throw new Error('last-builds must be between 2 and 64');
    options.lastBuilds = count;
  } else options[args[i].slice(2)] = resolve(args[i + 1]);
}
const home = await realpath(options.home ?? homedir()), root = await realpath(options.root ?? join(home, '.local', 'share', 'claudex'));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'claudex-real-frontends-')));
const reportPath = options.report ?? join(temporary, 'report.json');
// A user-supplied report destination must never write into either live tree.
for (const protectedPath of [root, join(home, 'Library', 'Application Support', 'Claude')])
  if (reportPath === protectedPath || reportPath.startsWith(protectedPath + '/')) throw new Error('Report must be outside live state/cache');
const report = { version: 1, staticOnly: true, liveWrites: false, nativeInference: false, builds: [], journals: [], transitions: [] };
const observed = new Map(), modules = new Map(), journals = [], imports = new Map();
const snapshot = async (path, maximum) => {
  const s = await snapshotClaudeCache(path, maximum); observed.set(path, s.hash); return s;
};
const optionalNames = async path => readdir(path).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
const urlOf = bytes => {
  assert.ok(bytes.length >= 24 && bytes.readUInt32LE(12) <= 4096);
  return bytes.subarray(24, 24 + bytes.readUInt32LE(12)).toString().slice(4);
};
async function cacheURL(path) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await fd.stat(); if (!info.isFile()) throw new Error('Non-regular cache inventory entry');
    const h = Buffer.alloc(24); if ((await fd.read(h, 0, 24, 0)).bytesRead !== 24 || h.readBigUInt64LE() !== 0xfcfb6d1ba7725c30n || h.readUInt32LE(8) !== 5) return null;
    const length = h.readUInt32LE(12); if (length < 1 || length > 4096) return null;
    const key = Buffer.alloc(length); if ((await fd.read(key, 0, length, 24)).bytesRead !== length) return null;
    const u = key.toString().slice(4); return key.toString().startsWith('1/0/') && isJS(u) ? u : null;
  } finally { await fd.close(); }
}
async function readJournal(adapter, path) {
  let receipt;
  try { receipt = await snapshot(join(path, 'manifest.json'), 16384); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }
  const manifest = JSON.parse(receipt.bytes), original = await snapshot(join(path, 'original.cache'));
  validateClaudeCacheManifest(manifest, { root: dirname(path), cachePath: manifest.cachePath, sourceHash: manifest.sourceHash });
  assert.equal(original.hash, manifest.originalHash);
  const url = urlOf(original.bytes), entry = inspectFolderCache(original.bytes, { targetURL: url });
  assert.equal(entry.sourceHash, manifest.sourceHash);
  journals.push({ adapter, path, manifest, url, original, entry });
}
const dependencies = m => {
  if (!imports.has(m.url)) imports.set(m.url, assetImports(m.source).map(p => new URL(p, m.url).href).filter(isJS));
  return imports.get(m.url);
};
function reachable(entry) {
  const found = new Map(), missing = new Set(), pending = [entry.url];
  while (pending.length) {
    const u = pending.pop(); if (found.has(u) || missing.has(u)) continue;
    const m = modules.get(u); if (!m) { missing.add(u); continue; }
    found.set(u, m); pending.push(...dependencies(m));
  }
  return { found, missing };
}
async function isolated(label) {
  const base = join(temporary, label), copyHome = join(base, 'home'), copyRoot = join(base, 'state');
  await mkdir(copyHome, { recursive: true, mode: 0o700 }); await mkdir(copyRoot, { mode: 0o700 });
  await mkdir(claudeCacheDirectory(copyHome), { recursive: true, mode: 0o700 });
  return { home: copyHome, root: copyRoot, base };
}
async function copyGraph(f, graph) {
  for (const m of graph.found.values()) await writeFile(join(claudeCacheDirectory(f.home), m.name), m.bytes, { mode: 0o600 });
}
async function nodeCheck(source, name) {
  const path = join(temporary, `${name}.mjs`); await writeFile(path, source, { mode: 0o600 });
  await run(process.execPath, ['--check', path], { maxBuffer: 4096 }); await rm(path);
}
async function validateTarget(adapter, matched, f) {
  if (matched?.status !== 'matched') return { status: 'failed', reason: matched?.reason ?? 'No target' };
  const { target, bindings } = matched, vendor = modules.get(target.url);
  const candidate = await buildClaudeRendererCandidate({ ...f, adapter, matched, original: vendor.bytes });
  const source = inspectFolderCache(candidate, { targetURL: target.url }).source;
  await nodeCheck(source, target.name);
  patchContracts[adapter](source, vendor.source, bindings);
  let consumer;
  if (adapter === 'folders' && matched.consumer) {
    const c = matched.consumer, transformed = transformFolderConsumer(c.target.source, c.bindings);
    await nodeCheck(transformed, c.target.name);
    folderConsumerPatchContract(transformed, c.target.source, c.bindings);
    consumer = { asset: basename(c.target.url), originalSourceSHA256: c.target.sourceHash,
      memoGuards: c.bindings.guards.length, nodeCheck: 'passed', vendorASTAndWiring: 'passed' };
  }
  return { status: 'passed', asset: basename(target.url), cacheFilename: target.name, originalSourceSHA256: target.sourceHash,
    targetCount: 1, anchors: 'resolved', nodeCheck: 'passed', vendorASTAndWiring: 'passed',
    variants: bindings.variants?.length ?? 1, ...(consumer ? { consumer } : {}), ...(bindings.search ? { search: bindings.search } : {}),
    ...(bindings.client ? { client: bindings.client } : { native: bindings.native }) };
}

async function historicalPin(adapter, module) {
  if (adapter === 'commands') return null;
  const path = `src/${adapter === 'folders' ? 'claude-folder' : adapter === 'chatWake' ? 'claude-chat-wake' : 'claude-owner-wake'}-cache.mjs`;
  const { stdout } = await run('git', ['log', '--format=%H', '377c704^', '--', path], { cwd: repository });
  for (const ref of stdout.trim().split('\n').filter(Boolean)) {
    const { stdout: source } = await run('git', ['show', `${ref}:${path}`], { cwd: repository, maxBuffer: 1024 * 1024 });
    if (!source.includes(module.sourceHash)) continue;
    // Execute only our trusted repository's historical transformer, never
    // vendor code. Absolute imports keep native dependencies in this checkout.
    let code = source;
    for (const n of syntax(source).body.filter(n => n.type === 'ImportDeclaration').reverse()) {
      if (n.source.value.startsWith('.')) code = code.slice(0, n.source.start)
        + JSON.stringify(pathToFileURL(join(repository, 'src', n.source.value)).href) + code.slice(n.source.end);
    }
    const dest = join(temporary, `pin-${adapter}-${ref}.mjs`); await writeFile(dest, code, { mode: 0o600 });
    return { ref, pin: await import(pathToFileURL(dest).href) };
  }
  return null;
}
async function comparePin(adapter, m, bindings) {
  const old = await historicalPin(adapter, m); if (!old) return { status: 'not-available', reason: 'No historical hand-pin for these vendor bytes' };
  const runtime = name => readFile(new URL(`../src/${name}.mjs`, import.meta.url), 'utf8');
  const opts = { root, registryRoot: join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
    projectionSource: await runtime('claude-folder-projection'), runtimeSource: await runtime(adapter === 'ownerWake' ? 'claude-owner-wake-runtime' : 'claude-folder-runtime'),
    handoffSource: await runtime('claude-desktop-handoff-runtime'), anchorSource: await runtime('claude-folder-anchor'), wakeSource: adapter === 'chatWake' ? await runtime('claude-chat-wake-runtime') : '' };
  const oldSource = adapter === 'folders' ? old.pin.buildDynamicFolderSource(m.source, opts)
    : adapter === 'chatWake' ? old.pin.buildClaudeChatWakeSource(m.source, opts) : old.pin.buildClaudeOwnerWakeSource(m.source, opts);
  await nodeCheck(oldSource, `pin-${m.name}`);
  const candidate = await buildClaudeRendererCandidate({ root, home, adapter, matched: { status: 'matched', target: m, bindings }, original: m.bytes });
  const source = inspectFolderCache(candidate, { targetURL: m.url }).source;
  assert.deepEqual(patchContracts[adapter](source, m.source, bindings), patchContracts[adapter](oldSource, m.source, bindings));
  return { status: 'passed', commit: old.ref, scope: 'Native bindings, adapter wiring and preserved vendor AST; current runtime supplied to both transforms; diagnostic label spelling excluded' };
}

try {
  for (const adapter of adapters) {
    for (const name of await optionalNames(join(root, dirs[adapter]))) {
      if (/^[a-f0-9]{16}_0$/.test(name)) await readJournal(adapter, join(root, dirs[adapter], name, 'ui-folder-compat'));
      else if (name === 'ui-folder-compat') await readJournal(adapter, join(root, dirs[adapter], name));
    }
  }
  await readJournal('folders', join(root, 'ui-folder-compat'));
  const directory = claudeCacheDirectory(home), names = await readdir(directory); assert.ok(names.length <= 32768);
  for (const name of names.filter(n => /^[a-f0-9]{16}_0$/.test(n))) {
    const path = join(directory, name), url = await cacheURL(path); if (!url) continue;
    const current = await snapshot(path); assert.equal(urlOf(current.bytes), url);
    const journal = journals.find(j => j.url === url);
    const bytes = journal?.original.bytes ?? current.bytes;
    if (journal) assert.ok([journal.manifest.originalHash, journal.manifest.patchedHash, journal.manifest.previousPatchedHash].includes(current.hash), 'Foreign cache change');
    const entry = inspectFolderCache(bytes, { targetURL: url });
    assert.ok(!entry.source.includes('__cldx') && !entry.source.includes('[Claudex '), 'Unjournaled frontend patch');
    assert.ok(!modules.has(url), 'Duplicate native cache URL'); modules.set(url, { url, name, bytes, ...entry });
  }
  for (const j of journals) if (!modules.has(j.url)) modules.set(j.url, { url: j.url, name: basename(j.manifest.cachePath), bytes: j.original.bytes, ...j.entry });
  const entries = [...modules.values()].filter(m => /^index-[A-Za-z0-9_-]+\.js$/.test(basename(m.url)))
    .sort((a, b) => Number(a.metadata.readBigInt64LE(20) - b.metadata.readBigInt64LE(20)));
  assert.ok(entries.length, 'No real entry assets available'); report.availableEntries = entries.length;
  const graphs = [], consumers = new Map();
  for (const [i, entry] of (options.lastBuilds ? entries.slice(-options.lastBuilds) : entries).entries()) {
    const g = reachable(entry); graphs.push({ entry, ...g });
    const f = await isolated(`build-${i}`); await copyGraph(f, g);
    const row = { entry: basename(entry.url), fetchedAt: new Date(Number((entry.metadata.readBigInt64LE(20) - 11644473600000000n) / 1000n)).toISOString(),
      cachedModules: g.found.size, missingModules: [...g.missing].map(basenameSafe), adapters: {} };
    report.builds.push(row); process.stderr.write(`Checking ${row.entry} (${g.found.size} cached modules)\n`);
    try {
      const graph = await discoverClaudeFrontend(f);
      if (graph.adapters.folders.consumer) consumers.set(graph.adapters.folders.consumer.target.url, graph.adapters.folders.consumer);
      for (const adapter of adapters) {
        try {
          row.adapters[adapter] = await validateTarget(adapter, graph.adapters[adapter], f);
          if (row.adapters[adapter].status === 'passed') {
            const m = modules.get(graph.adapters[adapter].target.url);
            try { row.adapters[adapter].handPinEquivalence = await comparePin(adapter, m, graph.adapters[adapter].bindings); }
            catch (e) { row.adapters[adapter].handPinEquivalence = { status: 'failed', reason: e.message.slice(0, 300) }; }
          }
        } catch (e) { row.adapters[adapter] = { status: 'failed', reason: e.message.slice(0, 300) }; }
      }
      const installed = await ensureClaudeRendererAdapters({ ...f, graph });
      for (const adapter of adapters) {
        const result = installed.adapters[adapter]; row.adapters[adapter].installation = result.status;
        if (result.status !== 'installed') {
          row.adapters[adapter].status = 'failed'; row.adapters[adapter].reason = result.reason; continue;
        }
        const matched = graph.adapters[adapter], source = inspectFolderCache(await readFile(matched.target.path), { targetURL: matched.target.url }).source;
        let baseline = matched.target.source;
        if (adapter === 'chatWake' && result.sharedResource) {
          const candidate = await buildClaudeRendererCandidate({ ...f, adapter: 'folders', matched: graph.adapters.folders, original: modules.get(matched.target.url).bytes });
          baseline = inspectFolderCache(candidate, { targetURL: matched.target.url }).source;
        }
        await nodeCheck(source, `installed-${matched.target.name}`); patchContracts[adapter](source, baseline, matched.bindings);
        if (result.sharedResource) row.adapters[adapter].journalAdapter = result.journalAdapter;
      }
    } catch (e) { row.discovery = { status: 'failed', reason: e.message.slice(0, 300) }; }
    process.stderr.write(`  ${adapters.map(a => `${a}:${row.adapters[a]?.status ?? 'failed'}`).join(' ')}\n`);
    await rm(f.base, { recursive: true });
  }
  // Every journal is accounted for, including obsolete hand-pins into the
  // Chat/Cowork module. Those may not qualify as today's Code owner adapter.
  for (const j of journals) {
    const m = modules.get(j.url), row = { adapter: j.adapter, asset: basename(j.url), cacheFilename: m.name,
      entries: graphs.filter(g => g.found.has(j.url)).map(g => basename(g.entry.url)), missingDirectModules: dependencies(m).filter(u => !modules.has(u)).map(basenameSafe) };
    report.journals.push(row);
    try {
      const consumer = j.adapter === 'folders' ? consumers.get(j.url) : null;
      if (consumer) {
        assert.equal(m.sourceHash, consumer.target.sourceHash);
        const transformed = transformFolderConsumer(m.source, consumer.bindings);
        await nodeCheck(transformed, `journal-${m.name}`);
        folderConsumerPatchContract(transformed, m.source, consumer.bindings);
        row.transform = { status: 'passed', role: 'folder-consumer', nodeCheck: 'passed', vendorASTAndWiring: 'passed' };
        row.handPinEquivalence = { status: 'not-available', reason: 'Split consumer has no historical hand-pin' };
        continue;
      }
      const bindings = probes[j.adapter](m.source, { get: p => modules.get(new URL(p, m.url).href) });
      const f = { root, home }; row.transform = await validateTarget(j.adapter, { status: 'matched', target: m, bindings }, f);
      row.handPinEquivalence = await comparePin(j.adapter, m, bindings);
    } catch (e) { row.status = 'failed'; row.reason = e.message.slice(0, 300); }
  }
  // The actual watcher entry point observes actual fs.watch notifications in
  // its isolated copy. Install N, replace its cache with N+1, wait for reported
  // installation, and prove old immutable originals AND receipts survived.
  const previous = graphs.at(-2), current = graphs.at(-1);
  if (previous && current) {
    const f = await isolated('automatic-reapply'); await copyGraph(f, previous);
    const statuses = []; let maintenance;
    try {
      maintenance = await startClaudeRendererMaintenance({ ...f, settleMs: 50, onStatus: s => statuses.push(s) });
      assert.equal(statuses.at(-1).state, 'ready');
      const before = new Map();
      for (const adapter of adapters) for (const n of await optionalNames(join(f.root, dirs[adapter]))) {
        const p = join(f.root, dirs[adapter], n, 'ui-folder-compat');
        for (const file of ['original.cache', 'manifest.json']) before.set(join(p, file), sha256(await readFile(join(p, file))));
      }
      // Replace entries only inside this process's temporary home. Never
      // copy journaled patched bytes over an unchanged, shared vendor URL.
      for (const [u, m] of current.found) if (!previous.found.has(u)) await writeFile(join(claudeCacheDirectory(f.home), m.name), m.bytes, { mode: 0o600 });
      const targetEntry = basename(current.entry.url), until = Date.now() + 120000;
      while ((statuses.at(-1)?.entry?.asset !== targetEntry || statuses.at(-1)?.state !== 'ready') && Date.now() < until) await new Promise(r => setTimeout(r, 100));
      await maintenance.close(); maintenance = null;
      assert.equal(statuses.at(-1).entry.asset, targetEntry); assert.equal(statuses.at(-1).state, 'ready');
      for (const [p, hash] of before) assert.equal(sha256(await readFile(p)), hash, 'Old journal receipt/original preserved');
      const graph = await discoverClaudeFrontend(f);
      for (const adapter of adapters) {
        const target = graph.adapters[adapter].target, installed = inspectFolderCache(await readFile(target.path), { targetURL: target.url });
        // A chat bootstrap sharing the folder resource follows the folder transform.
        let baseline = target.source;
        if (adapter === 'chatWake' && graph.adapters.folders.target.url === target.url) {
          const candidate = await buildClaudeRendererCandidate({ ...f, adapter: 'folders', matched: graph.adapters.folders, original: modules.get(target.url).bytes });
          baseline = inspectFolderCache(candidate, { targetURL: target.url }).source;
        }
        await nodeCheck(installed.source, target.name); patchContracts[adapter](installed.source, baseline, graph.adapters[adapter].bindings);
      }
      const again = await ensureClaudeRendererAdapters(f); assert.ok(Object.values(again.adapters).every(a => a.status === 'installed' && !a.changed));
      for (const adapter of adapters) {
        const target = graph.adapters[adapter].target;
        // Restoring the folder adapter restores a shared resource completely.
        if (adapter !== 'chatWake' || graph.adapters.folders.target.url !== target.url)
          await restoreClaudeRendererAdapter({ ...f, adapter, cachePath: target.path });
        assert.deepEqual(await readFile(target.path), modules.get(target.url).bytes);
      }
      report.transitions.push({ from: basename(previous.entry.url), to: targetEntry, status: 'passed', entryPoint: 'startClaudeRendererMaintenance',
        actualFilesystemNotifications: true, adapters: statuses.at(-1).adapters, oldOriginalsAndReceipts: 'unchanged', idempotentReinstall: 'passed', restore: 'passed' });
    } catch (e) { report.transitions.push({ status: 'failed', reason: e.message.slice(0, 300), observations: statuses.slice(-3) }); }
    finally { await maintenance?.close(); await rm(f.base, { recursive: true }); }
  }
  for (const [p, hash] of observed) assert.equal((await snapshotClaudeCache(p, p.endsWith('manifest.json') ? 16384 : undefined)).hash, hash, 'Live source changed during verification');
  report.liveSourcesUnchanged = true;
  report.adapterAcceptancePassed = report.builds.every(b => !b.discovery && adapters.every(a => b.adapters[a]?.status === 'passed' && b.adapters[a].installation === 'installed'))
    && report.transitions.length > 0 && report.transitions.every(t => t.status === 'passed');
  report.passed = report.adapterAcceptancePassed && report.builds.every(b => !b.discovery && adapters.every(a => b.adapters[a]?.status === 'passed'
    && b.adapters[a].handPinEquivalence?.status !== 'failed'))
    && report.transitions.every(t => t.status === 'passed') && report.journals.every(j => j.status !== 'failed');
} catch (e) { report.fatal = e.message.slice(0, 300); report.passed = false; }
finally {
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); await chmod(reportPath, 0o600);
  // Keep only metadata reports, never private vendor bytes or historical code.
  for (const name of await readdir(temporary)) if (join(temporary, name) !== reportPath) await rm(join(temporary, name), { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ report: reportPath, passed: report.passed, adapterAcceptancePassed: report.adapterAcceptancePassed, entries: report.availableEntries,
  builds: report.builds.map(b => ({ entry: b.entry, adapters: Object.fromEntries(Object.entries(b.adapters).map(([a, r]) => [a, r.status])) })),
  transitions: report.transitions, fatal: report.fatal }, null, 2) + '\n');
process.exitCode = report.passed ? 0 : 1;
function basenameSafe(url) { return basename(url); }
