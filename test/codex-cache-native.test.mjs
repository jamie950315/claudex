import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCodexCacheNative } from '../src/codex-cache-native.mjs';

const sessionId = '00000000-0000-4000-8000-000000000001';
const ownerClientId = '00000000-0000-4000-8000-000000000002';
const turnId = '00000000-0000-4000-8000-000000000003';
const target = { sessionId, cwd: '/tmp/synthetic-project' };
const usage = { totalTokens: 105, inputTokens: 100, cachedInputTokens: 90, cacheWriteInputTokens: 0,
  outputTokens: 5, reasoningOutputTokens: 2 };
const settings = {
  model: 'synthetic-model', modelProvider: 'openai', cwd: target.cwd, serviceTier: 'default', disabledPluginIds: [],
  approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' }, activePermissionProfile: null,
  effort: 'medium', collaborationMode: { mode: 'default', settings: { model: 'synthetic-model', reasoning_effort: 'medium', developer_instructions: null } },
  multiAgentMode: 'explicitRequestOnly', summary: 'none', personality: null,
};
function resumeSettings(value = settings) {
  const { sandboxPolicy, effort, summary: _summary, personality: _personality, ...core } = value;
  return { ...structuredClone(core), sandbox: structuredClone(sandboxPolicy), reasoningEffort: effort };
}
function fixture(options = {}) {
  const calls = [], events = [];
  const thread = { id: sessionId, cwd: target.cwd, model: 'synthetic-model', reasoningEffort: 'medium',
    status: { type: 'idle' }, ephemeral: false, parentThreadId: null, forkedFromId: null, source: 'exec',
    preview: 'private', ...options.thread };
  const client = new EventEmitter();
  let closes = 0, ownerCloses = 0;
  client.initialize = async () => ({ userAgent: options.userAgent ?? 'codex/0.160.0 (macos)' });
  client.close = async () => { closes++; client.emit('disconnected'); };
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (options.request) {
      const result = await options.request(method, params, client, thread);
      if (result !== undefined) return result;
    }
    if (method === 'thread/read') return { thread: structuredClone(thread) };
    if (method === 'thread/resume') return { thread: structuredClone(thread), ...resumeSettings(options.settings ?? settings) };
    if (method === 'thread/loaded/list') return { data: options.loaded === false ? [] : [sessionId], nextCursor: null };
    if (method === 'thread/goal/get') return { goal: options.goal ?? null };
    if (method === 'thread/turns/list') return { data: [{ id: turnId, startedAt: 100, status: 'completed', itemsView: 'notLoaded', items: [] }] };
    assert.fail(`Unexpected request ${method}`);
  };
  const preflight = async () => ({ status: 'ready', ownerClientId, close() { ownerCloses++; }, dispatch() { assert.fail('No dispatch'); } });
  const native = createCodexCacheNative({ clientFactory: () => client, preflight: options.preflight ?? preflight, now: () => 101000 });
  const emit = (method, params) => client.emit('notification', { method, params: { threadId: sessionId, ...params } });
  return { native, client, calls, events, thread, emit, closes: () => closes, ownerCloses: () => ownerCloses };
}

test('inspection is metadata-only and owner handles are closed without dispatch', async () => {
  const f = fixture({ thread: { reasoningEffort: null } });
  const state = await f.native.inspect(target);
  assert.deepEqual(Object.keys(state).sort(), ['sessionId', 'cwd', 'model', 'effort', 'phase', 'ownerClientId', 'nativeVersion', 'fingerprint'].sort());
  assert.equal(state.effort, 'native-default'); assert.equal(state.phase, 'idle');
  assert.equal(state.nativeVersion, '0.160.0'); assert.match(state.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls.map(x => x.method), ['thread/read', 'thread/loaded/list']);
  assert.equal(f.calls[0].params.includeTurns, false);
  assert.equal(f.closes(), 1); assert.equal(f.ownerCloses(), 1);
});

test('loaded, exact cwd, persistent primary and version guards reject before any resume', async () => {
  for (const options of [{ loaded: false }, { thread: { cwd: '/tmp/other' } }, { thread: { ephemeral: true } },
    { thread: { parentThreadId: 'parent' } }, { thread: { forkedFromId: 'ancestor' } }, { thread: { source: 'subAgent' } },
    { thread: { status: { type: 'notLoaded' } } }, { thread: { model: null } },
    { userAgent: 'codex/0.159.0' }, { userAgent: 'codex/0.160.0-alpha.1' }]) {
    const f = fixture(options);
    await assert.rejects(f.native.connect(target, event => f.events.push(event)));
    assert(!f.calls.some(x => x.method === 'thread/resume'));
    assert.equal(f.closes(), 1);
  }
});

test('an existing goal refuses subscription without resuming or mutating the goal', async () => {
  const f = fixture({ goal: { objective: 'private goal', status: 'active' } });
  await assert.rejects(f.native.connect(target, () => {}), /active-goal-unsupported/);
  assert(!f.calls.some(x => x.method === 'thread/resume'));
  assert(f.calls.some(x => x.method === 'thread/goal/get'));
});

test('rejoins only the exact loaded thread and requests a metadata-only initial turn', async () => {
  const f = fixture();
  const handle = await f.native.connect(target, event => f.events.push(event));
  assert.deepEqual(handle.initialTurn, { id: turnId, startedAt: 100000, status: 'completed' });
  assert.deepEqual(f.calls.filter(x => x.method === 'thread/resume'), [
    { method: 'thread/resume', params: { threadId: sessionId, excludeTurns: true } },
  ]);
  assert.deepEqual(f.calls.at(-1), { method: 'thread/turns/list', params: {
    threadId: sessionId, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc',
  } });
  assert(!f.calls.some(x => /fork|start|inject/.test(x.method)));
  const before = handle.state.fingerprint;
  f.emit('thread/settings/updated', { threadSettings: structuredClone(settings) });
  f.thread.model = 'changed-model';
  assert.notEqual((await handle.inspect()).fingerprint, before);
  const owner = await handle.preflight(); owner.close();
  await handle.close(); await handle.close();
  assert.equal(f.closes(), 1); assert.deepEqual(f.events, []);
});

test('notifications arriving during resume buffer until listen and strip every content field', async () => {
  const f = fixture({ request(method, params, client) {
    if (method === 'thread/resume') client.emit('notification', { method: 'turn/started', params: {
      threadId: sessionId, turn: { id: turnId, startedAt: 100, items: [{ text: 'private' }] },
    } });
  } });
  const handle = await f.native.connect(target, event => f.events.push(event));
  f.emit('thread/tokenUsage/updated', { turnId, tokenUsage: { total: { ...usage, private: 'secret' }, last: usage, modelContextWindow: 2000000 } });
  f.emit('item/started', { turnId, item: { type: 'unknownFutureTool', arguments: 'secret', output: 'secret' } });
  f.emit('item/started', { turnId, item: { type: 'reasoning', content: 'secret' } });
  f.emit('turn/completed', { turn: { id: turnId, completedAt: 102, status: 'completed', items: [{ text: 'secret' }] } });
  f.emit('thread/tokenUsage/updated', { threadId: 'other', turnId, tokenUsage: {} });
  assert.deepEqual(f.events, []);
  handle.listen(); handle.listen();
  assert.deepEqual(f.events, [
    { type: 'start', turnId, startedAt: 100000 },
    { type: 'usage', turnId, tokenUsage: { total: usage, last: usage }, at: 101000 },
    { type: 'tool', turnId, itemType: 'unknownFutureTool' },
    { type: 'complete', turnId, status: 'completed', completedAt: 102000 },
  ]);
  assert(!JSON.stringify(f.events).includes('secret'));
  await handle.close();
});

test('buffer overflow replaces pending evidence with one terminal invalidation', async () => {
  const f = fixture(); const handle = await f.native.connect(target, event => f.events.push(event));
  for (let i = 0; i < 140; i++) f.emit('item/started', { turnId, item: { type: 'commandExecution' } });
  handle.listen();
  assert.deepEqual(f.events, [{ type: 'invalidated', reason: 'event-buffer-overflow' }]);
  await assert.rejects(handle.preflight(), /observer unavailable/);
  await handle.close();
});

test('context changes and malformed usage invalidate without exposing native errors or payloads', async () => {
  for (const method of ['thread/compacted', 'thread/settings/updated', 'model/rerouted', 'thread/closed', 'error', 'thread/tokenUsage/updated']) {
    const f = fixture(); const handle = await f.native.connect(target, event => f.events.push(event)); handle.listen();
    f.emit(method, { turnId, error: { message: 'private secret' }, tokenUsage: { total: usage, last: { ...usage, inputTokens: '100' } } });
    assert.equal(f.events.length, 1); assert.equal(f.events[0].type, 'invalidated');
    assert(!JSON.stringify(f.events).includes('secret'));
    await handle.close();
  }
});

test('native disconnect invalidates while intentional close remains silent', async () => {
  const f = fixture(); const handle = await f.native.connect(target, event => f.events.push(event)); handle.listen();
  f.client.emit('disconnected');
  assert.deepEqual(f.events, [{ type: 'invalidated', reason: 'disconnected' }]);
  await handle.close(); assert.equal(f.events.length, 1);
});

test('changed metadata between initial and final preflight prevents rejoin', async () => {
  let reads = 0;
  const f = fixture({ request(method, params, client, thread) { if (method === 'thread/read' && ++reads === 2) thread.reasoningEffort = 'high'; } });
  await assert.rejects(f.native.connect(target, () => {}), /context changed before rejoin/);
  assert(!f.calls.some(x => x.method === 'thread/resume'));
});

test('first matching settings snapshot and unchanged repeated snapshots do not invalidate', async () => {
  const f = fixture({ thread: { reasoningEffort: null } });
  const handle = await f.native.connect(target, event => f.events.push(event)); handle.listen();
  const snapshot = { ...structuredClone(settings), summary: 'concise' };
  f.emit('thread/settings/updated', { threadSettings: snapshot });
  f.emit('thread/settings/updated', { threadSettings: structuredClone(snapshot) });
  assert.deepEqual(f.events, []);
  assert.equal((await handle.inspect()).effort, 'native-default');
  const owner = await handle.preflight(); owner.close(); await handle.close();
});

test('canonical settings hashes ignore object-key and set-like list ordering', async () => {
  const snapshot = { ...structuredClone(settings), disabledPluginIds: ['plugin-b', 'plugin-a'],
    approvalPolicy: { granular: { sandbox_approval: false, rules: true, skill_approval: true, request_permissions: false, mcp_elicitations: true } },
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/tmp/b', '/tmp/a'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: false },
    activePermissionProfile: { id: ':workspace', extends: null },
  };
  const f = fixture({ settings: snapshot }); const handle = await f.native.connect(target, event => f.events.push(event)); handle.listen();
  f.emit('thread/settings/updated', { threadSettings: snapshot });
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])])) : value;
  const reordered = reverseKeys(snapshot);
  reordered.disabledPluginIds.reverse(); reordered.sandboxPolicy.writableRoots.reverse();
  f.emit('thread/settings/updated', { threadSettings: reordered });
  assert.deepEqual(f.events, []); await handle.close();
});

test('first settings snapshot must match confirmed identity, effort and resume permissions', async () => {
  for (const change of [
    { model: 'other-model' }, { modelProvider: 'other-provider' }, { cwd: '/tmp/other' }, { effort: 'high' },
    { disabledPluginIds: ['a-plugin'] }, { approvalPolicy: 'on-request' },
    { approvalsReviewer: 'auto_review' }, { sandboxPolicy: { type: 'readOnly', networkAccess: false } },
    { activePermissionProfile: { id: ':workspace', extends: null } },
    { collaborationMode: { mode: 'default', settings: { ...settings.collaborationMode.settings, model: 'other-model' } } },
  ]) {
    const f = fixture(); const handle = await f.native.connect(target, event => f.events.push(event)); handle.listen();
    f.emit('thread/settings/updated', { threadSettings: { ...structuredClone(settings), ...change } });
    assert.deepEqual(f.events, [{ type: 'invalidated', reason: 'settings-changed' }]);
    await assert.rejects(handle.preflight(), /observer unavailable/); await handle.close();
  }
});

test('later summary, personality, developer instruction and custom delegation changes invalidate without content', async () => {
  const snapshot = { ...structuredClone(settings), multiAgentMode: { custom: 'PRIVATE_INITIAL_DELEGATION' },
    collaborationMode: { mode: 'default', settings: { ...settings.collaborationMode.settings, developer_instructions: 'PRIVATE_INITIAL_INSTRUCTION' } } };
  for (const change of [
    { summary: 'detailed' }, { personality: 'friendly' }, { multiAgentMode: { custom: 'PRIVATE_CHANGED_DELEGATION' } },
    { collaborationMode: { mode: 'default', settings: { ...snapshot.collaborationMode.settings, developer_instructions: 'PRIVATE_CHANGED_INSTRUCTION' } } },
  ]) {
    const f = fixture({ settings: snapshot }); const handle = await f.native.connect(target, event => f.events.push(event)); handle.listen();
    f.emit('thread/settings/updated', { threadSettings: structuredClone(snapshot) });
    assert.deepEqual(f.events, []);
    f.emit('thread/settings/updated', { threadSettings: { ...structuredClone(snapshot), ...change } });
    assert.deepEqual(f.events, [{ type: 'invalidated', reason: 'settings-changed' }]);
    assert(!JSON.stringify({ state: handle.state, events: f.events }).includes('PRIVATE_'));
    await handle.close();
  }
});

test('settings snapshots arriving before the resume result are compared after its baseline arrives', async () => {
  const f = fixture({ request(method, _params, client) {
    if (method === 'thread/resume') {
      client.emit('notification', { method: 'thread/settings/updated', params: { threadId: sessionId, threadSettings: structuredClone(settings) } });
      client.emit('notification', { method: 'thread/settings/updated', params: { threadId: sessionId, threadSettings: structuredClone(settings) } });
    }
  } });
  const handle = await f.native.connect(target, event => f.events.push(event)); handle.listen();
  assert.deepEqual(f.events, []);
  f.emit('thread/settings/updated', { threadSettings: { ...structuredClone(settings), summary: 'auto' } });
  assert.deepEqual(f.events, [{ type: 'invalidated', reason: 'settings-changed' }]);
  await handle.close();
});

test('changed early snapshots, malformed core and unknown settings fail closed before listening', async () => {
  for (const snapshots of [
    [{ ...structuredClone(settings), approvalPolicy: 'on-request' }],
    [structuredClone(settings), { ...structuredClone(settings), summary: 'detailed' }],
    [{ ...structuredClone(settings), unexpectedField: 'PRIVATE_UNKNOWN' }],
    [{ ...structuredClone(settings), collaborationMode: null }],
  ]) {
    const f = fixture({ request(method, _params, client) {
      if (method === 'thread/resume') for (const threadSettings of snapshots)
        client.emit('notification', { method: 'thread/settings/updated', params: { threadId: sessionId, threadSettings } });
    } });
    await assert.rejects(f.native.connect(target, event => f.events.push(event)), /settings invalidated/);
    assert.equal(f.closes(), 1); assert.deepEqual(f.events, []);
  }
  const f = fixture({ settings: { ...structuredClone(settings), approvalPolicy: 'unsupported-policy' } });
  await assert.rejects(f.native.connect(target, () => {}), /invalid-native-settings/);
});

test('a settings change during awaited inspection cannot return an apparently usable handle', async () => {
  let armed = false;
  const f = fixture({ request(method, _params, client) {
    if (armed && method === 'thread/read') client.emit('notification', {
      method: 'thread/settings/updated', params: { threadId: sessionId, threadSettings: { ...settings, effort: 'high' } },
    });
  } });
  const handle = await f.native.connect(target, event => f.events.push(event)); handle.listen();
  f.emit('thread/settings/updated', { threadSettings: structuredClone(settings) }); armed = true;
  await assert.rejects(handle.inspect(), /observer unavailable/);
  assert.deepEqual(f.events, [{ type: 'invalidated', reason: 'settings-changed' }]); await handle.close();
});

test('no observed settings snapshot can be mistaken for a dispatch-ready prompt baseline', async () => {
  const f = fixture(); const handle = await f.native.connect(target, event => f.events.push(event)); handle.listen();
  assert.equal(handle.settingsReady, false);
  const preflights = f.ownerCloses();
  await assert.rejects(handle.preflight(), /native-settings-unobserved/);
  await assert.rejects(handle.inspect(), /native-settings-unobserved/);
  assert.equal(f.ownerCloses(), preflights);
  assert.deepEqual(f.events, []);
  f.emit('thread/settings/updated', { threadSettings: structuredClone(settings) });
  assert.equal(handle.settingsReady, true);
  const owner = await handle.preflight(); owner.close(); await handle.close();
});

test('first snapshot may resolve default instructions and effort; later instruction changes still invalidate', async () => {
  const resolved = { ...structuredClone(settings), effort: 'high', summary: 'detailed', personality: 'none',
    collaborationMode: { mode: 'default', settings: { model: settings.model, reasoning_effort: 'high', developer_instructions: 'PRIVATE_RESOLVED_DEFAULT_INSTRUCTIONS' } } };
  for (const resumeEffort of [null, 'medium']) {
    const f = fixture({ thread: { reasoningEffort: null }, settings: { ...structuredClone(settings), effort: resumeEffort } });
    const handle = await f.native.connect(target, event => f.events.push(event)); handle.listen();
    f.emit('thread/settings/updated', { threadSettings: structuredClone(resolved) });
    assert.equal(handle.settingsReady, true); assert.deepEqual(f.events, []);
    const owner = await handle.preflight(); owner.close();
    f.emit('thread/settings/updated', { threadSettings: structuredClone(resolved) });
    assert.deepEqual(f.events, []);
    f.emit('thread/settings/updated', { threadSettings: { ...resolved,
      collaborationMode: { ...resolved.collaborationMode, settings: { ...resolved.collaborationMode.settings, developer_instructions: 'PRIVATE_CHANGED_INSTRUCTIONS' } } } });
    assert.deepEqual(f.events, [{ type: 'invalidated', reason: 'settings-changed' }]);
    assert.equal(handle.settingsReady, false);
    assert(!JSON.stringify(f.events).includes('PRIVATE_')); await handle.close();
  }
});

test('an early resolved snapshot waits for the resume permission baseline without losing its full fingerprint', async () => {
  const resolved = { ...structuredClone(settings), summary: 'auto', collaborationMode: {
    mode: 'default', settings: { ...settings.collaborationMode.settings, developer_instructions: 'PRIVATE_RESOLVED_DEFAULT' },
  } };
  const f = fixture({ request(method, _params, client) {
    if (method === 'thread/resume') client.emit('notification', {
      method: 'thread/settings/updated', params: { threadId: sessionId, threadSettings: resolved },
    });
  } });
  const handle = await f.native.connect(target, event => f.events.push(event)); handle.listen();
  assert.equal(handle.settingsReady, true); assert.deepEqual(f.events, []);
  f.emit('thread/settings/updated', { threadSettings: structuredClone(resolved) });
  assert.deepEqual(f.events, []); await handle.close();
});
