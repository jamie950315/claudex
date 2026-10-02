import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createNativeActivity, sanitizeNativeActivity } from '../src/collaboration-activity.mjs';
import { createNativeCollaborationRunner } from '../src/collaboration-native.mjs';

test('activity is native receipt evidence, not process liveness or a useful-progress claim', () => {
  let clock = 100;
  const observer = createNativeActivity('codex', { now: () => clock });
  const before = observer.snapshot();
  assert.equal(before.lastNativeEventAt, null);
  assert.equal(before.models.status, 'unverified');
  observer.observe({ type: 'thread.started', thread_id: 'private-session' });
  observer.observe({ type: 'item.started', item: { type: 'command_execution', command: 'secret command' } });
  const working = observer.snapshot();
  assert.equal(working.lastNativeEventAt, 100);
  assert.deepEqual(working.recent.at(-1), { kind: 'tool-start', scope: 'main', at: 100, toolKind: 'command' });
  clock = 100000;
  for (const type of ['spawn', 'processes', 'process-inspection-failed']) observer.observe({ type, pid: 42 });
  assert.deepEqual(observer.snapshot(), working, 'process-only inspection and elapsed time cannot update native activity');
  observer.observe({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'secret output' } });
  assert.equal(observer.snapshot().recent.at(-1).kind, 'tool-end');
  assert.equal(observer.snapshot().completion, null);
  observer.observe({ type: 'turn.completed' });
  assert.deepEqual(observer.snapshot().completion, { source: 'codex:turn.completed', outcome: 'success', observedAt: clock });
  assert.doesNotMatch(JSON.stringify(observer.snapshot()), /secret|private-session|progress|pid/);
});

test('native configuration, primary response, sidechain and aggregate models remain separate', () => {
  const observer = createNativeActivity('claude', { now: () => 123 });
  observer.observe({ type: 'system', subtype: 'init', model: 'configured-model' });
  assert.equal(observer.snapshot().models.status, 'unverified', 'configuration is not actual response evidence');
  observer.observe({ type: 'assistant', message: { model: 'primary-model', content: [{ type: 'text', text: 'private reply' }] } });
  observer.observe({ type: 'assistant', parent_tool_use_id: 'private-tool-id', message: { model: 'side-model', content: [] } });
  observer.observe({ type: 'stream_event', isSidechain: true,
    event: { type: 'message_start', message: { model: 'side-stream-model' } } });
  observer.observe({ type: 'result', is_error: false, modelUsage: { 'aggregate-model': { private: 'usage' } } });
  const { models } = observer.snapshot();
  assert.equal(models.configuration.model, 'configured-model');
  assert.equal(models.status, 'native-reported');
  assert.deepEqual(models.main.map(item => item.model), ['primary-model']);
  assert.deepEqual(models.auxiliary.map(item => item.model), ['side-model', 'side-stream-model']);
  assert.deepEqual(models.unclassified.map(item => item.model), ['aggregate-model']);
  assert.doesNotMatch(JSON.stringify(observer.snapshot()), /private/);
});

test('diagnostics are bounded and only retain allowlisted structure', () => {
  const observer = createNativeActivity('claude', { now: () => 123 });
  for (let index = 0; index < 1000; index++) {
    observer.observe({ type: 'assistant', message: { model: `model-${index}`, content: [
      { type: 'thinking', thinking: 'hidden reasoning must not be retained' },
      { type: 'tool_use', name: 'secret-tool', input: { token: 'credential' } },
    ] } });
    observer.observe({ type: 'user', message: { content: [{ type: 'tool_result', content: 'private result' }] } });
  }
  const snapshot = observer.snapshot();
  assert.equal(snapshot.eventCount, 2000);
  assert.equal(snapshot.recent.length, 16);
  assert.equal(snapshot.models.main.length, 4);
  assert.ok(snapshot.recent.some(item => item.kind === 'tool-start'));
  assert.ok(snapshot.recent.some(item => item.kind === 'tool-end'));
  assert.ok(JSON.stringify(snapshot).length < 5000);
  assert.doesNotMatch(JSON.stringify(snapshot), /hidden|private|credential|secret-tool/);
  const clean = sanitizeNativeActivity({ ...snapshot, prompt: 'secret',
    recent: snapshot.recent.map(event => ({ ...event, args: 'secret' })),
    models: { ...snapshot.models, main: [...snapshot.models.main, { model: 'bad\nmodel', source: 'claude:assistant.message.model', observedAt: 1 }] } });
  assert.doesNotMatch(JSON.stringify(clean), /secret|bad/);
  assert.equal(sanitizeNativeActivity({ provider: 'unknown', secret: 'secret' }), null);
  assert.deepEqual(sanitizeNativeActivity({ ...snapshot, provider: 'codex' }).models.main, [],
    'provider-mismatched metadata cannot be promoted into primary model evidence');
});

test('auxiliary completion and aggregate model accounting do not identify the primary execution', () => {
  const observer = createNativeActivity('claude', { now: () => 123 });
  observer.observe({ type: 'assistant', parent_tool_use_id: 'child', message: { model: 'auxiliary-model' } });
  observer.observe({ type: 'result', parent_tool_use_id: 'child', is_error: false,
    modelUsage: { 'aggregate-model': {} } });
  assert.equal(observer.snapshot().completion, null);
  assert.equal(observer.snapshot().models.status, 'unverified');
  assert.deepEqual(observer.snapshot().models.main, []);
});

function syntheticRunner(sequence, { exitCode = 0, onInput } = {}) {
  let clock = 0;
  const run = createNativeCollaborationRunner({ activityNow: () => clock, groupAliveImpl: () => false,
    signalGroupImpl: () => {}, spawnImpl: () => {
      const child = new EventEmitter();
      child.pid = 42;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = signal => { child.emit('close', null, signal); return true; };
      child.stdin.resume();
      child.stdin.on('finish', () => {
        onInput?.();
        for (const [at, event] of sequence) {
          clock = at; child.stdout.write(`${JSON.stringify(event)}\n`);
        }
        child.emit('close', exitCode, null);
      });
      return child;
    } });
  return run;
}

test('runner adds bounded in-flight evidence where existing callbacks only exposed raw activity', async () => {
  const snapshots = [], raw = [];
  const sequence = [[100, { type: 'thread.started', thread_id: 'synthetic' }]];
  for (let at = 101; at <= 3000; at++) sequence.push([at, { type: 'item.updated', item: { type: 'agent_message', text: 'private token' } }]);
  sequence.push([3100, { type: 'item.completed', item: { type: 'agent_message', text: 'Done' } }],
    [3200, { type: 'turn.completed' }]);
  const result = await syntheticRunner(sequence)({ provider: 'codex', cwd: process.cwd(), prompt: 'synthetic',
    model: 'requested-model-only', onEvent: event => raw.push(event.type), onActivity: snapshot => snapshots.push(snapshot) });
  assert.equal(result.text, 'Done');
  assert.equal(raw.filter(type => type === 'item.updated').length, 2900, 'legacy native event handling remains unchanged');
  assert.equal(snapshots.length, 3, 'coalesce repeated token events to a two-second interval and terminal flush');
  assert.equal(snapshots[0].lastNativeEventAt, 100);
  assert.equal(snapshots[1].lastNativeEventAt, 2100);
  assert.equal(snapshots[2].lastNativeEventAt, 3200);
  assert.deepEqual(result.activity, snapshots.at(-1));
  assert.equal(result.activity.models.status, 'unverified');
  assert.deepEqual(result.activity.models.main, [], 'requested model must never fill absent native response metadata');
  assert.doesNotMatch(JSON.stringify(snapshots), /private token|requested-model-only/);
});

test('native activity survives failed exit without manufacturing successful execution', async () => {
  const snapshots = [];
  const run = syntheticRunner([[100, { type: 'assistant', message: { model: 'observed-model', content: [] } }],
    [200, { type: 'user', message: { content: [{ type: 'tool_result', content: 'secret' }] } }]], { exitCode: 1 });
  await assert.rejects(run({ provider: 'claude', cwd: process.cwd(), prompt: 'synthetic',
    onActivity: snapshot => snapshots.push(snapshot) }), error => {
    assert.equal(error.executionUncertain, true);
    assert.equal(error.activity.lastNativeEventAt, 200);
    assert.equal(error.activity.models.main[0].model, 'observed-model');
    assert.equal(error.activity.completion, null);
    assert.deepEqual(error.activity, snapshots.at(-1));
    return true;
  });
  assert.equal(snapshots.length, 2, 'close flush preserves the last activity even before the coalescing interval');
});
