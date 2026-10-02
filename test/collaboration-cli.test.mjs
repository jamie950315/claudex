import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { callCollaboration } from '../src/collaboration-transport.mjs';

const cli = fileURLToPath(new URL('../bin/claudex.mjs', import.meta.url));

test('standalone collaboration CLI executes through a filesystem alias', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-cli-alias-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = fileURLToPath(new URL('../bin/claudex-collaboration.mjs', import.meta.url));
  const alias = join(root, 'collaboration.mjs');
  await symlink(target, alias);
  const { stdout } = await promisify(execFile)(process.execPath, [alias, '--help']);
  assert.match(stdout, /^Claudex collaboration: one work protocol/);
});

test('real broker process serves both MCP peers without starting inference or requiring sync initialization', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-cli-'));
  const broker = spawn(process.execPath, [cli, 'collaboration', 'serve', '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  broker.stderr.on('data', chunk => { diagnostics += chunk; });
  const exited = once(broker, 'exit');
  t.after(async () => {
    if (broker.exitCode === null && broker.signalCode === null) broker.kill('SIGTERM');
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  let token, initial;
  for (let i = 0; i < 200; i++) {
    try {
      token = (await readFile(join(root, 'controller-key'), 'utf8')).trim();
      initial = await callCollaboration({ root, token, peer: 'codex', method: 'list' });
      break;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      assert.equal(broker.exitCode, null, diagnostics);
      await delay(10);
    }
  }
  assert.deepEqual(initial?.tasks, []);
  assert.equal(initial.limits.allowWrite, false);
  assert.equal(initial.limits.maxWorkers, 64);
  assert.equal(initial.limits.maxDepth, 3);
  const execute = promisify(execFile);
  const modelArgs = [cli, 'collaboration', 'models', '--root', root];
  const readModels = await execute(process.execPath, modelArgs);
  assert.deepEqual(JSON.parse(readModels.stdout), { defaultModels: { codex: null, claude: null }, defaultEfforts: { codex: null, claude: null }, defaultPermission: 'read-only' });
  const saved = await execute(process.execPath, [...modelArgs, '--codex-model', 'test-codex', '--claude-model', '']);
  assert.deepEqual(JSON.parse(saved.stdout), { defaultModels: { codex: 'test-codex', claude: null }, defaultEfforts: { codex: null, claude: null }, defaultPermission: 'read-only' });
  const efforts = await execute(process.execPath, [...modelArgs, '--codex-effort', 'high', '--claude-effort', 'low']);
  assert.deepEqual(JSON.parse(efforts.stdout), { defaultModels: { codex: 'test-codex', claude: null }, defaultEfforts: { codex: 'high', claude: 'low' }, defaultPermission: 'read-only' });
  await assert.rejects(execute(process.execPath, [...modelArgs, '--codex-effort', 'high']), /Both provider effort/);
  await assert.rejects(execute(process.execPath, [...modelArgs, '--codex-effort', 'high', '--claude-effort', 'ultra']), /effort/i);
  await assert.rejects(execute(process.execPath, [...modelArgs, '--codex-model', 'partial']), /Both provider/);
  const appCli = fileURLToPath(new URL('../bin/claudex-app.mjs', import.meta.url));
  // The app takes a sync root and uses its collaboration child directory.
  const appRoot = await mkdtemp(join(tmpdir(), 'cldx-model-app-'));
  t.after(() => rm(appRoot, { recursive: true, force: true }));
  const unavailable = await execute(process.execPath, [appCli, 'models', '--root', appRoot]).catch(error => error);
  assert.equal(typeof JSON.parse(unavailable.stdout).error, 'string');
  assert.ok(unavailable.code);
  for (const peer of ['codex', 'claude']) {
    const client = spawn(process.execPath, [cli, 'collaboration', 'mcp', '--root', root, '--peer', peer], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDEX_WORK_TOKEN: token },
    });
    let output = ''; let errors = '';
    client.stdout.on('data', chunk => { output += chunk; });
    client.stderr.on('data', chunk => { errors += chunk; });
    const closed = once(client, 'close');
    client.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'claudex_list', arguments: {} } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    const [code] = await closed;
    assert.equal(code, 0, errors);
    const replies = output.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(replies.find(reply => reply.id === 2).result.tools.length, 11);
    assert.deepEqual(JSON.parse(replies.find(reply => reply.id === 3).result.content[0].text).tasks, []);
    assert.equal(output.includes(token), false);
  }
  assert.equal(diagnostics, '');
});
