#!/usr/bin/env node
// Static synthetic graphs exercise each supported compiler/selection form.
// The copied-cache verifier uses only Rust; Acorn independently checks its output.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { frontendBuild, writeFrontend } from '../test/fixtures/claude-frontend.mjs';

const [checker, reportPath] = process.argv.slice(2);
assert.ok(checker && isAbsolute(checker) && (!reportPath || isAbsolute(reportPath)),
  'Usage: node dev/verify-rust-frontend-fixtures.mjs /abs/frontend-check [/abs/report.json]');
const temporary = await mkdtemp(join(tmpdir(), 'claudex-rust-frontend-fixtures-'));
const run = promisify(execFile), results = [];
const verifier = fileURLToPath(new URL('./verify-claude-frontend-builds.mjs', import.meta.url));
const cases = { compiler: {}, variants: { variants: true }, shared: { shared: true },
  moved: { moved: true }, competingActions: { moved: 'duplicate' },
  split: { split: true }, helpers: { helpers: true }, splitHelpers: { split: true, helpers: true },
  ambiguousHelper: { helpers: 'ambiguous' } };
try {
  for (const [name, options] of Object.entries(cases)) {
    const base = join(temporary, name), home = join(base, 'home'), root = join(base, 'state'), report = join(base, 'report.json');
    await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(root, { mode: 0o700 });
    await writeFrontend(home, frontendBuild('fixture', 11, options));
    let failure;
    try { await run(process.execPath, [verifier, '--home', home, '--root', root, '--report', report,
      '--rust-checker', checker, '--rust-only', 'true'], { timeout: 180000, maxBuffer: 65536 }); }
    catch (error) { failure = error.message; }
    const value = JSON.parse(await readFile(report, 'utf8'));
    const expectedRefusal = name === 'competingActions' ? 'chatWake' : name === 'ambiguousHelper' ? 'ownerWake' : null;
    const actual = value.builds[0]?.adapters;
    const accepted = expectedRefusal ? !value.fatal && !value.builds[0]?.discovery
      && Object.entries(actual ?? {}).every(([adapter, result]) => result.status === (adapter === expectedRefusal ? 'failed' : 'passed'))
      && actual[expectedRefusal]?.phase === 'selection' : value.passed;
    const row = { fixture: name, passed: accepted, ...(expectedRefusal ? { expectedRefusal } : {}), adapters: actual, ...(value.fatal ? { fatal: value.fatal } : {}) };
    results.push(row); process.stderr.write(`${name}: ${accepted ? 'passed' : 'failed'}\n`);
    if (failure && value.passed) throw new Error(failure);
  }
} finally { await rm(temporary, { recursive: true }); }
const report = { syntheticOnly: true, nativeInference: false, passed: results.every(row => row.passed), results };
if (reportPath) { await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 }); await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.passed ? 0 : 1;
