import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { runCollaborationMcp, serveCollaborationSocket } from '../src/collaboration-transport.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cldx-desktop-wake-'));
  let published = 0;
  const hub = await new CollaborationHub({ root, run: async () => { throw new Error('No model inference in this test.'); },
    claudeWakeManifest: { verify: async sessionId => { assert.equal(sessionId, 'target'); }, publish: async () => { published++; } } }).initialize();
  hub.schedule = () => {};
  t.after(() => hub.close());
  await hub.chatMailbox.register({ provider: 'claude', sessionId: 'target', cwd: root, event: 'SessionStart' });
  const send = (extra = {}) => hub.chatMailbox.send({ fromProvider: 'codex', targetProvider: 'claude', targetSessionId: 'target',
    requestId: 'wake', message: 'Please report current progress.', wakeRequested: true, ...extra });
  const request = (method, params, peer = 'claude', token = hub.controllerToken) => hub.dispatch({ peer, token, method, params });
  return { root, hub, send, request, published: () => published };
}

test('Desktop broker checks provider, exact recipient, opt-in and controller capability', async t => {
  const { root, hub, send, request } = await fixture(t);
  const sent = await send();
  const params = { messageId: sent.messageId, sessionId: 'target' };
  await assert.rejects(request('desktop_wake_claim', params, 'codex'), /unavailable/);
  await assert.rejects(request('desktop_wake_claim', { ...params, sessionId: 'wrong' }), /identity/);
  const noWake = await send({ requestId: 'passive', wakeRequested: false });
  await assert.rejects(request('desktop_wake_claim', { ...params, messageId: noWake.messageId }), /authorization/);
  await hub.chatMailbox.register({ provider: 'codex', sessionId: 'codex-target', cwd: root, event: 'SessionStart' });
  const codex = await send({ requestId: 'codex', targetProvider: 'codex', targetSessionId: 'codex-target' });
  await assert.rejects(request('desktop_wake_claim', { messageId: codex.messageId, sessionId: 'codex-target' }), /identity/);
  const token = 'b'.repeat(64);
  await hub.mutate(state => { state.tasks.synthetic = { id: 'synthetic', owner: 'claude', status: 'running', active: { generation: 1,
    tokenHash: createHash('sha256').update(token).digest('hex') } }; });
  await assert.rejects(request('desktop_wake_claim', params, 'claude', token), /unavailable/);
  assert.equal((await hub.chatMailbox.status(sent.messageId)).state, 'queued');
});

test('Desktop claim is single-use and receipt requires its exact claim without acknowledging', async t => {
  const { hub, send, request, published } = await fixture(t);
  const sent = await send();
  const params = { messageId: sent.messageId, sessionId: 'target' };
  const claim = await request('desktop_wake_claim', params);
  assert.equal(claim.claimed, true);
  assert.match(claim.context, /peer/i);
  assert.deepEqual(await request('desktop_wake_claim', params), { claimed: false });
  await assert.rejects(request('desktop_wake_receipt', { ...params, claimId: 'wrong', status: 'accepted', detail: 'wrong claim' }), /no longer current/);
  await assert.rejects(request('desktop_wake_receipt', { ...params, claimId: claim.claimId, status: 'deferred', detail: 'not allowed' }), /Invalid Desktop/);
  const receipt = await request('desktop_wake_receipt', { ...params, claimId: claim.claimId, status: 'accepted', detail: 'Native renderer accepted.' });
  assert.equal(receipt.state, 'offered');
  assert.equal(receipt.acknowledgedAt, undefined);
  assert.equal(published(), 1);
  assert.equal((await hub.chatMailbox.consume({ provider: 'claude', sessionId: 'target', event: 'Stop' })).message, undefined);
  await assert.rejects(request('desktop_wake_receipt', { ...params, claimId: claim.claimId, status: 'accepted', detail: 'duplicate' }), /no longer current/);
});

test('Desktop MCP exposes only narrow wake tools and refuses arbitrary work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-desktop-mcp-'));
  const seen = [];
  const socket = await serveCollaborationSocket({ root, dispatch: async request => { seen.push(request); return { accepted: true }; } });
  t.after(() => socket.close());
  const input = new PassThrough(), output = new PassThrough();
  let contents = ''; output.on('data', chunk => { contents += chunk; });
  const running = runCollaborationMcp({ root, peer: 'claude', token: 'controller', desktopWakeOnly: true, input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }) + '\n');
  for (const [id, name, args] of [
    ['owner', 'claudex_desktop_owner_wake', { remoteId: 'cse_target' }],
    ['bad-owner', 'claudex_desktop_owner_wake', { remoteId: 'arbitrary' }],
    ['content', 'claudex_desktop_owner_wake', { remoteId: 'cse_target', message: 'not permitted' }],
    ['claim', 'claudex_desktop_wake_claim', { messageId: 'message', sessionId: 'target' }],
    ['receipt', 'claudex_desktop_wake_receipt', { messageId: 'message', sessionId: 'target', claimId: 'claim', status: 'accepted', detail: 'accepted' }],
    ['work', 'claudex_start', { provider: 'codex', cwd: root, prompt: 'not permitted', requestId: 'start' }],
    ['chat', 'claudex_chat_send', { message: 'not permitted', requestId: 'chat' }],
  ]) input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  input.end(); await running;
  const responses = new Map(contents.trim().split('\n').map(line => { const row = JSON.parse(line); return [row.id, row]; }));
  assert.deepEqual(responses.get('list').result.tools.map(tool => tool.name), ['claudex_desktop_owner_wake', 'claudex_desktop_wake_claim', 'claudex_desktop_wake_receipt']);
  assert.deepEqual(seen.map(request => request.method).sort(), ['desktop_owner_wake', 'desktop_wake_claim', 'desktop_wake_receipt']);
  assert.equal(responses.get('bad-owner').result.isError, true);
  assert.equal(responses.get('content').result.isError, true);
  assert.equal(responses.get('work').result.isError, true);
  assert.equal(responses.get('chat').result.isError, true);
});

test('Desktop stdio endpoint stays open through attachment and a separate replacement connection', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cldx-desktop-attach-'));
  await writeFile(join(root, 'controller-key'), 'a'.repeat(64) + '\n', { mode: 0o600 });
  const env = { ...process.env }; delete env.CLAUDEX_WORK_TOKEN; delete env.CLAUDEX_COLLABORATION_WORKER;
  for (let connection = 0; connection < 2; connection++) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/claudex-collaboration.mjs', import.meta.url)),
      'desktop-wake-mcp', '--root', root, '--peer', 'claude'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const request = async (id, method, params) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      const line = await lines.next(); assert.equal(line.done, false);
      const response = JSON.parse(line.value); assert.equal(response.id, id); return response.result;
    };
    assert.equal((await request(0, 'initialize', { protocolVersion: '2024-11-05' })).serverInfo.name, 'claudex');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    assert.equal((await request(1, 'tools/list')).tools.length, 3);
    assert.deepEqual(await request(2, 'ping'), {});
    assert.equal(child.exitCode, null);
    child.stdin.end(); assert.deepEqual(await closed, { code: 0, signal: null });
  }
});
