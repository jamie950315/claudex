import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { callCollaboration } from '../src/collaboration-transport.mjs';

const cli = fileURLToPath(new URL('../bin/claudex.mjs', import.meta.url));

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
    assert.equal(replies.find(reply => reply.id === 2).result.tools.length, 7);
    assert.deepEqual(JSON.parse(replies.find(reply => reply.id === 3).result.content[0].text).tasks, []);
    assert.equal(output.includes(token), false);
  }
  assert.equal(diagnostics, '');
});
