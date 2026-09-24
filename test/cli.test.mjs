import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createClaudeSession } from '../src/claude.mjs';
import { encodeCodexProjection } from '../src/codex-projection.mjs';

const cli = resolve('bin/claudex.mjs');
test('CLI init is explicit and does not overwrite configuration; status is content-free', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-cli-test-')));
  const stateRoot = join(root, 'state');
  const codexHome = join(root, 'codex'); const claudeHome = join(root, 'claude');
  await mkdir(codexHome); await mkdir(claudeHome);
  const args = [cli, 'init', '--root', stateRoot, '--codex-home', codexHome, '--claude-home', claudeHome];
  const result = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  assert.equal(result.watching, false);
  assert.deepEqual(result.projects, []);
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }));
  const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--root', stateRoot], { encoding: 'utf8' }));
  assert.deepEqual(status.records, []);
  assert.equal(status.pending, null);
});

test('CLI all-project scope needs no repository selection', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-all-cli-test-')));
  const codexHome = join(root, 'codex'); const claudeHome = join(root, 'claude');
  await mkdir(codexHome); await mkdir(claudeHome);
  const args = [cli, 'init', '--root', join(root, 'state'), '--codex-home', codexHome, '--claude-home', claudeHome, '--all-projects'];
  const result = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  assert.equal(result.allProjects, true);
  assert.deepEqual(result.projects, []);
  const config = JSON.parse(await readFile(join(root, 'state', 'config.json'), 'utf8'));
  assert.equal(config.allProjects, true);
});

for (const allProjects of [false, true]) test(`native watcher discovers ${allProjects ? 'all projects' : 'only the selected project'} and mirrors the next completed turn`, { skip: process.env.CLAUDEX_NATIVE_TEST !== '1', timeout: 20000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-watch-test-')));
  const stateRoot = join(root, 'state'); const cwd = join(root, 'project'); const other = join(root, 'other');
  const codexHome = join(root, 'codex'); const claudeHome = join(root, 'claude');
  await Promise.all([codexHome, claudeHome, cwd, other].map(path => mkdir(path)));
  execFileSync(process.execPath, [cli, 'init', '--root', stateRoot, '--codex-home', codexHome, '--claude-home', claudeHome, ...(allProjects ? ['--all-projects'] : ['--project', cwd])]);
  const common = number => ({ meta: { id: '', cwd, timestamp: new Date().toISOString() }, messages: [
    { role: 'user', content: [{ type: 'text', text: `Watch question ${number}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `Watch answer ${number}` }] },
  ] });
  await createClaudeSession({ claudeHome, common: common(1) });
  if (allProjects) {
    await mkdir(join(codexHome, 'sessions'), { recursive: true });
    await writeFile(join(codexHome, 'sessions', 'rollout-unsupported.jsonl'), encodeCodexProjection(common(0), randomUUID()).replace('"originator":"claudex"', '"originator":"codex_cli_rs"') + JSON.stringify({ type: 'compacted', payload: {} }) + '\n');
  }
  await createClaudeSession({ claudeHome, common: { ...common(99), meta: { ...common(99).meta, cwd: other } } });
  let log = '';
  const child = spawn(process.execPath, [cli, 'watch', '--root', stateRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { log = (log + chunk).slice(-10000); });
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-10000); });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  });
  async function until(predicate) {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      if (child.exitCode !== null) throw new Error(`Watcher exited: ${log}`);
      let state;
      try { state = JSON.parse(await readFile(join(stateRoot, 'state.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (state && predicate(state)) return state;
      await delay(50);
    }
    throw new Error(`Watcher timed out: ${log}`);
  }
  const expected = allProjects ? 2 : 1;
  const first = await until(state => !state.pending && state.records.filter(record => record.side === 'codex').length === expected);
  assert.equal(Object.keys(first.conversations).length, expected);
  const codex = first.records.find(record => record.side === 'codex' && record.cwd === cwd);
  // Synthetic closed turn; this test never requests model execution.
  const rows = encodeCodexProjection(common(2), codex.nativeId).trim().split('\n').map(JSON.parse).filter(row => row.type !== 'session_meta');
  const turn = randomUUID();
  for (const row of rows) if (row.payload?.turn_id) row.payload.turn_id = turn;
  await appendFile(codex.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const second = await until(state => !state.pending && state.records.some(record => record.side === 'claude' && record.managed && record.messageCount === 4));
  assert.equal(Object.keys(second.conversations).length, expected);
  assert.equal(second.records.filter(record => record.managed).length, expected + 1);
  if (allProjects) {
    const watcher = JSON.parse(await readFile(join(stateRoot, 'watcher-status.json'), 'utf8'));
    assert.equal(watcher.running, true);
    assert.equal(watcher.blockedSourceCount, 1);
    assert.match(watcher.blockedSources[0].reason, /Compacted/);
  }
  t.diagnostic(`Watcher evidence: ${root}`);
});
