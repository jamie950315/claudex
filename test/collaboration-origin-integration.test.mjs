import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { createOriginVerifier } from '../src/collaboration-origin.mjs';
import { serveCollaborationSocket, runCollaborationMcp } from '../src/collaboration-transport.mjs';
import { sessionPath } from '../src/claude.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const TURN = 'native-turn-1';
const TOOL = 'native-tool-1';
const hookPath = fileURLToPath(new URL('../bin/claudex-sync-hook.mjs', import.meta.url));

async function until(check) {
  for (let attempt = 0; attempt < 400; attempt++) { if (await check()) return; await delay(5); }
  throw new Error('Integrated synthetic origin flow did not settle.');
}

async function mcpStart(root, token, peer, args) {
  const input = new PassThrough(), output = new PassThrough(); let wire = '';
  output.on('data', bytes => { wire += bytes; });
  const running = runCollaborationMcp({ root, peer, token, input, output });
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'claudex_start', arguments: args } }) + '\n');
  await running;
  const response = JSON.parse(wire.trim());
  assert.equal(response.error, undefined);
  assert.notEqual(response.result?.isError, true);
  return response.result;
}

async function fixture(t, provider) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'coi-')));
  await chmod(parent, 0o700);
  const root = join(parent, 'collaboration'), claudeHome = join(parent, 'claude'), registryRoot = join(parent, 'registry');
  await mkdir(root, { mode: 0o700 });
  let nativeReady = false, nativeResult, nativeArguments, nativeReads = 0, syntheticInvocations = 0;
  const methods = [];
  const transcript = sessionPath(claudeHome, parent, ID);
  if (provider === 'claude') {
    const record = join(registryRoot, 'account', 'organization', `local_${ID}.json`);
    await mkdir(dirname(record), { recursive: true, mode: 0o700 });
    await writeFile(record, JSON.stringify({ sessionId: `local_${ID}`, cliSessionId: ID, cwd: parent,
      title: 'Synthetic native origin', lastActivityAt: Date.now(), isArchived: false }), { mode: 0o600 });
    await mkdir(dirname(transcript), { recursive: true, mode: 0o700 });
    await writeFile(transcript, '\n', { mode: 0o600 });
  }
  const verifier = createOriginVerifier({ syncRoot: parent, claudeHome, registryRoot,
    clientFactory: () => ({ initialize: async () => {}, close: async () => {}, request: async (method, args) => {
      nativeReads++;
      if (method === 'thread/read') {
        assert.deepEqual(args, { threadId: ID, includeTurns: false });
        return { thread: { id: ID, sessionId: ID, cwd: parent, parentThreadId: null,
          ephemeral: false, source: 'vscode', threadSource: 'user' } };
      }
      assert.equal(method, 'thread/items/list'); assert.equal(args.turnId, TURN);
      return { data: nativeReady ? [{ turnId: TURN, item: { type: 'mcpToolCall', id: TOOL,
        server: 'claudex-work', tool: 'claudex_start', status: 'completed', arguments: nativeArguments,
        error: null, result: { content: nativeResult.content, structuredContent: null } } }] : [], nextCursor: null };
    } }),
  });
  const hub = await new CollaborationHub({ root, originVerifier: verifier, run: async () => {
    syntheticInvocations++; return { text: 'Synthetic task completed; no native inference.' };
  } }).initialize();
  hub.schedule = () => {};
  const server = await serveCollaborationSocket({ root, dispatch: envelope => {
    methods.push(envelope.method); return hub.dispatch(envelope);
  } });
  t.after(async () => { await server.close(); await hub.close(); await rm(parent, { recursive: true, force: true }); });
  const hook = event => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath, '--root', parent, '--provider', provider], {
      env: { ...process.env, CLAUDEX_COLLABORATION_WORKER: '' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ session_id: ID, cwd: parent, ...event }));
  });
  const publishNativeResult = async (args, result) => {
    nativeArguments = args; nativeResult = result; nativeReady = true;
    if (provider !== 'claude') return;
    const rows = [
      { type: 'assistant', uuid: 'native-assistant', parentUuid: null, sessionId: ID, cwd: parent,
        isSidechain: false, version: '2.1.281', message: { role: 'assistant', content: [{ type: 'tool_use',
          id: TOOL, name: 'mcp__claudex-work__claudex_start', input: args }] } },
      { type: 'user', uuid: 'native-result', parentUuid: 'native-assistant', sourceToolAssistantUUID: 'native-assistant',
        sessionId: ID, cwd: parent, isSidechain: false, version: '2.1.281', message: { role: 'user',
          content: [{ type: 'tool_result', tool_use_id: TOOL, content: result.content }] } },
    ];
    await writeFile(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  };
  return { parent, root, hub, hook, methods, publishNativeResult,
    nativeReads: () => nativeReads, syntheticInvocations: () => syntheticInvocations };
}

for (const provider of ['codex', 'claude']) for (const deferred of [false, true]) {
  test(`${provider} MCP start -> native ${deferred ? 'late flush -> lifecycle recheck' : 'proof'} -> exact queue-only notification`, async t => {
    const f = await fixture(t, provider);
    assert.deepEqual(await f.hook({ hook_event_name: 'SessionStart' }), { code: 0, stdout: '', stderr: '' });
    const args = { provider: provider === 'codex' ? 'claude' : 'codex', cwd: f.parent,
      prompt: 'Private synthetic prompt must not enter notification evidence.', requestId: `integrated-${provider}-${deferred}`,
      notifications: { mode: 'queue' } };
    const nativeResult = await mcpStart(f.root, f.hub.controllerToken, provider, args);
    const receipt = JSON.parse(nativeResult.content[0].text);
    assert.match(receipt.originChallenge, /^[a-f0-9]{64}$/);
    assert.equal(f.syntheticInvocations(), 0);
    if (!deferred) await f.publishNativeResult(args, nativeResult);
    const event = { hook_event_name: 'PostToolUse', tool_name: 'mcp__claudex-work__claudex_start',
      tool_use_id: TOOL, tool_input: args, tool_response: nativeResult,
      ...(provider === 'codex' ? { turn_id: TURN } : {}) };
    assert.deepEqual(await f.hook(event), { code: 0, stdout: '', stderr: '' });
    if (deferred) {
      const pending = f.hub.state.tasks[receipt.taskId].notification;
      assert.equal(pending.origin, null); assert.equal(pending.originHint.attempts, 1);
      assert.equal(pending.deliveries.length, 0);
      assert.doesNotMatch(JSON.stringify(pending.originHint), /Private synthetic prompt|originChallenge/);
      await f.publishNativeResult(args, nativeResult);
      assert.deepEqual(await f.hook({ hook_event_name: 'Stop' }), { code: 0, stdout: '', stderr: '' });
    }
    const notification = f.hub.state.tasks[receipt.taskId].notification;
    assert.equal(notification.origin.provider, provider);
    assert.equal(notification.origin.sessionId, ID);
    assert.equal(notification.origin.source, `${provider}-native-mcp-result`);
    assert.equal(notification.originHint, undefined);
    assert.doesNotMatch(JSON.stringify(notification.origin), /Private synthetic prompt|originChallenge/);
    if (provider === 'codex') assert.ok(f.nativeReads() >= (deferred ? 5 : 3));
    await f.hub.pump();
    await until(() => f.hub.state.tasks[receipt.taskId].status === 'completed'
      && f.hub.state.tasks[receipt.taskId].notification.deliveries[0]?.state === 'queued');
    assert.equal(f.syntheticInvocations(), 1);
    const delivered = f.hub.state.tasks[receipt.taskId].notification.deliveries;
    assert.equal(delivered.length, 1);
    const message = await f.hub.chatMailbox.status(delivered[0].messageId);
    assert.equal(message.targetSessionId, ID); assert.equal(message.targetProvider, provider);
    assert.equal(message.wakeRequested, false); assert.equal(message.state, 'queued');
    assert.match(message.message, new RegExp(receipt.taskId));
    assert.doesNotMatch(message.message, /Private synthetic prompt|originChallenge/);
    assert.equal(f.methods.filter(method => method === 'start').length, 1);
    assert.equal(f.methods.filter(method => method === 'origin_bind').length, 1);
    assert.equal(f.methods.filter(method => method === 'origin_recheck').length, deferred ? 2 : 1);
    // Replaying the MCP request recovers its receipt; it cannot invoke a second
    // task or make the native hook bind/notify again.
    const replay = await mcpStart(f.root, f.hub.controllerToken, provider, args);
    assert.equal(JSON.parse(replay.content[0].text).replayed, true);
    assert.deepEqual(await f.hook({ ...event, tool_response: replay }), { code: 0, stdout: '', stderr: '' });
    assert.equal(f.methods.filter(method => method === 'origin_bind').length, 1);
    assert.equal(f.hub.state.tasks[receipt.taskId].notification.deliveries.length, 1);
    assert.equal(f.syntheticInvocations(), 1);
  });
}
