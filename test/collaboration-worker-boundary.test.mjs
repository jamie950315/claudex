import test from 'node:test';
import assert from 'node:assert/strict';
import { attachWorkerBoundary } from '../src/collaboration-worker-boundary.mjs';

const original = () => ({ content: [{ type: 'text', text: JSON.stringify({ taskId: 'child-id', status: 'running', resultFinal: false }) }] });
const receipt = extra => ({ taskId: 'worker-own-id', revision: 12, status: 'running', owner: 'claude',
  instructions: [{ instructionId: 'followup-1', text: 'Please explain the next step before editing.', from: 'parent-id',
    provenance: 'managed-parent', generation: 3, deliveryProvenance: 'worker-check-in' }], hasMore: false, pause: null, ...extra });
const options = extra => ({ enabled: true, method: 'status', params: { taskId: 'child-id' }, result: original(),
  requestId: 'boundary-one', responseId: 17, callCheckIn: async () => receipt(), ...extra });

test('worker response boundary delivers exact follow-up without altering the original read result', async () => {
  const result = original(), before = JSON.stringify(result);
  let request;
  const combined = await attachWorkerBoundary(options({ result, callCheckIn: async value => { request = value; return receipt(); } }));
  assert.equal(JSON.stringify(result), before, 'the original read remains pure');
  assert.deepEqual(combined.content[0], result.content[0]);
  assert.deepEqual(Object.keys(request).sort(), ['limit', 'requestId', 'responseBudgetBytes']);
  assert.equal(request.limit, 8);
  assert.equal(request.responseBudgetBytes, 192 * 1024);
  const delivered = JSON.parse(combined.content[1].text).workerInstructionIntake;
  assert.equal(delivered.taskId, 'worker-own-id', 'never reuse the child task ID from a status query');
  assert.equal(delivered.instructions[0].text, receipt().instructions[0].text);
  assert.equal(delivered.state, 'delivered-context');
  assert.match(delivered.note, /not adoption or completion/);
  assert.equal(delivered.instructions[0].state, undefined, 'no synthetic adoption');
});

test('controller endpoints never perform automatic instruction intake', async () => {
  const result = original();
  assert.equal(await attachWorkerBoundary(options({ enabled: false, result, callCheckIn: () => { throw new Error('must not call'); } })), result);
});

test('end-turn, cancellation, handoff, check-in and acknowledgement boundaries do not intake', async () => {
  const variants = [
    { method: 'handoff' }, { method: 'cancel' }, { method: 'worker_check_in' },
    ...['check-in', 'ack-instruction', 'checkpoint'].map(action => ({ method: 'work_control', params: { action } })),
    { result: { content: [{ type: 'text', text: '{"nextAction":"end-turn","finalResponse":"CLAUDEX_HANDOFF"}' }] } },
    { result: { content: [], structuredContent: { nextAction: 'end-turn' } } },
    { result: { ...original(), isError: true } },
  ];
  for (const variant of variants) {
    const input = options({ ...variant, callCheckIn: () => { throw new Error('must not call'); } });
    assert.equal(await attachWorkerBoundary(input), input.result);
  }
});

test('intake failure preserves original success, hides diagnostic secrets, and never retries', async () => {
  let calls = 0;
  const result = original();
  const combined = await attachWorkerBoundary(options({ result, callCheckIn: async () => {
    calls++; throw Object.assign(new Error('private capability: secret'), { stdout: 'private payload' });
  } }));
  assert.equal(calls, 1);
  assert.deepEqual(combined.content[0], result.content[0]);
  assert.equal(combined.isError, undefined);
  assert.equal(JSON.stringify(combined).includes('secret'), false);
  assert.equal(JSON.stringify(combined).includes('private payload'), false);
  const note = JSON.parse(combined.content[1].text).workerInstructionIntake;
  assert.equal(note.reason, 'broker-unavailable');
  assert.match(note.note, /do not repeat the original tool/);
});

test('the complete escaped frame budget is reserved before a mutating check-in', async () => {
  const result = { content: [{ type: 'text', text: '\\"'.repeat(1200) }] };
  let called = 0;
  const combined = await attachWorkerBoundary(options({ result, maxResponseBytes: 8192, callCheckIn: () => { called++; } }));
  assert.equal(called, 0);
  assert.deepEqual(combined.content[0], result.content[0]);
  assert.equal(JSON.parse(combined.content[1].text).workerInstructionIntake.reason, 'response-capacity');
  assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 17, result: combined }) + '\n') <= 8192);
});

test('bounded receipt budgets shrink to remaining frame capacity and retain exact pause context', async () => {
  let budget;
  const pause = { state: 'requested', generation: 3, reason: 'Pause after safe verification.' };
  const combined = await attachWorkerBoundary(options({ maxResponseBytes: 8192,
    callCheckIn: async value => { budget = value.responseBudgetBytes; return receipt({ instructions: [], pause }); } }));
  assert.ok(budget >= 1024 && budget < 8192 - 4096);
  assert.deepEqual(JSON.parse(combined.content[1].text).workerInstructionIntake.pause, pause);
});

test('empty intake preserves the response and unexpected top-level diagnostics are never copied', async () => {
  const result = original();
  assert.equal(await attachWorkerBoundary(options({ result, callCheckIn: async () => receipt({ instructions: [] }) })), result);
  const combined = await attachWorkerBoundary(options({ callCheckIn: async () => receipt({ token: 'private-capability' }) }));
  assert.equal(JSON.stringify(combined).includes('private-capability'), false);
});

test('child progress hints are delivered without claiming acknowledgement of child outcomes', async () => {
  const childProgress = [{ taskId: 'child-id', generation: 2, reportId: 'report-1', revision: 4, nextAction: 'read-child-status' }];
  const combined = await attachWorkerBoundary(options({ callCheckIn: async () => receipt({ instructions: [], childProgress }) }));
  assert.deepEqual(JSON.parse(combined.content[1].text).workerInstructionIntake.childProgress, childProgress);
  assert.equal(JSON.parse(combined.content[0].text).resultFinal, false);
});

test('broker response overflow or malformed receipt never overwrites or replays the original tool', async () => {
  for (const value of [null, { ...receipt(), hasMore: undefined }, receipt({ instructions: Array(9).fill({}) }),
    receipt({ instructions: [{ text: 'a'.repeat(16384) }] })]) {
    let calls = 0;
    const result = original();
    const combined = await attachWorkerBoundary(options({ result, maxResponseBytes: 8192, callCheckIn: async () => { calls++; return value; } }));
    assert.equal(calls, 1);
    assert.deepEqual(combined.content[0], result.content[0]);
    assert.equal(JSON.parse(combined.content[1].text).workerInstructionIntake.state, 'unavailable');
  }
});
