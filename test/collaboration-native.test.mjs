import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeCollaborationRunner, normalizeNativeUsage } from '../src/collaboration-native.mjs';

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

test('native work has no execution deadline and remains explicitly cancellable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const provider of ['codex', 'claude']) {
    let child;
    let spawned;
    const ready = new Promise(resolve => { spawned = resolve; });
    const run = createNativeCollaborationRunner({
      groupAliveImpl: () => false, signalGroupImpl: (_pid, signal) => child.emit('close', null, signal),
      spawnImpl: () => {
        child = new EventEmitter();
        child.pid = 42;
        child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = signal => { child.emit('close', null, signal); return true; };
        child.stdin.on('finish', spawned);
        return child;
      },
    });
    const controller = new AbortController();
    let settled = false;
    const work = run({ provider, cwd: process.cwd(), prompt: 'Long work', signal: controller.signal });
    work.then(() => { settled = true; }, () => { settled = true; });
    await ready;
    t.mock.timers.tick(48 * 60 * 60 * 1000);
    await Promise.resolve();
    assert.equal(settled, false, `${provider} must remain running after 48 hours`);
    const cancelled = assert.rejects(work, /cancelled/);
    controller.abort();
    await cancelled;
  }
});

test('native directory arguments preserve reference-only and explicit writable grants', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-native-scope-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [cwd, reference, extra] = ['project', 'reference', 'extra'].map(name => join(root, name));
  for (const path of [cwd, reference, extra]) await mkdir(path);
  for (const provider of ['codex', 'claude']) {
    const fake = fakeSpawn(provider === 'codex'
      ? [{ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }, { type: 'turn.completed' }]
      : [{ type: 'result', is_error: false, result: 'ok' }]);
    await runner(fake)({ provider, cwd, projectRoot: cwd, readOnlyDirs: [reference], writableDirs: [extra],
      permission: 'workspace-write', prompt: 'Scope test' });
    const args = fake.calls[0].args;
    assert.ok(args.includes(extra));
    if (provider === 'codex') {
      assert.ok(!args.includes(reference), 'reference must never be passed as an additional writable directory');
      assert.ok(args.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true'));
      assert.ok(args.includes('sandbox_workspace_write.exclude_slash_tmp=true'));
    } else {
      assert.ok(args.includes(reference));
      const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
      assert.deepEqual(settings.permissions.deny, [`Edit(/${reference})`, `Edit(/${reference}/**)`]);
      assert.ok(args.includes('--restricted'));
      assert.ok(!args.includes('Bash'));
    }
  }
  const fake = fakeSpawn([]);
  await assert.rejects(runner(fake)({ provider: 'claude', cwd, projectRoot: cwd, readOnlyDirs: [extra], writableDirs: [extra],
    permission: 'workspace-write', prompt: 'Never launch' }), /overlap/);
  assert.equal(fake.calls.length, 0);
});

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
  const { activity, ...outcome } = result;
  assert.equal(activity.models.status, 'not-reported');
  assert.deepEqual(outcome, { text: 'Done.', sessionId: 'codex-session', usage: { inputTokens: 3, cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 } });
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

test('requested effort reaches vendor arguments without changing permissions or inheriting Claude effort', async () => {
  const saved = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  process.env.CLAUDE_CODE_EFFORT_LEVEL = 'max';
  try {
    for (const provider of ['codex', 'claude']) {
      for (const effort of [null, 'low', 'high']) {
        const fake = fakeSpawn(provider === 'codex'
          ? [{ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }, { type: 'turn.completed' }]
          : [{ type: 'result', is_error: false, result: 'ok' }]);
        await runner(fake)({ provider, cwd: process.cwd(), prompt: 'Effort routing only.', effort });
        const call = fake.calls[0];
        if (provider === 'codex') {
          assert.deepEqual(call.args.filter(arg => arg.startsWith('model_reasoning_effort=')),
            effort === null ? [] : [`model_reasoning_effort=${JSON.stringify(effort)}`]);
          assert.ok(call.args.includes('read-only'));
        } else {
          assert.equal(call.options.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
          assert.equal(call.args.includes('--effort'), effort !== null);
          if (effort) assert.equal(call.args[call.args.indexOf('--effort') + 1], effort);
          assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Glob,Grep');
        }
      }
    }
    const fake = fakeSpawn([]);
    await assert.rejects(runner(fake)({ provider: 'claude', cwd: process.cwd(), prompt: 'Do not launch.', effort: 'ultra' }), /effort/i);
    await assert.rejects(runner(fake)({ provider: 'codex', cwd: process.cwd(), prompt: 'Do not launch.', effort: 'high\nother' }), /effort/i);
    assert.equal(fake.calls.length, 0);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = saved;
  }
});

test('Claude uses nonpersistent restricted CLI with bounded file tools and explicit MCP', async () => {
  const fake = fakeSpawn([
    { type: 'system', subtype: 'init', session_id: 'claude-session' },
    { type: 'result', is_error: false, result: 'Implemented.', total_cost_usd: 0.0125,
      usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 7 } },
  ]);
  const run = runner(fake);
  const result = await run({ provider: 'claude', cwd: process.cwd(), prompt: 'Implement it.',
    permission: 'workspace-write', mcp: { command: '/usr/bin/node', args: ['server.mjs'] } });
  const { activity, ...outcome } = result;
  assert.equal(activity.models.status, 'not-reported');
  assert.deepEqual(outcome, { text: 'Implemented.', sessionId: 'claude-session', usage: { inputTokens: 125,
    cacheReadInputTokens: 100, cacheWriteInputTokens: 20, outputTokens: 7, reportedCostUsd: 0.0125 } });
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

test('non-object and malformed native JSON events fail the invocation without crashing the broker', async () => {
  for (const provider of ['codex', 'claude']) for (const event of [null, [], 'event', false, {}, { type: 3 }]) {
    const fake = fakeSpawn([event]);
    await assert.rejects(runner(fake)({ provider, cwd: process.cwd(), prompt: 'Check malformed native output.' }), error => {
      assert.equal(error.executionUncertain, true);
      assert.match(error.message, /invalid event/);
      return true;
    });
    assert.equal(fake.calls.length, 1);
  }
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

test('native completion drains separately grouped descendants before returning its terminal receipt', async () => {
  const fake = fakeSpawn([{ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }, { type: 'turn.completed' }]);
  let alive = true, drained = false;
  const calls = [];
  const run = createNativeCollaborationRunner({ spawnImpl: fake.spawnImpl, groupAliveImpl: () => false,
    processTrackerFactory: async ({ onChange }) => {
      await onChange([{ pid: 42, ppid: 1, pgid: 42, uid: process.getuid(), startedAt: 'Wed Sep 30 20:00:00 2026' },
        { pid: 43, ppid: 42, pgid: 43, uid: process.getuid(), startedAt: 'Wed Sep 30 20:00:00 2026' }]);
      return { refresh: async () => calls.push('capture'), stopped: async () => !alive,
        signal: async kind => { calls.push(kind); alive = false; drained = true; }, close: async () => calls.push('close') };
    } });
  const events = [];
  const result = await run({ provider: 'codex', cwd: process.cwd(), prompt: 'Synthetic descendant lifecycle',
    onEvent: event => events.push(event.type) });
  assert.equal(result.text, 'Done.');
  assert.equal(drained, true);
  assert.deepEqual(calls, ['capture', 'SIGTERM', 'close']);
  assert.deepEqual(events.slice(0, 2), ['spawn', 'processes']);
});

test('descendant inspection failure preserves uncertainty after an otherwise successful native result', async () => {
  const fake = fakeSpawn([{ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }, { type: 'turn.completed' }]);
  const events = [];
  const run = createNativeCollaborationRunner({ spawnImpl: fake.spawnImpl, groupAliveImpl: () => false,
    processTrackerFactory: async () => ({ refresh: async () => { throw new Error('Inspection unavailable'); },
      close: async () => {}, stopped: async () => true }) });
  await assert.rejects(run({ provider: 'codex', cwd: process.cwd(), prompt: 'Synthetic descendant inspection', onEvent: event => events.push(event) }),
    error => error.executionUncertain === true && /ownership inspection failed/.test(error.message));
  assert.equal(events.some(event => event.type === 'process-inspection-failed'), true);
});

test('production runner reports an absent binary and unavailable cwd as known failures before native launch', async () => {
  const run = createNativeCollaborationRunner({ commands: { codex: '/missing/native-codex-for-test', claude: '/missing/native-claude-for-test' } });
  const events = [];
  await assert.rejects(run({ provider: 'codex', cwd: process.cwd(), prompt: 'Never infer', onEvent: event => events.push(event) }),
    error => error.executionUncertain === false);
  assert.deepEqual(events, []);
  await assert.rejects(run({ provider: 'codex', cwd: '/missing/native-cwd-for-test', prompt: 'Never infer' }),
    error => error.executionUncertain === false);
});

test('native token usage is normalized, kept on failures and dropped when malformed', async () => {
  assert.deepEqual(normalizeNativeUsage('codex', { input_tokens: 1000, cached_input_tokens: 900, cache_write_input_tokens: 0,
    output_tokens: 50, reasoning_output_tokens: 20 }), { inputTokens: 1000, cacheReadInputTokens: 900, cacheWriteInputTokens: 0,
    outputTokens: 50, reasoningOutputTokens: 20 });
  for (const raw of [null, [], { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 1 },
    { input_tokens: 10, cached_input_tokens: 11, output_tokens: 1 }, { input_tokens: 10, output_tokens: 1, reasoning_output_tokens: 2 }])
    assert.equal(normalizeNativeUsage('codex', raw), null);
  assert.equal(normalizeNativeUsage('claude', { input_tokens: 1, output_tokens: 1 }, -1).reportedCostUsd, undefined);
  const failed = fakeSpawn([{ type: 'thread.started', thread_id: 'codex-session' },
    { type: 'turn.completed', usage: { input_tokens: 40, cached_input_tokens: 30, output_tokens: 4 } }], 1);
  await assert.rejects(runner(failed)({ provider: 'codex', cwd: process.cwd(), prompt: 'Fail.' }),
    error => error.executionUncertain === true && error.usage?.inputTokens === 40 && error.usage.outputTokens === 4);
  const malformed = fakeSpawn([{ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
    { type: 'turn.completed', usage: { input_tokens: 'many', output_tokens: 1 } }]);
  assert.equal((await runner(malformed)({ provider: 'codex', cwd: process.cwd(), prompt: 'Done.' })).usage, null);
});

test('full-access workers run without sandbox or prompts, load user config and avoid the controller MCP', async () => {
  const done = [{ type: 'thread.started', thread_id: 'codex-session' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }, { type: 'turn.completed' }];
  const mcp = { command: '/usr/bin/node', args: ['server.mjs'], env: { CLAUDEX_WORK_TOKEN: 'private' } };
  for (const registered of [true, false]) {
    const fake = fakeSpawn(done);
    const probes = [];
    const run = createNativeCollaborationRunner({ spawnImpl: fake.spawnImpl, groupAliveImpl: () => false,
      controllerMcpRegistered: async command => { probes.push(command); return registered; },
      userPath: async () => registered ? '/opt/homebrew/bin:/usr/bin:/bin' : (() => { throw new Error('no login shell'); })() });
    await run({ provider: 'codex', cwd: process.cwd(), prompt: 'Do it.', permission: 'full-access', mcp });
    const { args, options } = fake.calls[0];
    assert.deepEqual(probes, ['codex']);
    assert.equal(args.includes('--ignore-user-config'), false);
    assert.equal(args[args.indexOf('--sandbox') + 1], 'danger-full-access');
    assert.ok(args.includes('approval_policy="never"'));
    assert.equal(args.includes('mcp_servers.claudex-work.enabled=false'), registered);
    assert.ok(args.some(arg => arg.startsWith('mcp_servers.claudex.command=')));
    assert.equal(options.env.CLAUDEX_COLLABORATION_WORKER, '1');
    // A failed login-shell probe keeps the broker PATH instead of refusing work.
    assert.equal(options.env.PATH, registered ? '/opt/homebrew/bin:/usr/bin:/bin' : process.env.PATH);
  }
  const claude = fakeSpawn([{ type: 'result', is_error: false, result: 'Implemented.' }]);
  await createNativeCollaborationRunner({ spawnImpl: claude.spawnImpl, groupAliveImpl: () => false })({
    provider: 'claude', cwd: process.cwd(), prompt: 'Do it.', permission: 'full-access', mcp });
  const args = claude.calls[0].args;
  for (const flag of ['--dangerously-skip-permissions', '--no-session-persistence', '--mcp-config']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'mcp__claudex-work');
  for (const flag of ['--restricted', '--strict-mcp-config', '--tools', '--permission-mode']) assert.equal(args.includes(flag), false, flag);
  assert.equal(claude.calls[0].options.env.CLAUDEX_COLLABORATION_WORKER, '1');
  // Sandboxed levels keep the isolated profile.
  const sandboxed = fakeSpawn(done);
  await createNativeCollaborationRunner({ spawnImpl: sandboxed.spawnImpl, groupAliveImpl: () => false,
    controllerMcpRegistered: async () => { throw new Error('must not probe'); },
    userPath: async () => { throw new Error('must not read the login shell'); } })({
    provider: 'codex', cwd: process.cwd(), prompt: 'Do it.', permission: 'workspace-write' });
  assert.ok(sandboxed.calls[0].args.includes('--ignore-user-config'));
  assert.equal(sandboxed.calls[0].args[sandboxed.calls[0].args.indexOf('--sandbox') + 1], 'workspace-write');
});
