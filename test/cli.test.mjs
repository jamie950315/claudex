import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, appendFile } from 'node:fs/promises';
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

test('native watcher discovers only the selected project and mirrors the next completed turn', { skip: process.env.CLAUDEX_NATIVE_TEST !== '1', timeout: 20000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-watch-test-')));
  const stateRoot = join(root, 'state'); const cwd = join(root, 'project'); const other = join(root, 'other');
  const codexHome = join(root, 'codex'); const claudeHome = join(root, 'claude');
  await Promise.all([codexHome, claudeHome, cwd, other].map(path => mkdir(path)));
  execFileSync(process.execPath, [cli, 'init', '--root', stateRoot, '--codex-home', codexHome, '--claude-home', claudeHome, '--project', cwd]);
  const common = number => ({ meta: { id: '', cwd, timestamp: new Date().toISOString() }, messages: [
    { role: 'user', content: [{ type: 'text', text: `Watch question ${number}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `Watch answer ${number}` }] },
  ] });
  await createClaudeSession({ claudeHome, common: common(1) });
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
  const first = await until(state => !state.pending && state.records.some(record => record.side === 'codex'));
  assert.equal(Object.keys(first.conversations).length, 1);
  const codex = first.records.find(record => record.side === 'codex');
  // Synthetic closed turn; this test never requests model execution.
  const rows = encodeCodexProjection(common(2), codex.nativeId).trim().split('\n').map(JSON.parse).filter(row => row.type !== 'session_meta');
  const turn = randomUUID();
  for (const row of rows) if (row.payload?.turn_id) row.payload.turn_id = turn;
  await appendFile(codex.path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const second = await until(state => !state.pending && state.records.some(record => record.side === 'claude' && record.managed && record.messageCount === 4));
  assert.equal(Object.keys(second.conversations).length, 1);
  assert.equal(second.records.filter(record => record.managed).length, 2);
  t.diagnostic(`Watcher evidence: ${root}`);
});
