#!/usr/bin/env node
// Maintainer service that checks every Claude frontend entry it is told about
// against the current adapters, on a machine without Claude Desktop.
//
//   submit   record an entry name a real Claude Desktop reported
//   run      check every queued entry once and keep its report
//   regress  recheck every reported entry with the current checkout and
//            compare each adapter's result with the saved report
//   sightings  list when each source first reported each entry
//
// Entry names come only from real Claude Desktop installations. This service
// never asks claude.ai for one. Its state directory holds vendor code and
// stays outside the repository.
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { checkPublishedEntry } from '../check-claude-frontend-entry.mjs';

const run = promisify(execFile), adapters = ['folders', 'chatWake', 'ownerWake', 'commands'];
const usage = 'Usage: node dev/frontend-watch/watch.mjs <submit|run|regress|sightings> --state DIR [--entry index-<hash>.js] [--source NAME] [--rust-checker EXECUTABLE]';
const entryName = value => typeof value === 'string' && /^index-[A-Za-z0-9_-]{1,64}\.js$/.test(value);
const sourceName = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const optional = async path => { try { return await json(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
async function save(path, value) {
  await writeFile(`${path}.partial`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(`${path}.partial`, path);
}
const names = async directory => (await readdir(directory)).filter(name => entryName(name.replace(/\.json$/, '')) && name.endsWith('.json')).sort();

export async function openState(state) {
  const root = resolve(state), paths = { root, queue: join(root, 'queue'), reports: join(root, 'reports'), store: join(root, 'store'), sightings: join(root, 'sightings') };
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true, mode: 0o700 });
  return paths;
}

/** Idempotent: a reported or already queued entry is not queued again. */
export async function submit(paths, { entry, source = 'unknown', now = () => new Date() }) {
  if (!entryName(entry) || !sourceName(source)) throw new Error(usage);
  // The first time each source reports an entry is kept, whatever the entry's
  // state, so sources can be compared by how soon they see a new frontend.
  const seenPath = join(paths.sightings, `${entry}.json`), seen = await optional(seenPath) ?? { version: 1, entry, sources: {} };
  if (!seen.sources[source]) { seen.sources[source] = now().toISOString(); await save(seenPath, seen); }
  const report = await optional(join(paths.reports, `${entry}.json`));
  if (report) return { entry, state: report.passed ? 'passed' : 'failed' };
  const path = join(paths.queue, `${entry}.json`);
  if (await optional(path)) return { entry, state: 'queued' };
  await save(path, { version: 1, entry, source, submittedAt: now().toISOString(), attempts: 0 });
  return { entry, state: 'queued', added: true };
}

/** One pass over the queue. An unavailable graph stays queued for the next
 * pass; a passed or failed one is reported once and leaves the queue.
 */
export async function runQueue(paths, { check = checkPublishedEntry, rustChecker, onFailure, now = () => new Date() } = {}) {
  const results = [];
  for (const name of await names(paths.queue)) {
    const path = join(paths.queue, name), queued = await json(path);
    const report = await check({ entry: queued.entry, store: paths.store, ...(rustChecker ? { rustChecker } : {}) });
    if (report.unavailable) {
      await save(path, { ...queued, attempts: queued.attempts + 1, lastAttemptAt: now().toISOString(), lastUnavailable: report.unavailable });
      results.push({ entry: queued.entry, state: 'unavailable', reason: report.unavailable });
      continue;
    }
    const reportPath = join(paths.reports, name);
    await save(reportPath, { ...report, source: queued.source, submittedAt: queued.submittedAt });
    await rm(path);
    const result = { entry: queued.entry, state: report.passed ? 'passed' : 'failed' };
    if (!report.passed) {
      result.failed = adapters.filter(adapter => report.adapters[adapter].status !== 'passed');
      // The hook is told once. Its own failure is recorded, never retried.
      if (onFailure) try { await onFailure({ entry: queued.entry, reportPath, failed: result.failed }); result.hook = 'completed'; }
        catch (error) { result.hook = `failed: ${String(error.message).slice(0, 200)}`; }
    }
    results.push(result);
  }
  await save(join(paths.root, 'status.json'), { version: 1, updatedAt: now().toISOString(), results,
    queued: (await names(paths.queue)).length, reported: (await names(paths.reports)).length });
  return results;
}

/** What one adapter result must keep: its outcome and the exact vendor file. */
const fingerprint = result => result?.status === 'passed'
  ? `passed ${result.asset} ${result.sourceSHA256}${result.consumer ? ` ${result.consumer.asset} ${result.consumer.sourceSHA256}` : ''}` : 'failed';

/** Every entry that passed must pass again with the same vendor files. An
 * entry that failed is listed with its current result; it may now pass.
 */
export async function regress(paths, { check = checkPublishedEntry, rustChecker } = {}) {
  const rows = [];
  for (const name of await names(paths.reports)) {
    const saved = await json(join(paths.reports, name)), current = await check({ entry: saved.entry, store: paths.store, ...(rustChecker ? { rustChecker } : {}) });
    const engines = { baselineEngine: saved.engine ?? 'javascript-legacy', currentEngine: current.engine ?? 'javascript-legacy' };
    if (current.unavailable) { rows.push({ entry: saved.entry, ...engines, state: 'unavailable', reason: current.unavailable }); continue; }
    const changed = adapters.filter(adapter => saved.adapters[adapter].status === 'passed'
      && fingerprint(saved.adapters[adapter]) !== fingerprint(current.adapters[adapter]));
    rows.push({ entry: saved.entry, ...engines, state: changed.length ? 'regressed' : current.passed ? 'passed' : 'failed', wasPassing: saved.passed,
      ...(changed.length ? { changed } : {}),
      ...(current.passed ? {} : { failed: adapters.filter(adapter => current.adapters[adapter].status !== 'passed') }) });
  }
  return { rows, ok: rows.every(row => row.state === 'passed' || row.state === 'failed' && !row.wasPassing) };
}

/** One row per entry, oldest first, with each source's delay behind the first. */
export async function sightings(paths) {
  const rows = [];
  for (const name of await names(paths.sightings)) {
    const { entry, sources } = await json(join(paths.sightings, name));
    const first = Math.min(...Object.values(sources).map(time => Date.parse(time)));
    rows.push({ entry, firstSeenAt: new Date(first).toISOString(),
      sources: Object.fromEntries(Object.entries(sources).map(([source, time]) => [source, { at: time, delayMinutes: Math.round((Date.parse(time) - first) / 60000) }])) });
  }
  return rows.sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
}

async function main(argv) {
  const [command, ...rest] = argv, options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--state', '--entry', '--source', '--rust-checker'].includes(rest[i]) || !rest[i + 1]) throw new Error(usage);
    options[rest[i].slice(2)] = rest[i + 1];
  }
  if (!options.state || !['submit', 'run', 'regress', 'sightings'].includes(command)) throw new Error(usage);
  const paths = await openState(options.state);
  if (command === 'submit') return { exit: 0, output: await submit(paths, options) };
  if (command === 'sightings') return { exit: 0, output: await sightings(paths) };
  if (command === 'regress') { const result = await regress(paths, { rustChecker: options['rust-checker'] }); return { exit: result.ok ? 0 : 1, output: result }; }
  // An executable named here is started once per failed entry with the entry
  // name and its report path. It decides how to notify or draft a repair.
  const hook = process.env.CLAUDEX_FRONTEND_ON_FAILURE;
  const results = await runQueue(paths, { rustChecker: options['rust-checker'], onFailure: hook
    ? ({ entry, reportPath }) => run(hook, [entry, reportPath], { maxBuffer: 1024 * 1024 }) : undefined });
  return { exit: results.some(result => result.state === 'unavailable') ? 2 : 0, output: results };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const { exit, output } = await main(process.argv.slice(2));
    process.stdout.write(JSON.stringify(output, null, 2) + '\n'); process.exitCode = exit;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 64; }
}
