import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, shortJSON, usageLine, textChunks } from '../plugins/claudex/hooks/controller.mjs';
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
  const f = fixture({ nativeWake: true }); await f.controller.wakeList(f.api); f.controller.previewWake(f.api, ID); return f;
}
test('native queue delivery preserves a busy recipient and existing draft', async () => {
  const f = await wakeFixture(); f.draft('User text'); f.idle(false);
  await f.controller.acceptWake(f.api);
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(f.submissions[0].to, { sessionId: CTX.sessionId });
  assert.equal((await f.api.prompt()).text, 'User text');
});
test('successful exact queue delivery records acceptance separately from ACK', async () => {
  const f = await wakeFixture(); await f.controller.acceptWake(f.api);
  assert.equal(f.submissions.length, 1); assert.deepEqual(Object.keys(f.submissions[0]), ['to', 'text']);
  assert.deepEqual(f.submissions[0].to, { sessionId: CTX.sessionId });
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
test('native queue rejection records uncertainty and supplies no automatic retry', async () => {
  const f = await wakeFixture(); f.api.sendSession = async () => ({ isDelivered: false, reason: 'recipient policy' });
  await f.controller.acceptWake(f.api); await f.controller.acceptWake(f.api);
  assert.equal(f.calls.filter(call => call.op === 'wake-claim').length, 1);
  assert.equal(f.calls.find(call => call.op === 'wake-receipt').status, 'uncertain');
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
