#!/usr/bin/env node
// Read-only real-cache inventory, then production Rust acceptance on temporary
// copies. Never evaluates vendor code, starts inference or changes live state.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { assetImports, claudeCacheDirectory, FRONTEND_ASSET_ROOT } from '../test/fixtures/frontend-static.mjs';
import { adapters, checkStaticGraph, invokeChecker, rustChecker, sandboxDirectories } from './frontend-check-support.mjs';

const usage = 'Usage: node dev/verify-claude-frontend-builds.mjs [--home HOME] [--root ROOT] [--report FILE] [--last-builds COUNT | --first-builds COUNT | --entry index-NAME.js] [--rust-checker EXECUTABLE] [--rust-only true]';
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--home', '--root', '--report', '--last-builds', '--first-builds', '--entry', '--rust-checker', '--rust-only'].includes(args[i]) || !args[i + 1]) throw new Error(usage);
  const [key, value] = [args[i].slice(2), args[i + 1]];
  if (['last-builds', 'first-builds'].includes(key)) {
    if (!Number.isInteger(Number(value)) || Number(value) < 2 || Number(value) > 64) throw new Error(`${key} must be between 2 and 64`);
    options[key] = Number(value);
  } else if (key === 'rust-only') {
    // Retained CLI compatibility: Rust is now the only engine in every mode.
    if (value !== 'true') throw new Error('rust-only requires true');
  } else if (key === 'entry') {
    if (!/^index-[A-Za-z0-9_-]+.js$/.test(value)) throw new Error('entry must be a native index asset name');
    options.entry = value;
  } else options[key] = resolve(value);
}
if ([options.entry, options['last-builds'], options['first-builds']].filter(Boolean).length > 1) throw new Error('Use one entry selection option');
const checker = await rustChecker(options['rust-checker']);
const home = await realpath(options.home ?? homedir()), root = await realpath(options.root ?? join(home, '.local', 'share', 'claudex'));
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'claudex-real-frontends-')));
const reportPath = options.report ?? join(temporary, 'report.json');
for (const protectedPath of [root, join(home, 'Library', 'Application Support', 'Claude')])
  if (reportPath === protectedPath || reportPath.startsWith(protectedPath + '/')) throw new Error('Report must be outside live state/cache');
const report = { version: 1, engine: 'rust', staticOnly: true, liveWrites: false, nativeInference: false, builds: [], journals: [], transitions: [] };
const dirs = { folders: 'ui-folders', chatWake: 'ui-chat-wake', ownerWake: 'ui-owner-wake', commands: 'ui-commands' };
const optionalNames = async path => readdir(path).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
const passed = rows => adapters.every(adapter => rows[adapter]?.status === 'passed');
const sourceByURL = async rows => new Map(await Promise.all(rows.map(async row => [row.url, await readFile(row.path, 'utf8')])));
const mode = (f, operation, extra = {}) => invokeChecker(checker, { root: f.root, home: f.home, sandbox: f.base, operation, ...extra });
async function isolated(label) {
  const f = await sandboxDirectories(join(temporary, label));
  await mkdir(claudeCacheDirectory(f.home), { recursive: true, mode: 0o700 }); return f;
}
async function copyGraph(f, graph, previous) {
  for (const [url, module] of graph.found) if (!previous?.found.has(url))
    await writeFile(join(claudeCacheDirectory(f.home), module.name), await readFile(module.bytesPath), { mode: 0o600 });
}
async function receipts(f) {
  const rows = new Map();
  for (const directory of Object.values(dirs)) for (const name of await optionalNames(join(f.root, directory))) {
    if (!/^[a-f0-9]{16}_0$/.test(name)) continue;
    for (const file of ['original.cache', 'manifest.json']) {
      const path = join(f.root, directory, name, 'ui-folder-compat', file); rows.set(path, await readFile(path));
    }
  }
  return rows;
}
async function validateInstalled(f, checked, label) {
  const installation = await mode(f, 'install', { output: join(f.base, label) });
  const actual = await sourceByURL(installation.installedSources), expected = new Map();
  for (const adapter of adapters) {
    const target = checked.result.adapters[adapter];
    if (target.status !== 'matched') continue;
    for (const item of target.sources) {
      const candidate = await readFile(item.path, 'utf8');
      if (adapter === 'chatWake' && expected.has(item.url)) {
        const original = await readFile(item.original, 'utf8');
        assert.ok(candidate.startsWith(original), 'shared chat transform retains every original byte');
        expected.set(item.url, expected.get(item.url) + candidate.slice(original.length));
      } else expected.set(item.url, candidate);
    }
  }
  assert.deepEqual(actual, expected, 'installed resources equal the syntax/AST/wiring-verified Rust candidates');
  return installation;
}
async function reinstallAndRestore(f, checked, graph) {
  const before = await receipts(f), again = await validateInstalled(f, checked, 'reinstall');
  assert.ok(Object.values(again.adapters).every(adapter => adapter.status === 'installed' && !adapter.changed), 'idempotent reinstall');
  for (const [path, bytes] of before) assert.deepEqual(await readFile(path), bytes, 'idempotent reinstall preserves journals');
  const restored = new Set();
  for (const adapter of adapters) {
    const target = checked.result.adapters[adapter];
    if (target.status !== 'matched' || restored.has(target.url)) continue;
    await mode(f, 'restore', { adapter, 'cache-path': join(claudeCacheDirectory(f.home), graph.found.get(target.url).name) });
    for (const item of target.sources) restored.add(item.url);
  }
  for (const url of restored) {
    const module = graph.found.get(url);
    assert.deepEqual(await readFile(join(claudeCacheDirectory(f.home), module.name)), await readFile(module.bytesPath), 'restore preserves exact native containers');
  }
}
async function startMaintenance(f) {
  const child = spawn(checker, ['--root', f.root, '--home', f.home, '--sandbox', f.base, '--operation', 'watch'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const statuses = [], lines = createInterface({ input: child.stdout }); let failure, stderr = '';
  const exited = new Promise((done, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? done() : reject(new Error(`Rust maintenance exited ${code}: ${stderr}`))); });
  exited.catch(error => { failure = error; });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
  lines.on('line', line => { try { const value = JSON.parse(line); if (value.status) statuses.push(value.status); } catch (error) { failure = error; } });
  const watcher = watch(claudeCacheDirectory(f.home), (_event, filename) => {
    if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ filename: filename?.toString() ?? null }) + '\n');
  });
  watcher.on('error', error => { failure = error; });
  return { statuses,
    async wait(entry) {
      const until = Date.now() + 120000;
      while (statuses.at(-1)?.state !== 'ready' || statuses.at(-1)?.entry?.asset !== entry) {
        if (failure) throw failure;
        if (Date.now() >= until) throw new Error(`Rust maintenance did not become ready for ${entry}: ${JSON.stringify(statuses.slice(-2))}`);
        await new Promise(done => setTimeout(done, 100));
      }
    },
    async close() { watcher.close(); child.stdin.end(); await exited; lines.close(); },
  };
}
try {
  const inventory = await invokeChecker(checker, { root, home, operation: 'inventory', output: join(temporary, 'inventory') });
  report.liveSourcesUnchanged = inventory.liveSourcesUnchanged;
  const modules = new Map(inventory.modules.map(module => [module.url, module]));
  const entries = inventory.modules.filter(module => /^index-[A-Za-z0-9_-]+\.js$/.test(basename(module.url)))
    .sort((a, b) => a.fetchedAtMicros - b.fetchedAtMicros);
  assert.ok(entries.length, 'No real entry assets available'); report.availableEntries = entries.length;
  const selected = options.entry ? entries.filter(entry => basename(entry.url) === options.entry)
    : options['last-builds'] ? entries.slice(-options['last-builds']) : options['first-builds'] ? entries.slice(0, options['first-builds']) : entries;
  assert.ok(selected.length, 'Requested real entry is unavailable');
  const graphs = [];
  for (const [index, entry] of selected.entries()) {
    const found = new Map(), missing = new Set(), pending = [entry.url];
    while (pending.length) {
      const url = pending.pop(); if (found.has(url) || missing.has(url)) continue;
      const module = modules.get(url); if (!module) { missing.add(url); continue; }
      found.set(url, module);
      module.imports ??= assetImports(await readFile(module.sourcePath, 'utf8'));
      pending.push(...module.imports.map(spec => new URL(spec, url).href).filter(url => url.startsWith(FRONTEND_ASSET_ROOT) && /^[\w-]+\.js$/.test(url.slice(FRONTEND_ASSET_ROOT.length))));
    }
    const graph = { entry, found, missing }; graphs.push(graph);
    const f = await isolated(`build-${index}`); await copyGraph(f, graph);
    const row = { entry: basename(entry.url), fetchedAt: new Date(entry.fetchedAtMicros / 1000).toISOString(), cachedModules: found.size,
      missingModules: [...missing].map(url => basename(url)), adapters: {} }; report.builds.push(row);
    process.stderr.write(`Checking ${row.entry} (${found.size} cached modules)\n`);
    try {
      const checked = await checkStaticGraph({ checker, root: f.root, home: f.home, output: join(f.base, 'checked') });
      assert.equal(checked.result.entry.asset, row.entry, 'Rust selects the requested native entry');
      row.adapters = checked.adapters; row.rust = row.adapters;
      const installed = await validateInstalled(f, checked, 'installed');
      for (const adapter of adapters) {
        row.adapters[adapter].installation = installed.adapters[adapter].status;
        if (installed.adapters[adapter].status !== 'installed') row.adapters[adapter].status = 'failed';
      }
      if (passed(row.adapters)) { await reinstallAndRestore(f, checked, graph); row.idempotentReinstall = row.restore = 'passed'; }
    } catch (error) { row.discovery = { status: 'failed', reason: error.message.slice(0, 400) }; }
    process.stderr.write(`  ${adapters.map(adapter => `${adapter}:${row.adapters[adapter]?.status ?? 'failed'}`).join(' ')}\n`);
    for (const adapter of adapters) if (row.adapters[adapter]?.status === 'failed') process.stderr.write(`    ${adapter}: ${row.adapters[adapter].reason}\n`);
  }
  report.journals = inventory.journals.map(({ adapter, asset, url, cacheFilename, status }) => ({ adapter, asset, cacheFilename, status,
    entries: graphs.filter(graph => graph.found.has(url)).map(graph => basename(graph.entry.url)),
    handPinEquivalence: { status: 'retired', reason: 'Legacy JavaScript transformers are archived on codex/javascript-legacy; immutable native originals remain validated' } }));
  const previous = graphs.at(-2), current = graphs.at(-1);
  if (previous && current && !report.builds.slice(-2).every(row => !row.discovery && passed(row.adapters))) {
    report.transitions.push({ from: basename(previous.entry.url), to: basename(current.entry.url), status: 'skipped',
      reason: 'Initial or selected graph failed adapter acceptance' });
  } else if (previous && current) {
    const f = await isolated('automatic-reapply'); await copyGraph(f, previous); let maintenance;
    try {
      maintenance = await startMaintenance(f); await maintenance.wait(basename(previous.entry.url));
      const before = await receipts(f);
      await copyGraph(f, current, previous); await maintenance.wait(basename(current.entry.url));
      await maintenance.close(); const statuses = maintenance.statuses; maintenance = null;
      for (const [path, bytes] of before) assert.deepEqual(await readFile(path), bytes, 'old immutable originals and receipts survive reapplication');
      const checked = await checkStaticGraph({ checker, root: f.root, home: f.home, output: join(f.base, 'checked') });
      assert.ok(passed(checked.adapters), 'new entry retains every AST/wiring contract');
      await validateInstalled(f, checked, 'installed'); await reinstallAndRestore(f, checked, current);
      report.transitions.push({ from: basename(previous.entry.url), to: basename(current.entry.url), status: 'passed', entryPoint: 'frontend_maintenance::Maintenance',
        actualFilesystemNotifications: true, adapters: statuses.at(-1).adapters, oldOriginalsAndReceipts: 'unchanged', idempotentReinstall: 'passed', restore: 'passed' });
    } catch (error) { report.transitions.push({ status: 'failed', reason: error.message.slice(0, 400) }); }
    finally { await maintenance?.close(); }
  }
  report.rustAcceptancePassed = report.builds.every(row => !row.discovery && passed(row.adapters));
  report.adapterAcceptancePassed = report.rustAcceptancePassed && report.builds.every(row => row.restore === 'passed')
    && report.transitions.every(row => row.status === 'passed');
  report.passed = report.adapterAcceptancePassed;
} catch (error) { report.fatal = error.message.slice(0, 400); report.passed = false; }
finally {
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  for (const name of await readdir(temporary)) if (join(temporary, name) !== reportPath) await rm(join(temporary, name), { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ report: reportPath, passed: report.passed, adapterAcceptancePassed: report.adapterAcceptancePassed, entries: report.availableEntries,
  builds: report.builds.map(row => ({ entry: row.entry, adapters: Object.fromEntries(Object.entries(row.adapters).map(([adapter, value]) => [adapter, value.status])) })),
  transitions: report.transitions, fatal: report.fatal }, null, 2) + '\n');
process.exitCode = report.passed ? 0 : 1;
