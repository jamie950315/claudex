import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, appendFile, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ClaudeOwner, CLAUDE_OWNER_CLI_VERSION, CLAUDE_OWNER_SDK_VERSION } from '../src/claude-owner.mjs';
import { sessionPath } from '../src/claude.mjs';

function queue() {
  const items = []; let wake, ended = false;
  return { push(item) { items.push(item); wake?.(); }, end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (!ended || items.length) {
        if (items.length) yield items.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
    } };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claudex-reset-')));
  const claudeHome = join(root, 'claude'); await mkdir(claudeHome);
  const calls = { inputs: [], remote: [], options: [], journalAtClear: [], usage: [], policy: [], mcpStatus: 0 };
  const faults = {};
  let events, owner, activeId, closed = 0;
  const writeRow = async (id, row) => {
    const path = sessionPath(claudeHome, root, id);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(row) + '\n');
  };
  const queryFactory = ({ prompt, options }) => {
    calls.options.push(options); events = queue();
    activeId = options.resume ?? options.sessionId;
    const output = events;
    (async () => {
      for await (const item of prompt) {
        calls.inputs.push(item);
        if (faults.stateEvents) output.push({ type: 'system', subtype: 'session_state_changed', session_id: activeId, state: 'running' });
        if (item.message.content === '/clear' && !item.client_composed) {
          calls.journalAtClear.push(JSON.parse(await readFile(owner.statePath, 'utf8')));
          const oldId = activeId;
          if (faults.oldInitFirst) output.push({ type: 'system', subtype: 'init', session_id: oldId });
          activeId = randomUUID();
          const displayId = randomUUID();
          faults.actualTarget = activeId; faults.displayId = displayId;
          await writeRow(activeId, { type: 'system', sessionId: activeId, subtype: 'synthetic-init' });
          if (faults.nativeTail) {
            await writeRow(oldId, { type: 'queue-operation', sessionId: oldId, operation: 'enqueue', content: '/clear' });
            await writeRow(oldId, { type: 'queue-operation', sessionId: oldId, operation: 'dequeue' });
            await writeRow(oldId, { type: 'bridge-session', sessionId: oldId, bridgeSessionId: '', lastSequenceNum: 0 });
            await writeRow(oldId, { type: 'cost-state', sessionId: oldId, totalCostUSD: faults.nativeCost ?? 0,
              totalAPIDuration: 0, totalAPIDurationWithoutRetries: 0, totalToolDuration: 0, totalLinesAdded: 0, totalLinesRemoved: 0,
              modelUsage: {}, hasUnknownModelCost: false });
          }
          if (faults.modifyOld) await writeRow(oldId, { type: 'user', uuid: randomUUID(), sessionId: oldId,
            message: { role: 'user', content: 'Unexpected concurrent input' } });
          if (faults.dropClear) continue;
          output.push({ type: 'conversation_reset', trigger: 'clear', new_conversation_id: displayId,
            user_message_uuid: item.uuid, session_id: oldId });
          const receipt = { type: 'result', subtype: 'success', is_error: false, local_command: 'clear',
            session_id: activeId, user_message_uuid: item.uuid, user_message_uuids: [item.uuid],
            num_turns: 0, duration_api_ms: 0, total_cost_usd: 0, ...faults.receipt };
          const init = { type: 'system', subtype: 'init', session_id: faults.wrongInit ? randomUUID() : activeId };
          if (faults.initFirst) { output.push(init); output.push(receipt); }
          else { output.push(receipt); if (!faults.dropInit) output.push(init); }
          if (faults.stateEvents) output.push({ type: 'system', subtype: 'session_state_changed', session_id: activeId, state: 'idle' });
          continue;
        }
        await writeRow(activeId, { type: 'user', sessionId: activeId, uuid: item.uuid, message: item.message });
        if (faults.dropAppend || faults.dropRestore && calls.inputs.some(entry => entry.message.content === '/clear' && !entry.client_composed)) continue;
        output.push({ type: 'result', subtype: 'success', is_error: false, session_id: activeId,
          user_message_uuid: item.uuid, user_message_uuids: [item.uuid], num_turns: 0, duration_api_ms: 0, total_cost_usd: 0 });
        if (faults.stateEvents) output.push({ type: 'system', subtype: 'session_state_changed', session_id: activeId, state: 'idle' });
      }
    })();
    return {
      initializationResult: async () => ({ session_state: faults.initialState ?? 'idle', commands: faults.noClear ? [] : [{ name: 'clear' }] }),
      async mcpServerStatus() { calls.mcpStatus++; return faults.mcpServers ?? []; },
      async getContextUsage(options) {
        calls.usage.push(options);
        return { totalTokens: 2000, maxTokens: 200000, rawMaxTokens: 1000000, percentage: 0.2,
          memoryFiles: [{ path: '/private/not-returned' }], ...faults.usage };
      },
      async enableRemoteControl(enabled, title, settings) {
        calls.remote.push({ enabled, title, settings });
        const remoteId = faults.newRemote ? `cse_${randomUUID()}` : settings.reattachSessionId ?? `cse_${randomUUID()}`;
        await writeRow(activeId, { type: 'bridge-session', sessionId: activeId, bridgeSessionId: remoteId });
        return { bridge_session_id: remoteId };
      },
      close() { closed++; output.end(); },
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
    };
  };
  const config = { root: join(root, 'state'), conversationId: 'synthetic reset', cwd: root, claudeHome,
    queryFactory, settingsResolver: async options => { calls.policy.push(options); return faults.policy ?? { effective: {}, sources: [] }; },
    policyPreflight: async () => faults.policySnapshot ?? { version: 1, sources: [] },
    sdkVersion: CLAUDE_OWNER_SDK_VERSION, claudeVersion: CLAUDE_OWNER_CLI_VERSION, receiptTimeoutMs: 100 };
  const open = async (cold = false, overrides = {}) => { owner = await ClaudeOwner.open({ ...config, deferRemoteConnection: cold, ...overrides }); return owner; };
  const first = await open();
  const baseline = await first.append({ operationId: 'original', content: 'Canonical source user and assistant history.' });
  const previousPath = first.status().transcriptPath, previousText = await readFile(previousPath, 'utf8');
  await first.close();
  return { open, config, baseline, previousPath, previousText, calls, faults,
    emit: event => events.push({ session_id: activeId, ...event }), closed: () => closed,
    clearCount: () => calls.inputs.filter(item => item.message.content === '/clear' && !item.client_composed).length };
}

const builder = async sessionId => `Authenticated archive bootstrap for native ${sessionId}`;
const reset = owner => owner.resetContext({ operationId: 'rotation-1', buildContent: builder });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('an unfinished native user input prevents launching a restricted cold maintenance worker', async () => {
  const f = await fixture();
  await appendFile(f.previousPath, JSON.stringify({ type: 'user', uuid: randomUUID(), sessionId: f.baseline.sessionId,
    message: { role: 'user', content: 'A real unfinished request must not enter a maintenance profile.' } }) + '\n');
  const launched = f.calls.options.length;
  await assert.rejects(f.open(true), /complete assistant turn/);
  assert.equal(f.calls.options.length, launched);
  assert.equal(f.clearCount(), 0);
});

test('a persisted pending no-query input is reconciled before the cold boundary check without resend', async () => {
  const f = await fixture(), first = await f.open();
  f.faults.dropAppend = true;
  await assert.rejects(first.append({ operationId: 'pending-before-upgrade', content: 'A fully persisted synchronized checkpoint.' }), /receipt timed out/);
  await first.close();
  const sent = f.calls.inputs.length;
  f.faults.dropAppend = false;
  const cold = await f.open(true);
  assert.equal(cold.status().pending, null);
  assert.equal(cold.status().coldResetEligible, true);
  assert.equal(f.calls.inputs.length, sent);
  assert.equal(cold.state.lastAppend.recovered, true);
  await cold.close();
});

test('cold context reset journals before clear, uses receipt native ID, retains original and reconnects the same remote', async () => {
  const f = await fixture(), owner = await f.open(true);
  assert.equal(owner.status().coldResetEligible, true);
  assert.equal(f.calls.remote.length, 1);
  assert.equal(f.calls.options.at(-1).settings.remoteControlAtStartup, false);
  assert.equal(f.calls.options.at(-1).settings.crossSessionInbound, 'refuse');
  const result = await reset(owner);
  assert.equal(result.sessionId, f.faults.actualTarget);
  assert.notEqual(result.sessionId, f.faults.displayId);
  assert.equal(result.previousSessionId, f.baseline.sessionId);
  assert.equal(result.remoteId, f.baseline.remoteId);
  assert.equal(result.receipt.localCommand, 'clear');
  assert.deepEqual([result.receipt.numTurns, result.receipt.apiMs, result.receipt.cost], [0, 0, 0]);
  const sent = f.calls.inputs.find(item => item.message.content === '/clear');
  assert.equal(sent.shouldQuery, false);
  assert.equal(Object.hasOwn(sent, 'client_composed'), false);
  assert.equal(f.calls.journalAtClear[0].reset.phase, 'sent');
  assert.equal(f.calls.journalAtClear[0].reset.clearUuid, sent.uuid);
  assert.equal(await readFile(f.previousPath, 'utf8'), f.previousText);
  assert.equal(owner.status().retainedGeneration.transcriptPath, f.previousPath);
  assert.equal(f.calls.remote.at(-1).settings.reattachSessionId, f.baseline.remoteId);
  await assert.rejects(owner.resetContext({ operationId: 'rotation-2', buildContent: builder }), /retained context generation/);
  const again = await reset(owner);
  assert.equal(again.duplicate, true); assert.equal(f.clearCount(), 1);
  await owner.close();
});

test('clear init may precede its correlated zero-query result without confusing display and native IDs', async () => {
  const f = await fixture(); f.faults.initFirst = true; f.faults.oldInitFirst = true;
  const owner = await f.open(true), result = await reset(owner);
  assert.equal(result.sessionId, f.faults.actualTarget);
  assert.notEqual(result.sessionId, f.faults.displayId);
  await owner.close();
});

test('native no-query running and trailing idle events do not invalidate their owned reset lifecycle', async () => {
  const f = await fixture(); f.faults.stateEvents = true;
  const owner = await f.open(true);
  await reset(owner);
  assert.equal(owner.status().nativeState, 'idle');
  assert.equal(owner.activityRevision, 0);
  assert.equal(f.calls.options.at(-1).env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
  await owner.close();
});

test('native clear transport metadata preserves the byte prefix and seals the complete retained generation', async () => {
  const f = await fixture(); f.faults.nativeTail = true;
  const owner = await f.open(true);
  await reset(owner);
  const text = await readFile(f.previousPath, 'utf8');
  assert.ok(text.startsWith(f.previousText)); assert.ok(text.length > f.previousText.length);
  const saved = JSON.parse(await readFile(owner.statePath, 'utf8'));
  assert.equal(saved.retainedGeneration.originalPrefix.bytes, Buffer.byteLength(f.previousText));
  assert.equal(saved.retainedGeneration.bytes, Buffer.byteLength(text));
  assert.equal(saved.retainedGeneration.sealed, true);
  await reset(owner); assert.equal(f.clearCount(), 1); await owner.close();
});

test('native clear metadata with new usage cannot hide intervening work', async () => {
  const f = await fixture(); f.faults.nativeTail = true; f.faults.nativeCost = 1;
  const owner = await f.open(true);
  await assert.rejects(reset(owner), /unaccounted native usage/);
  assert.equal(f.calls.inputs.length, 2); await owner.close();
});

test('retained native generation changes continue blocking normal reads and appends after reset promotion', async () => {
  const f = await fixture(), owner = await f.open(true);
  await reset(owner);
  await appendFile(f.previousPath, JSON.stringify({ type: 'user', sessionId: f.baseline.sessionId,
    uuid: randomUUID(), message: { role: 'user', content: 'Later work in preserved source' } }) + '\n');
  await assert.rejects(owner.inspectTranscript(), /preserved context-reset source changed/);
  await assert.rejects(owner.append({ operationId: 'later', content: 'New delta' }), /preserved context-reset source changed/);
  assert.equal(f.calls.inputs.length, 3); await owner.close();
});

test('context usage returns only validated native capacity numbers through the summary read', async () => {
  const f = await fixture(), owner = await f.open(true);
  assert.deepEqual(await owner.contextUsage(), { totalTokens: 2000, maxTokens: 200000, rawMaxTokens: 1000000, percentage: 0.2 });
  assert.deepEqual(f.calls.usage, [{ detail: 'summary' }]);
  f.faults.usage = { totalTokens: NaN };
  await assert.rejects(owner.contextUsage(), /missing or invalid/);
  assert.equal(f.clearCount(), 0); await owner.close();
});

test('close retains the writer lock until the known native child has actually exited', async () => {
  const f = await fixture(), owner = await f.open(true);
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  owner.child = child;
  let finished = false;
  const closing = owner.close().then(() => { finished = true; });
  await tick(); assert.equal(finished, false);
  await assert.rejects(f.open(true), /already running/);
  child.exitCode = 0; child.emit('exit', 0, null);
  await closing; assert.equal(finished, true);
  const next = await f.open(true); await next.close();
});

test('idle startup failure also waits for native child exit before releasing its writer lock', async () => {
  const f = await fixture(), child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
  let owner, failed = false;
  const queryFactory = input => {
    const query = f.config.queryFactory(input);
    query.initializationResult = async () => { owner.child = child; throw new Error('Synthetic idle initialization failure'); };
    return query;
  };
  owner = new ClaudeOwner({ ...f.config, queryFactory, deferRemoteConnection: true });
  const failure = assert.rejects(owner.start(), /idle initialization failure/).then(() => { failed = true; });
  for (let i = 0; i < 100 && !owner.child; i++) await new Promise(resolve => setTimeout(resolve, 1));
  await tick(); assert.equal(owner.child, child); assert.equal(failed, false);
  await assert.rejects(f.open(true), /already running/);
  child.exitCode = 1; child.emit('exit', 1, null);
  await failure;
  assert.equal(owner.status().closed, true);
});

test('hot owners refuse clear and do not use RC detach as a writer lease', async () => {
  const f = await fixture(), owner = await f.open();
  await assert.rejects(reset(owner), /fresh cold owner/);
  assert.equal(f.clearCount(), 0);
  assert.equal(f.calls.remote.some(call => call.enabled === false), false);
  await owner.close();
});

test('any native bridge-state event permanently removes cold reset eligibility', async () => {
  const f = await fixture(), owner = await f.open(true);
  assert.equal(owner.status().coldResetEligible, true);
  f.emit({ type: 'system', subtype: 'bridge_state', state: 'disconnected', bridge_epoch: 1 }); await tick();
  assert.equal(owner.status().coldResetEligible, false);
  await assert.rejects(reset(owner), /fresh cold owner/);
  assert.equal(f.clearCount(), 0); assert.equal(f.calls.remote.length, 1);
  await owner.close();
});

test('cold maintenance disables normal extensions, verifies policy and MCP absence without altering normal options', async () => {
  const f = await fixture();
  const originalOptions = { settingSources: ['user'], strictMcpConfig: false,
    mcpServers: { external: { type: 'http', url: 'https://example.invalid' } },
    plugins: [{ type: 'local', path: '/example/plugin' }], tools: ['Read'],
    hooks: { SessionStart: [{ hooks: [async () => ({})] }] }, settings: { enabledPlugins: { example: true } } };
  const owner = await f.open(true, { options: originalOptions });
  const actual = f.calls.options.at(-1);
  assert.deepEqual(actual.settingSources, []); assert.equal(actual.strictMcpConfig, true);
  assert.deepEqual(actual.mcpServers, {}); assert.deepEqual(actual.plugins, []);
  assert.deepEqual(actual.tools, []); assert.deepEqual(actual.hooks, {});
  assert.equal(actual.settings.disableAllHooks, true); assert.deepEqual(actual.settings.enabledPlugins, {});
  assert.deepEqual(originalOptions.tools, ['Read']); assert.equal(originalOptions.strictMcpConfig, false);
  assert.equal(f.calls.mcpStatus, 1); assert.deepEqual(f.calls.policy[0].settingSources, []);
  assert.equal(owner.status().maintenanceOnly, true); assert.equal(owner.status().deferRemoteConnection, true);
  await owner.close();
});

test('cold maintenance refuses any MCP server, including disconnected channels', async () => {
  const f = await fixture(); f.faults.mcpServers = [{ name: 'external', status: 'disconnected' }];
  await assert.rejects(f.open(true), /verified empty native MCP server list/);
  assert.equal(f.clearCount(), 0); assert.equal(f.calls.remote.length, 1);
});

test('managed hooks and dynamic or unreadable policy refuse maintenance before native startup', async () => {
  for (const policy of [
    { effective: {}, sources: [{ source: 'managed', settings: { hooks: { SessionStart: [{ hooks: [] }] } } }] },
    { effective: { policyHelper: '/example/helper' }, sources: [] },
    { effective: { policyHelpers: { model: '/example/helper' } }, sources: [] },
    { effective: { policyUnreadable: true }, sources: [] },
    { effective: { policyHookCount: 1 }, sources: [] },
  ]) {
    const f = await fixture(); f.faults.policy = policy;
    const before = f.calls.options.length;
    await assert.rejects(f.open(true), /managed hooks|managed policy/);
    assert.equal(f.calls.options.length, before); assert.equal(f.clearCount(), 0);
  }
});

test('maintenance reset and duplicate recovery remain disconnected until the normal owner restarts', async () => {
  const f = await fixture(); let owner = await f.open(true, { connectAfterReset: false });
  const first = await reset(owner);
  assert.equal(f.calls.remote.length, 1);
  assert.equal(owner.status().maintenanceOnly, true);
  const duplicate = await reset(owner);
  assert.equal(duplicate.duplicate, true); assert.equal(f.calls.remote.length, 1);
  await owner.close();
  owner = await f.open(true, { connectAfterReset: false });
  assert.equal((await reset(owner)).duplicate, true); assert.equal(f.calls.remote.length, 1);
  await owner.close();
  owner = await f.open();
  assert.equal(owner.status().sessionId, first.sessionId);
  assert.equal(owner.status().maintenanceOnly, false);
  assert.deepEqual(f.calls.options.at(-1).settingSources, ['user', 'project', 'local']);
  assert.equal(f.calls.remote.length, 2);
  assert.equal(f.calls.remote.at(-1).settings.reattachSessionId, first.remoteId);
  await owner.close();
});

test('changed policy source snapshot after cold startup refuses clear without sending input', async () => {
  const f = await fixture(), owner = await f.open(true, { connectAfterReset: false });
  f.faults.policySnapshot = { version: 1, sources: [{ path: '/synthetic/policy', exists: true }] };
  await assert.rejects(reset(owner), /policy changed after startup/);
  assert.equal(f.clearCount(), 0); assert.equal(owner.status().reset.phase, 'prepared');
  await owner.close();
});

test('busy and full-set background task guards preserve the native process, including ambient work', async () => {
  const f = await fixture(), owner = await f.open(true), closeCount = f.closed();
  f.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a', ambient: true }] }); await tick();
  await assert.rejects(reset(owner), /busy/);
  await assert.rejects(owner.close(), /refusing to interrupt/);
  f.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b' }] }); await tick();
  assert.deepEqual(owner.status().backgroundTasks.map(task => task.task_id), ['b']);
  f.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }); await tick();
  assert.equal(owner.status().backgroundTasks.length, 0);
  await assert.rejects(reset(owner), /fresh cold owner/);
  assert.equal(f.closed(), closeCount); assert.equal(f.clearCount(), 0);
  await owner.close();
});

test('a running cold owner is never reset or closed', async () => {
  const f = await fixture(), owner = await f.open(true);
  f.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' }); await tick();
  await assert.rejects(reset(owner), /busy/);
  await assert.rejects(owner.close(), /refusing to interrupt/);
  f.emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' }); await tick();
  assert.equal(f.clearCount(), 0); await owner.close();
});

test('lost clear result leaves an unknown durable outcome and never resends or resumes an empty old identity', async () => {
  const f = await fixture(); f.faults.dropClear = true;
  const owner = await f.open(true);
  await assert.rejects(reset(owner), /timed out/);
  assert.equal(owner.status().reset.phase, 'sent');
  await assert.rejects(owner.append({ operationId: 'later', content: 'Not allowed' }), /context reset/);
  await assert.rejects(owner.connect(), /pending context reset/);
  await assert.rejects(reset(owner), /outcome is unknown/);
  await owner.close();
  await assert.rejects(f.open(true), /outcome is unknown/);
  assert.equal(f.clearCount(), 1); assert.equal(f.calls.remote.length, 1);
  assert.equal(await readFile(f.previousPath, 'utf8'), f.previousText);
});

test('a clear result without matching init cannot silently fabricate a successful reset', async () => {
  const f = await fixture(); f.faults.dropInit = true;
  const owner = await f.open(true);
  await assert.rejects(reset(owner), /timed out/);
  const saved = JSON.parse(await readFile(owner.statePath, 'utf8'));
  assert.equal(saved.reset.targetSessionId, f.faults.actualTarget);
  assert.equal(saved.sessionId, f.baseline.sessionId);
  await owner.close(); await assert.rejects(f.open(true), /outcome is unknown/);
});

test('querying or ambiguous clear receipts fail closed without terminating the process', async () => {
  for (const receipt of [{ num_turns: 1 }, { local_command: 'not-clear' }, { user_message_uuids: [randomUUID()] }]) {
    const f = await fixture(); f.faults.receipt = receipt;
    const owner = await f.open(true), count = f.closed();
    await assert.rejects(reset(owner), /querying or ambiguous/);
    assert.equal(f.closed(), count); assert.equal(f.clearCount(), 1);
    assert.match(owner.status().blocked, /Context-reset/);
    await owner.close();
  }
});

test('mismatched result and init native identities block restoration', async () => {
  const f = await fixture(); f.faults.wrongInit = true;
  const owner = await f.open(true);
  await assert.rejects(reset(owner), /identities disagree/);
  assert.equal(f.calls.inputs.length, 2);
  await owner.close();
});

test('restart after a verified clear restores the deterministic archive without another clear', async () => {
  const f = await fixture(); let owner = await f.open(true);
  await assert.rejects(owner.resetContext({ operationId: 'rotation-1', buildContent: async () => { throw new Error('Synthetic builder interruption'); } }), /builder interruption/);
  assert.equal(owner.status().reset.phase, 'cleared');
  assert.equal(owner.status().sessionId, f.faults.actualTarget);
  await owner.close();
  owner = await f.open(true);
  assert.equal(f.calls.options.at(-1).resume, f.faults.actualTarget);
  const result = await reset(owner);
  assert.equal(result.sessionId, f.faults.actualTarget);
  assert.equal(f.clearCount(), 1); assert.equal(f.calls.inputs.length, 3);
  assert.equal(result.remoteId, f.baseline.remoteId);
  await owner.close();
});

test('a held reset transaction excludes append, reconnect, close and concurrent reset', async () => {
  const f = await fixture(), owner = await f.open(true);
  let release, built;
  const building = new Promise(resolve => { built = resolve; });
  const content = new Promise(resolve => { release = resolve; });
  const pending = owner.resetContext({ operationId: 'rotation-1', buildContent: async id => { built(); await content; return builder(id); } });
  await building;
  await assert.rejects(owner.append({ operationId: 'other', content: 'Other input' }), /context reset/);
  await assert.rejects(owner.connect(), /pending context reset/);
  await assert.rejects(owner.close(), /refusing to interrupt/);
  await assert.rejects(reset(owner), /pending operation/);
  release(); await pending;
  assert.equal(f.clearCount(), 1); assert.equal(f.calls.inputs.length, 3); await owner.close();
});

test('lost bootstrap receipt recovers exact persisted packet without clear or packet resend', async () => {
  const f = await fixture(); f.faults.dropRestore = true;
  let owner = await f.open(true);
  await assert.rejects(reset(owner), /append receipt timed out/);
  const pending = owner.status().pending;
  assert.match(pending, /^restore:/);
  await owner.close();
  owner = await f.open(true);
  const result = await reset(owner);
  assert.equal(result.recovered, true);
  assert.equal(f.clearCount(), 1); assert.equal(f.calls.inputs.length, 3);
  await owner.close();
});

test('changed bootstrap content after a persisted intent is rejected across restart', async () => {
  const f = await fixture(); f.faults.dropRestore = true;
  let owner = await f.open(true);
  await assert.rejects(reset(owner), /timed out/); await owner.close();
  owner = await f.open(true);
  await assert.rejects(owner.resetContext({ operationId: 'rotation-1', buildContent: async () => 'Different archive' }), /different content/);
  assert.equal(f.calls.inputs.length, 3); await owner.close();
});

test('changed preserved source blocks restore and recovery without deleting either generation', async () => {
  const f = await fixture(); f.faults.modifyOld = true;
  const owner = await f.open(true);
  await assert.rejects(reset(owner), /preserved context-reset source changed/);
  assert.equal(f.calls.inputs.length, 2);
  assert.match(await readFile(f.previousPath, 'utf8'), /Unexpected concurrent input/);
  await owner.close(); await assert.rejects(f.open(true), /preserved context-reset source changed/);
});

test('missing cleared native transcript cannot restart using an empty saved identity', async () => {
  const f = await fixture(), owner = await f.open(true);
  await assert.rejects(owner.resetContext({ operationId: 'rotation-1', buildContent: async () => { throw new Error('Synthetic interruption'); } }), /interruption/);
  const statePath = owner.statePath;
  await owner.close();
  // Corrupt only the isolated journal; no native file deletion is needed.
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const missing = randomUUID();
  state.sessionId = missing; state.reset.targetSessionId = missing; state.reset.initSessionId = missing; state.reset.receipt.sessionId = missing;
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(f.open(true), /native transcript is missing/);
  assert.equal(f.clearCount(), 1);
});

test('cold reset requires advertised command and disallows uninspectable startup option routes', async () => {
  const f = await fixture(); f.faults.noClear = true;
  const owner = await f.open(true);
  await assert.rejects(reset(owner), /did not advertise/); await owner.close();
  assert.throws(() => new ClaudeOwner({ ...f.config, deferRemoteConnection: true, options: { settings: '/settings.json' } }), /inline settings/);
  assert.throws(() => new ClaudeOwner({ ...f.config, deferRemoteConnection: true, options: { extraArgs: { rc: null } } }), /inline settings/);
});

test('Remote Control identity drift after restore is rejected instead of allocating a replacement', async () => {
  const f = await fixture(), owner = await f.open(true); f.faults.newRemote = true;
  await assert.rejects(reset(owner), /did not preserve/);
  assert.equal(f.calls.remote.at(-1).settings.reattachSessionId, f.baseline.remoteId);
  assert.equal(owner.status().remoteId, f.baseline.remoteId);
  assert.equal(f.clearCount(), 1); await owner.close();
});
