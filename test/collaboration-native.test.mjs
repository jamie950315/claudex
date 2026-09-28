import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createNativeCollaborationRunner } from '../src/collaboration-native.mjs';

function fakeSpawn(events, exitCode = 0, stderr = '') {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 42;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => { child.emit('close', null, signal); return true; };
    let input = '';
    child.stdin.on('data', (chunk) => { input += chunk.toString(); });
    child.stdin.on('finish', () => {
      calls.push({ command, args, options, input });
      queueMicrotask(() => {
        if (stderr) child.stderr.write(stderr);
        for (const event of events) child.stdout.write(`${JSON.stringify(event)}\n`);
        child.stdout.end();
        child.emit('close', exitCode, null);
      });
    });
    return child;
  };
  return { spawnImpl, calls };
}

function runner(fake) {
  return createNativeCollaborationRunner({ spawnImpl: fake.spawnImpl, groupAliveImpl: () => false,
    signalGroupImpl: () => {} });
}

test('Codex uses an ephemeral sandboxed CLI session with only the requested MCP server', async () => {
  const fake = fakeSpawn([
    { type: 'thread.started', thread_id: 'codex-session' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
    { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 1 } },
  ]);
  const events = [];
  const run = runner(fake);
  const result = await run({ provider: 'codex', cwd: process.cwd(), prompt: 'Review this.',
    mcp: { command: '/usr/bin/node', args: ['server.mjs'], env: { CLAUDEX_WORK_TOKEN: 'private' } },
    onEvent: (event) => events.push(event.type) });
  assert.deepEqual(result, { text: 'Done.', sessionId: 'codex-session', usage: { input_tokens: 3, output_tokens: 1 } });
  assert.deepEqual(events, ['spawn', 'session', 'thread.started', 'item.completed', 'turn.completed']);
  const call = fake.calls[0];
  assert.equal(call.command, 'codex');
  assert.equal(call.input, 'Review this.');
  assert.ok(call.args.includes('--ephemeral'));
  assert.ok(call.args.includes('--ignore-user-config'));
  assert.ok(call.args.includes('--skip-git-repo-check'));
  assert.ok(!call.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(call.args.includes('read-only'));
  assert.ok(call.args.some((arg) => arg.includes('mcp_servers.claudex.required=true')));
  assert.ok(!call.args.join(' ').includes('private'));
  assert.equal(call.options.env.CLAUDEX_WORK_TOKEN, 'private');
  assert.equal(call.options.env.OPENAI_API_KEY, undefined);
  assert.equal(call.options.env.CODEX_API_KEY, undefined);
});

test('only an exact no-output pre-execution Git refusal is a known startup failure', async () => {
  const refusal = 'Not inside a trusted directory and --skip-git-repo-check was not specified.\n';
  for (const [events, stderr, uncertain] of [
    [[], refusal, false],
    [[], 'Unknown native failure containing private data', true],
    [[{ type: 'thread.started', thread_id: 'started-session' }], refusal, true],
    [[], 'x'.repeat(4097) + refusal, true],
  ]) {
    const fake = fakeSpawn(events, 1, stderr);
    await assert.rejects(runner(fake)({ provider: 'codex', cwd: process.cwd(), prompt: 'Check.' }), error => {
      assert.equal(error.executionUncertain, uncertain);
      assert.ok(!error.message.includes('private data'));
      if (!uncertain) assert.match(error.message, /before execution/);
      return true;
    });
    assert.equal(fake.calls.length, 1);
  }
});

test('selected models reach the native CLI unchanged and native defaults omit the flag', async () => {
  for (const provider of ['codex', 'claude']) {
    for (const model of [null, `${provider}-selected-model`]) {
      const fake = fakeSpawn(provider === 'codex'
        ? [{ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }, { type: 'turn.completed' }]
        : [{ type: 'result', is_error: false, result: 'ok' }]);
      await runner(fake)({ provider, cwd: process.cwd(), prompt: 'Check model routing.', model });
      const args = fake.calls[0].args;
      if (model === null) assert.equal(args.includes('--model'), false);
      else assert.equal(args[args.indexOf('--model') + 1], model);
      assert.ok(!args.includes('--dangerously-skip-permissions'));
      assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
    }
  }
});

test('Claude uses nonpersistent restricted CLI with bounded file tools and explicit MCP', async () => {
  const fake = fakeSpawn([
    { type: 'system', subtype: 'init', session_id: 'claude-session' },
    { type: 'result', is_error: false, result: 'Implemented.', usage: { input_tokens: 5 } },
  ]);
  const run = runner(fake);
  const result = await run({ provider: 'claude', cwd: process.cwd(), prompt: 'Implement it.',
    permission: 'workspace-write', mcp: { command: '/usr/bin/node', args: ['server.mjs'] } });
  assert.deepEqual(result, { text: 'Implemented.', sessionId: 'claude-session', usage: { input_tokens: 5 } });
  const call = fake.calls[0];
  assert.equal(call.command, 'claude');
  assert.equal(call.input, 'Implement it.');
  assert.ok(call.args.includes('--no-session-persistence'));
  assert.ok(call.args.includes('--restricted'));
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.ok(call.args.includes('Read,Glob,Grep,Edit,Write'));
  assert.ok(!call.args.includes('Bash'));
  assert.ok(call.args.includes('--session-id'));
  assert.ok(!call.args.join(' ').includes('Implement it.'));
  assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(call.options.env.CLAUDE_CONFIG_DIR, undefined);
});

test('terminal native failure is known and is never retried; confirmed cancellation is known', async () => {
  const fake = fakeSpawn([{ type: 'turn.failed' }], 1);
  const run = runner(fake);
  await assert.rejects(run({ provider: 'codex', cwd: process.cwd(), prompt: 'Check.' }),
    (error) => error.executionUncertain === false);
  assert.equal(fake.calls.length, 1);

  const controller = new AbortController();
  const hanging = fakeSpawn([]);
  hanging.spawnImpl = () => {
    const child = new EventEmitter();
    hanging.child = child;
    child.pid = 44;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = (signal) => { queueMicrotask(() => child.emit('close', null, signal)); return true; };
    queueMicrotask(() => controller.abort());
    return child;
  };
  await assert.rejects(createNativeCollaborationRunner({ spawnImpl: hanging.spawnImpl,
    groupAliveImpl: () => false, signalGroupImpl: () => queueMicrotask(() => hanging.child.emit('close', null, 'SIGTERM')) })({
    provider: 'claude', cwd: process.cwd(), prompt: 'Check.', signal: controller.signal,
  }), (error) => error.executionUncertain === false);
});

test('Codex diagnostic errors do not override a completed turn', async () => {
  const fake = fakeSpawn([
    { type: 'thread.started', thread_id: 'session' },
    { type: 'error', message: 'A recoverable tool issue.' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Recovered.' } },
    { type: 'turn.completed' },
  ]);
  assert.equal((await runner(fake)({ provider: 'codex', cwd: process.cwd(), prompt: 'Check.' })).text, 'Recovered.');
});

test('Claude explicit result error is known; missing receipt remains uncertain', async () => {
  const failed = fakeSpawn([{ type: 'result', is_error: true, result: 'Could not proceed.' }], 1);
  await assert.rejects(runner(failed)({ provider: 'claude', cwd: process.cwd(), prompt: 'Check.' }),
    (error) => error.executionUncertain === false);
  const absent = fakeSpawn([{ type: 'system', subtype: 'init', session_id: 'session' }], 1);
  await assert.rejects(runner(absent)({ provider: 'claude', cwd: process.cwd(), prompt: 'Check.' }),
    (error) => error.executionUncertain === true);
});

test('invalid requests do not launch a model', async () => {
  let launches = 0;
  const run = createNativeCollaborationRunner({ spawnImpl: () => { launches++; throw new Error('launched'); },
    groupAliveImpl: () => false });
  await assert.rejects(run({ provider: 'unknown', cwd: process.cwd(), prompt: 'x' }));
  await assert.rejects(run({ provider: 'codex', cwd: process.cwd(), prompt: 'x', permission: 'unsafe' }));
  await assert.rejects(run({ provider: 'codex', cwd: process.cwd(), prompt: 'x', mcp: { command: 'node', env: { 'BAD-NAME': 'x' } } }));
  await assert.rejects(run({ provider: 'codex', cwd: process.cwd(), prompt: 'x', mcp: { command: 'node', env: { OPENAI_API_KEY: 'x' } } }));
  assert.equal(launches, 0);
});

test('spawn receipt is awaited before sending the prompt', async () => {
  const fake = fakeSpawn([
    { type: 'thread.started', thread_id: 'session' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Ready.' } },
    { type: 'turn.completed' },
  ]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let sawSpawn;
  const spawnSeen = new Promise((resolve) => { sawSpawn = resolve; });
  const seen = [];
  const work = runner(fake)({ provider: 'codex', cwd: process.cwd(), prompt: 'Do work.',
    onEvent: async (event) => {
      seen.push(event.type);
      if (event.type === 'spawn') { sawSpawn(); await gate; }
    } });
  await spawnSeen;
  assert.deepEqual(seen, ['spawn']);
  assert.equal(fake.calls.length, 0);
  release();
  assert.equal((await work).text, 'Ready.');
  assert.deepEqual(seen, ['spawn', 'session', 'thread.started', 'item.completed', 'turn.completed']);
});

test('rejected spawn receipt stops the owned process before any prompt is sent', async () => {
  const fake = fakeSpawn([]);
  const spawnImpl = (...args) => {
    fake.child = fake.spawnImpl(...args);
    return fake.child;
  };
  const run = createNativeCollaborationRunner({ spawnImpl, groupAliveImpl: () => false,
    signalGroupImpl: () => queueMicrotask(() => fake.child.emit('close', null, 'SIGTERM')) });
  await assert.rejects(run({ provider: 'codex', cwd: process.cwd(), prompt: 'Do not send.',
    onEvent: async () => { throw new Error('Ledger unavailable'); } }),
  (error) => error.executionUncertain === true);
  assert.equal(fake.calls.length, 0);
});

test('early native exit during an asynchronous spawn receipt never sends input', async () => {
  const fake = fakeSpawn([]);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let sawSpawn;
  const spawnSeen = new Promise((resolve) => { sawSpawn = resolve; });
  const spawnImpl = (...args) => {
    fake.child = fake.spawnImpl(...args);
    queueMicrotask(() => fake.child.emit('close', 1, null));
    return fake.child;
  };
  const run = createNativeCollaborationRunner({ spawnImpl, groupAliveImpl: () => false,
    signalGroupImpl: () => {} });
  const work = run({ provider: 'codex', cwd: process.cwd(), prompt: 'Do not send.',
    onEvent: async (event) => { if (event.type === 'spawn') { sawSpawn(); await gate; } } });
  await spawnSeen;
  release();
  await assert.rejects(work, (error) => error.executionUncertain === true);
  assert.equal(fake.calls.length, 0);
});
