import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, shortJSON, usageLine, textChunks, configurationDiagnostic, taskInventoryCount } from '../plugins/claudex/hooks/controller.mjs';
import { renderPanel } from '../plugins/claudex/hooks/panel.mjs';
import { translator } from '../plugins/claudex/hooks/localization.mjs';
const CTX = { sessionId: '11111111-1111-4111-8111-111111111111', cwd: '/fixture' };
const OTHER = { sessionId: '22222222-2222-4222-8222-222222222222', cwd: '/other' };
const ID = '33333333-3333-4333-8333-333333333333';
const CLAIM = '44444444-4444-4444-8444-444444444444';
function fixture(options = {}) {
  let current = { ...CTX }, worker = false, draft = '', idle = true;
  const calls = [], submissions = [], fills = [];
  const controller = createController(options);
  const api = {
    worker: async () => worker, context: async () => ({ ...current }), redraw: () => {},
    tools: async () => [{ name: 'SendMessage' }],
    usage: async () => ({ context: { percent: 53 }, rateLimits: [{ kind: 'five_hour', percentUsed: 20 }] }),
    version: async () => ({ version: '2.1.287' }), idle: async () => idle,
    prompt: async () => ({ text: draft }),
    fill: async args => { fills.push(args); draft += args.text; return { isFilled: true, text: draft }; },
    submit: async args => { submissions.push(args); },
    sendSession: async args => { submissions.push(args); return { isDelivered: true }; },
    bridge: async request => {
      calls.push(request);
      if (request.op === 'doctor') return { stopped: false, root: '/state', socketPresent: true };
      if (request.op === 'read' && request.method === 'list') return { tasks: [], limits: {} };
      if (request.op === 'read' && request.method === 'chat_list') return { chats: [], nextCursor: null };
      if (request.op === 'prepare') return { id: ID, state: 'prepared', method: request.method, params: request.params, context: request.context };
      if (request.op === 'commit') return { id: ID, state: 'completed', result: { id: 'task' } };
      if (request.op === 'receipt') return { id: ID, state: 'uncertain', context: request.context };
      if (request.op === 'wake-peek') return { messages: [{ messageId: ID, sessionId: CTX.sessionId, expiresAt: 10000 }] };
      if (request.op === 'wake-claim') return { claimed: true, claimId: CLAIM, messageId: ID, context: 'JSON-quoted peer data with original ACK instructions.' };
      if (request.op === 'wake-check') return { ready: true };
      if (request.op === 'wake-receipt') return { state: 'offered' };
      return { id: request.params?.taskId };
    },
  };
  return { controller, api, calls, submissions, fills, change: value => { current = value; },
    worker: value => { worker = value; }, draft: value => { draft = value; }, idle: value => { idle = value; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('unknown usage is explicit and known rate windows retain their names', () => {
  assert.equal(usageLine(null), 'Context unknown');
  assert.equal(usageLine({ context: { percent: 12 }, rateLimits: [{ kind: 'seven_day', percentUsed: 42 }] }), 'Context 12.0% | seven_day 42.0%');
  assert.equal(usageLine({ context: { percent: NaN }, rateLimits: [{ kind: 'five_hour', percentUsed: -1 }] }), 'Context unknown');
});
test('UI text chunks respect the native 10000-character child limit without loss', () => {
  const source = 'a'.repeat(7999) + '😀' + 'b'.repeat(21000);
  const chunks = textChunks(source);
  assert.equal(chunks.join(''), source); assert.ok(chunks.every(chunk => chunk.length <= 8000));
  assert.equal(chunks[0].length, 7999); assert.match(shortJSON({ text: source }), /truncated/);
});
test('status refresh performs only doctor/read and usage calls', async () => {
  const f = fixture(); await f.controller.refresh(f.api);
  assert.deepEqual(f.calls.map(call => call.op), ['doctor', 'read']);
  assert.equal(f.controller.state.usage.context.percent, 53); assert.equal(f.submissions.length, 0);
});

test('cache panel edits preview without mutation, confirms once and retains edits through read refresh', async () => {
  const f = fixture(), seen = [];
  f.api.cacheCommand = async (words, context) => {
    assert.deepEqual(context, CTX); seen.push(words);
    if (words[0] === 'status') return { nativeCache: { value: '1h' }, ttlPreference: { mode: 'session' }, local: { enabled: false } };
    if (words[0] === 'confirm') return { state: 'preference-saved' };
    return { state: 'confirmation-required', ...CTX, confirm: '/claudex warm confirm warm-fixture',
      effects: 'The complete native setting effects.', ttl: '5m' };
  };
  await f.controller.cacheRefresh(f.api);
  f.controller.cacheEdit(f.api, 'ttl', '5m'); f.controller.cacheEdit(f.api, 'mode', 'default');
  await f.controller.cacheRefresh(f.api);
  assert.deepEqual(f.controller.state.cacheForm, { ttl: '5m', mode: 'default' });
  await f.controller.cachePrepare(f.api, 'preference');
  assert.deepEqual(seen.at(-1), ['preference', 'default', 'ttl=5m']);
  assert.ok(!seen.some(words => words[0] === 'confirm'));
  await Promise.all([f.controller.cacheConfirm(f.api), f.controller.cacheConfirm(f.api)]);
  assert.equal(seen.filter(words => words[0] === 'confirm').length, 1);
  assert.equal(f.controller.state.cachePending, null);
  await f.controller.cachePrepare(f.api, 'ttl');
  await f.controller.cacheDiscard(f.api);
  assert.deepEqual(seen.at(-1), ['discard']);
});

test('cache confirmation does not dispatch into a changed controller context', async () => {
  const f = fixture(), seen = [];
  f.api.cacheCommand = async words => { seen.push(words); return { state: 'confirmation-required', ...CTX,
    confirm: '/claudex warm confirm warm-fixture' }; };
  await f.controller.cachePrepare(f.api, 'ttl');
  f.change(OTHER);
  await f.controller.cacheConfirm(f.api);
  assert.equal(seen.some(words => words[0] === 'confirm'), false);
});

test('work details use exact generation bounded read pages without acknowledgement or dispatch', async () => {
  const f = fixture();
  f.api.bridge = async request => {
    f.calls.push(request);
    if (request.method === 'status') return { id: 'task', generation: 3, children: [{ taskId: 'child', unread: true }] };
    if (request.method === 'work_events') return { events: [], cursor: 'events-cursor' };
    if (request.method === 'work_reports') return { reports: [], cursor: 'reports-cursor' };
    return { tasks: [] };
  };
  await f.controller.task(f.api, 'task');
  await f.controller.events(f.api); await f.controller.events(f.api, true);
  await f.controller.reports(f.api); await f.controller.reports(f.api, true);
  await f.controller.artifact(f.api, 'result.txt', 'diff');
  await f.controller.children(f.api, 'task');
  assert.ok(f.calls.every(call => call.op === 'read'));
  assert.equal(f.calls.find(call => call.method === 'artifact_read').params.view, 'diff');
  assert.equal(f.calls.find(call => call.method === 'artifact_read').params.maxBytes, 65536);
  assert.equal(f.calls.filter(call => call.method === 'work_events')[1].params.cursor, 'events-cursor');
  assert.equal(f.calls.filter(call => call.method === 'work_reports')[1].params.cursor, 'reports-cursor');
  assert.ok(f.calls.filter(call => ['work_events', 'work_reports', 'artifact_read'].includes(call.method)).every(call => call.params.generation === 3));
  assert.equal(f.controller.state.detail.children[0].unread, true);
  await f.controller.task(f.api, 'task');
  assert.equal(f.controller.state.events, null); assert.equal(f.controller.state.reports, null);
  assert.equal(f.submissions.length, 0);
});

test('work panel renders evidence and pause boundary honestly in every locale without mutations', async () => {
  const f = fixture(); await f.controller.bind(f.api);
  const state = f.controller.state;
  Object.assign(state, { tab: 'detail', selectedTask: 'task', detail: { id: 'task', generation: 2, owner: 'codex', status: 'running',
    objective: 'User objective', execution: { activity: { lastNativeEventAt: 1000, models: { main: [] } } },
    progress: { stage: 'Review', lastReportedAt: 2000, current: true },
    children: [{ taskId: 'child', status: 'completed', unread: true }],
    blockers: [{ id: 'block', current: true, generation: 2, state: 'open', question: 'A question', impact: 'Wait', needs: 'Decision' }],
    instructions: [{ id: 'instruction', generation: 2, state: 'delivered', deliveryProvenance: 'broker-context' }],
    outcome: { summary: 'Worker summary', artifacts: [{ kind: 'file', reference: 'result.txt' }] } },
    events: { cursor: 'cursor', events: [{ sequence: 1, source: 'native:codex', kind: 'assistant-message', text: 'Public work output', at: 1000 }], collection: { status: 'collecting' } } });
  const ui = Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Select'].map(type => [type, props => ({ type, props })]));
  for (const language of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'es', 'de', 'fr', 'it']) {
    const tree = renderPanel({ ui, state, controller: f.controller, host: () => f.api, options: {}, wake: { state: {} }, t: translator(language), language, setLanguage: () => {} });
    const source = JSON.stringify(tree);
    for (const value of ['User objective', 'Worker summary', 'Public work output', '1970-01-01T00:00:01.000Z', 'task-pause', 'reports-start', 'events-start', 'broker-context']) assert.ok(source.includes(value), `${language}: ${value}`);
    assert.ok(source.includes(translator(language)('Included in invocation context')));
    assert.ok(source.includes(translator(language)('Unread result')));
    assert.ok(!source.includes('task-reviewed'), 'running work has no result acceptance action');
  }
  assert.equal(f.calls.length, 0); assert.equal(f.submissions.length, 0);
});

test('historical reads and artifact inspections retain their exact declaration generation', async () => {
  const f = fixture();
  f.api.bridge = async request => {
    f.calls.push(request);
    if (request.method === 'status') return { id: 'task', generation: 3,
      outcome: { generation: 2, artifacts: [{ kind: 'file', reference: 'previous.txt' }] } };
    return { cursor: 'cursor', generation: request.params.generation };
  };
  await f.controller.task(f.api, 'task');
  await f.controller.artifact(f.api, 'previous.txt');
  assert.equal(f.calls.at(-1).params.generation, 2);
  f.controller.generation(f.api, '1');
  await f.controller.events(f.api, false, true);
  await f.controller.reports(f.api, false, true);
  assert.ok(f.calls.slice(-2).every(call => call.params.generation === 1 && call.params.recent === undefined));
  await f.controller.artifact(f.api, 'historic.txt', 'diff', 1);
  assert.equal(f.calls.at(-1).params.generation, 1);
  f.controller.generation(f.api, '4'); assert.equal(f.controller.state.workGeneration, 1);
  f.controller.generation(f.api, '2');
  assert.equal(f.controller.state.events, null); assert.equal(f.controller.state.reports, null);
  await f.controller.task(f.api, 'task');
  assert.equal(f.controller.state.workGeneration, 2, 'exact-task refresh preserves a valid historical selection');
  const calls = f.calls.length;
  await f.controller.artifact(f.api, 'future.txt', 'diff', 4);
  assert.equal(f.calls.length, calls);
  assert.ok(f.calls.every(call => call.op === 'read'));
});

test('known work states are localized and unavailable intervention buttons stay hidden', async () => {
  const f = fixture(); await f.controller.bind(f.api);
  const state = f.controller.state;
  const task = { id: 'task', generation: 2, owner: 'codex', status: 'running',
    blockers: [{ id: 'block', current: true, generation: 2, state: 'responded', question: 'Question', impact: 'Impact', needs: 'Decision' }],
    pause: { state: 'requested' }, resultReview: { state: 'integrated' } };
  Object.assign(state, { tab: 'detail', selectedTask: 'task', detail: task });
  const ui = Object.fromEntries(['Box', 'Text', 'Button', 'Input', 'Select'].map(type => [type, props => ({ type, props })]));
  const render = language => JSON.stringify(renderPanel({ ui, state, controller: f.controller, host: () => f.api,
    options: {}, wake: { state: {} }, t: translator(language), language, setLanguage: () => {} }));
  for (const language of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'es', 'de', 'fr', 'it']) {
    let source = render(language);
    for (const label of ['Responded', 'Requested', 'Integrated']) assert.ok(source.includes(translator(language)(label)), `${language}: ${label}`);
    assert.ok(!source.includes('respond-block')); assert.ok(source.includes('resolve-block'));
    for (const [value, label] of [['checkpoint', 'Checkpoint acknowledged'], ['paused', 'Paused'], ['resumed', 'Resumed'], ['cancelled', 'Cancelled'], ['not-paused', 'Not paused']]) {
      task.pause.state = value; source = render(language); assert.ok(source.includes(translator(language)(label)), `${language}: ${value}`);
    }
    task.pause.state = 'requested';
  }
  task.blockers[0].state = 'open'; task.pause = null;
  assert.ok(render('en').includes('respond-block'));
  for (const fence of [{ status: 'failed' }, { status: 'cancelled' }, { status: 'uncertain' },
    { phase: 'handoff-pending' }, { cancelRequested: true }, { cancelPending: true }, { pause: { state: 'checkpoint' } }]) {
    const before = { ...task }; Object.assign(task, fence);
    const source = render('en');
    for (const key of ['respond-block', 'resolve-block', 'task-pause', 'task-resume', 'task-followup', 'task-reviewed', 'task-integrated']) assert.ok(!source.includes(key), `${JSON.stringify(fence)}: ${key}`);
    Object.keys(task).forEach(key => { delete task[key]; }); Object.assign(task, before);
  }
  task.blockers[0].state = 'vendor-new-state';
  assert.ok(render('zh-Hant').includes('vendor-new-state'));
  assert.ok(!render('zh-Hant').includes('resolve-block'));
  assert.equal(f.calls.length, 0);
});
test('configuration diagnostics retain only exact non-sensitive option values and explicit types', () => {
  const result = configurationDiagnostic({ options: { nativeWake: true, selfWake: 'false', secret: 'NEVER_COPY' },
    plugin: { name: 'claudex', root: '/private/plugin' }, layers: {
      user: { env: { TOKEN: 'NEVER_COPY' }, pluginConfigs: {
        'claudex@claudex-local': { options: { nativeWake: 'true', selfWake: false, token: 'NEVER_COPY' } },
        'claudex@inline': { options: { nativeWake: true, selfWake: true, token: 'NEVER_COPY' } },
        'unrelated@other': { options: { nativeWake: 'NEVER_COPY' } },
      } }, flag: null, policy: { pluginConfigs: { 'claudex@claudex-local': { options: { nativeWake: 'NEVER_COPY' } } } },
    } });
  assert.deepEqual(result.registration, { nativeWake: { type: 'boolean', value: true }, selfWake: { type: 'string', value: 'false' } });
  assert.equal(result.settings.user.present, true); assert.equal(result.settings.user.nativeWake.value, 'true');
  assert.equal(result.inlineConfigKey, 'claudex@inline');
  assert.deepEqual(result.inlineSettings.user.nativeWake, { type: 'boolean', value: true });
  assert.deepEqual(result.settings.flag, { available: false });
  assert.deepEqual(result.settings.policy.nativeWake, { type: 'string' });
  assert.deepEqual(result.settings.policy.selfWake, { type: 'undefined' });
  assert.doesNotMatch(JSON.stringify(result), /NEVER_COPY|unrelated|TOKEN/);
  assert.equal(configurationDiagnostic({ plugin: { root: '/' + 'x'.repeat(5000) } }).plugin.root, null);
  assert.ok(JSON.stringify(result).length < 2000);
});
test('bounded task inventory counts distinguish loaded page from broker total', () => {
  const tasks = Array.from({ length: 100 }, () => ({}));
  assert.equal(taskInventoryCount({ tasks, totalCount: 133, nextCursor: '100' }), '100 / 133');
  assert.equal(taskInventoryCount({ tasks, totalCount: 100, nextCursor: null }), '100');
  assert.equal(taskInventoryCount({ tasks, totalCount: 133 }), '100 / 133');
  assert.equal(taskInventoryCount({ tasks, nextCursor: '100' }), '100 / ?');
  assert.equal(taskInventoryCount({ tasks }), '100');
});
test('configuration diagnostics remain visible if helper inspection fails but never cross session boundaries', async () => {
  const f = fixture(), diagnostics = { diagnosticOnly: true, registration: { nativeWake: { type: 'boolean', value: false } } };
  f.api.configuration = async () => diagnostics;
  f.api.bridge = async () => { throw new Error('Helper unavailable'); };
  await f.controller.refresh(f.api); assert.deepEqual(f.controller.state.configuration, diagnostics);
  assert.equal(f.submissions.length, 0);
  let release;
  f.api.configuration = () => new Promise(resolve => { release = resolve; });
  const refreshing = f.controller.refresh(f.api); await tick();
  f.change(OTHER); await f.controller.bind(f.api); release(diagnostics); await refreshing;
  assert.equal(f.controller.state.configuration, null);
});
test('stopped application does not query broker task inventory', async () => {
  const f = fixture(); f.api.bridge = async request => { f.calls.push(request); return { stopped: true }; };
  await f.controller.refresh(f.api); assert.deepEqual(f.calls.map(call => call.op), ['doctor']);
});
test('managed workers have no companion calls or retained UI data', async () => {
  const f = fixture(); f.worker(true);
  await f.controller.refresh(f.api); assert.equal(f.calls.length, 0); assert.equal(f.controller.state.enabled, false);
});
test('prepare never commits and shows the exact pending body', async () => {
  const f = fixture(); await f.controller.prepareJSON(f.api, '{"method":"cancel","params":{"taskId":"job"}}');
  assert.equal(f.controller.state.pending.id, ID); assert.equal(f.controller.state.tab, 'confirm');
  assert.deepEqual(f.calls.map(call => call.op), ['prepare']);
});
test('invalid action JSON never reaches the helper', async () => {
  const f = fixture();
  for (const raw of ['{', '{"method":"start"}', '{"method":"start","params":{},"extra":true}']) {
    await f.controller.prepareJSON(f.api, raw); assert.ok(f.controller.state.error);
  }
  assert.equal(f.calls.length, 0);
});
test('locked previews never produce a confirm button', async () => {
  const f = fixture(); f.api.bridge = async () => ({ state: 'locked' });
  await f.controller.prepare(f.api, 'cancel', { taskId: 'job' });
  assert.equal(f.controller.state.pending, null); assert.match(f.controller.state.error, /locked/);
});
test('oversized complete preview stays uncommitted', async () => {
  const f = fixture(); f.api.bridge = async request => ({ id: ID, state: 'prepared', context: request.context, params: { prompt: 'x'.repeat(20001) } });
  await f.controller.prepare(f.api, 'start', {});
  assert.equal(f.controller.state.pending, null); assert.match(f.controller.state.error, /bound/);
});
test('double confirmation dispatches once', async () => {
  const f = fixture(); await f.controller.prepare(f.api, 'cancel', { taskId: 'job' });
  await Promise.all([f.controller.commit(f.api), f.controller.commit(f.api)]);
  assert.equal(f.calls.filter(call => call.op === 'commit').length, 1); assert.equal(f.controller.state.pending, null);
});
test('unknown commit blocks further UI actions and retains receipt ID', async () => {
  const f = fixture(); await f.controller.prepare(f.api, 'cancel', { taskId: 'job' });
  f.api.bridge = async () => { throw new Error('timeout'); };
  await f.controller.commit(f.api);
  assert.equal(f.controller.state.lastReceipt.state, 'uncertain'); assert.equal(f.controller.state.lastReceipt.id, ID);
  await f.controller.prepare(f.api, 'cancel', { taskId: 'other' });
  assert.match(f.controller.state.error, /uncertain/); assert.equal(f.controller.state.pending, null);
});
test('reading a receipt does not invoke commit or retry', async () => {
  const f = fixture(); await f.controller.receipt(f.api, ID);
  assert.deepEqual(f.calls.map(call => call.op), ['receipt']); assert.equal(f.controller.state.lastReceipt.state, 'uncertain');
});
test('session change before commit invalidates old preview', async () => {
  const f = fixture(); await f.controller.prepare(f.api, 'cancel', { taskId: 'job' });
  f.change({ ...OTHER }); await f.controller.commit(f.api);
  assert.equal(f.calls.filter(call => call.op === 'commit').length, 0); assert.equal(f.controller.state.pending, null);
});
test('cwd change within the same native session invalidates old preview', async () => {
  const f = fixture(); await f.controller.prepare(f.api, 'cancel', { taskId: 'job' });
  f.change({ ...CTX, cwd: '/changed' }); await f.controller.commit(f.api);
  assert.equal(f.calls.filter(call => call.op === 'commit').length, 0);
});
test('delayed result cannot populate a different session', async () => {
  const f = fixture(); let release;
  f.api.bridge = async () => new Promise(resolve => { release = resolve; });
  const pending = f.controller.task(f.api, 'old-job'); await tick();
  f.change({ ...OTHER }); await f.controller.bind(f.api);
  release({ privateOldTask: true }); await pending;
  assert.equal(f.controller.state.selectedTask, null); assert.equal(f.controller.state.detail, null);
});
test('chat search preserves cursor and does not auto-select duplicate titles', async () => {
  const f = fixture(); f.api.bridge = async request => {
    f.calls.push(request); return { chats: [{ title: 'Same', sessionId: CTX.sessionId }, { title: 'Same', sessionId: OTHER.sessionId }], nextCursor: '12' };
  };
  await f.controller.searchChats(f.api, 'Same', '0');
  assert.equal(f.controller.state.chats.chats.length, 2); assert.equal(f.controller.state.pending, null);
  assert.equal(f.calls[0].params.cursor, '0'); assert.equal(f.calls[0].params.match, 'contains');
});
test('handoff draft appends to existing user text and never starts inference', async () => {
  const f = fixture(); f.draft('My existing draft.');
  await f.controller.handoffDraft(f.api);
  assert.equal(f.fills[0].mode, 'append'); assert.equal(f.submissions.length, 0); assert.equal(f.calls.length, 0);
  assert.match(f.fills[0].text, /CLAUDEX_HANDOFF/);
});
test('native receipt has an independent opt-in', async () => {
  const f = fixture(); await f.controller.wakeList(f.api);
  assert.equal(f.calls.length, 0); assert.match(f.controller.state.error, /disabled/);
});
async function wakeFixture() {
  const f = fixture({ nativeWake: true }); await f.controller.wakeList(f.api, OTHER); f.controller.previewWake(f.api, ID); return f;
}
test('native queue delivery preserves a busy recipient and existing draft', async () => {
  const f = await wakeFixture(); f.draft('User text'); f.idle(false);
  await f.controller.acceptWake(f.api);
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(f.submissions[0].to, { sessionId: OTHER.sessionId });
  assert.equal((await f.api.prompt()).text, 'User text');
});
test('successful exact queue delivery records acceptance separately from ACK', async () => {
  const f = await wakeFixture(); await f.controller.acceptWake(f.api);
  assert.equal(f.submissions.length, 1); assert.deepEqual(Object.keys(f.submissions[0]), ['to', 'text']);
  assert.deepEqual(f.submissions[0].to, { sessionId: OTHER.sessionId });
  const receipt = f.calls.find(call => call.op === 'wake-receipt');
  assert.equal(receipt.status, 'accepted'); assert.equal(receipt.context.sessionId, CTX.sessionId);
  assert.equal(f.controller.state.wakes.length, 0);
});
test('competing wake consumer is never submitted again', async () => {
  const f = await wakeFixture(); const base = f.api.bridge;
  f.api.bridge = async request => request.op === 'wake-claim' ? { claimed: false } : base(request);
  await f.controller.acceptWake(f.api); assert.equal(f.submissions.length, 0);
});
test('session change after claim preserves uncertainty and original receipt identity', async () => {
  const f = await wakeFixture(), base = f.api.bridge;
  f.api.bridge = async request => {
    const result = await base(request); if (request.op === 'wake-claim') f.change({ ...OTHER }); return result;
  };
  await f.controller.acceptWake(f.api);
  assert.equal(f.submissions.length, 0);
  const receipt = f.calls.find(call => call.op === 'wake-receipt');
  assert.equal(receipt.status, 'uncertain'); assert.equal(receipt.context.sessionId, CTX.sessionId);
});
test('proven native refusal is recorded as rejected without automatic retry', async () => {
  const f = await wakeFixture(); f.api.sendSession = async () => ({ isDelivered: false, reason: 'recipient policy' });
  await f.controller.acceptWake(f.api); await f.controller.acceptWake(f.api);
  assert.equal(f.calls.filter(call => call.op === 'wake-claim').length, 1);
  assert.equal(f.calls.find(call => call.op === 'wake-receipt').status, 'rejected');
});
test('post-submission receipt error leaves no active submit button', async () => {
  const f = await wakeFixture(), base = f.api.bridge;
  f.api.bridge = async request => { if (request.op === 'wake-receipt') throw new Error('receipt lost'); return base(request); };
  await f.controller.acceptWake(f.api); await f.controller.acceptWake(f.api);
  assert.equal(f.submissions.length, 1); assert.equal(f.controller.state.wakePreview, null);
});

test('selected recipient stays explicit and separate from controller identity', async () => {
  const f = fixture({ nativeWake: true });
  await f.controller.wakeList(f.api, { ...OTHER });
  f.controller.previewWake(f.api, ID);
  await f.controller.acceptWake(f.api);
  assert.deepEqual(f.submissions[0].to, { sessionId: OTHER.sessionId });
  const receipt = f.calls.find(call => call.op === 'wake-receipt');
  assert.equal(receipt.context.sessionId, CTX.sessionId);
  assert.equal(receipt.target.sessionId, OTHER.sessionId);
});
test('native exception never clears or rewrites the original draft', async () => {
  const f = await wakeFixture(); f.draft('My unsent work');
  f.api.sendSession = async () => { throw new Error('native transport'); };
  await f.controller.acceptWake(f.api);
  assert.equal((await f.api.prompt()).text, 'My unsent work');
  assert.equal(f.calls.find(call => call.op === 'wake-receipt').status, 'uncertain');
});
