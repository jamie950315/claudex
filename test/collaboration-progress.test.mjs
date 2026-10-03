import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CollaborationHub } from '../src/collaboration-hub.mjs';
import { validateOutcome } from '../src/collaboration-outcome.mjs';
import { queryWorkReports } from '../src/collaboration-progress.mjs';
import { serveCollaborationSocket, callCollaboration } from '../src/collaboration-transport.mjs';

test('new reports on legacy tasks are collected independently of an absent public timeline', () => {
  const task = { id: 'legacy-task', generation: 2 };
  assert.equal(queryWorkReports(task, { generation: 2 }).collection, 'not-collected');
  task.reportHistory = [{ generation: 2, summary: 'New explicit report', provenance: 'worker-self-reported' }];
  const page = queryWorkReports(task, { generation: 2 });
  assert.equal(page.collection, 'collected');
  assert.equal(page.reports.length, 1);
  assert.equal(task.workEvents, undefined);
});

async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(5); }
  throw new Error('Synthetic work did not settle.');
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cldx-progress-'))); await chmod(root, 0o700);
  const invocations = [];
  const run = async args => new Promise((resolve, reject) => {
    invocations.push({ ...args, packet: JSON.parse(args.prompt.slice(args.prompt.lastIndexOf('\n') + 1)), finish: resolve, fail: reject });
    args.signal.addEventListener('abort', () => resolve({ text: 'Stopped synthetic invocation.' }), { once: true });
  });
  const hub = await new CollaborationHub({ root, run, mcp: async ({ token }) => ({ token }) }).initialize();
  hub.schedule = () => {};
  t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
  const call = (method, params, invocation) => hub.dispatch({ method, params, peer: invocation?.provider ?? 'codex', token: invocation?.mcp.token ?? hub.controllerToken });
  const start = extra => call('start', { requestId: `start-${invocations.length}-${Object.keys(hub.state.tasks).length}`, provider: 'codex', cwd: root, prompt: 'Synthetic scoped work', ...extra });
  const launch = async () => { const count = invocations.length; await hub.pump(); await until(() => invocations.length > count); return invocations.at(-1); };
  return { root, run, hub, call, start, launch, invocations };
}
const report = extra => ({ outcome: 'partial', summary: 'A verified implementation checkpoint', stage: 'validation', next: 'Run focused checks',
  checks: [{ name: 'focused check', result: 'passed', at: 123 }], artifacts: [], remaining: ['Native acceptance'], ...extra });

test('opt-in policy and complete report history are bounded, incremental, and read-only', async t => {
  const { hub, call, start, launch } = await fixture(t);
  await assert.rejects(start({ observability: { timeline: 'everything' } }), { code: 'CLAUDEX_INVALID_OBSERVABILITY' });
  await assert.rejects(start({ observability: { blockerNotifications: true } }), { code: 'CLAUDEX_ORIGIN_UNAVAILABLE' });
  const task = await start({ observability: { reports: 'milestones' } }); const invocation = await launch();
  assert.match(invocation.prompt, /Milestone reporting is enabled/);
  assert.equal(invocation.onWorkEvent, undefined);
  for (let i = 0; i < 3; i++) await call('report', { requestId: `report-${i}`, taskId: task.taskId, report: report({ summary: `Checkpoint ${i}` }) }, invocation);
  const before = structuredClone(hub.state);
  const first = await call('work_reports', { taskId: task.taskId, generation: 1, limit: 2 });
  const second = await call('work_reports', { taskId: task.taskId, generation: 1, cursor: first.cursor });
  assert.equal(first.reports.length, 2); assert.equal(first.hasMore, true); assert.equal(second.reports.length, 1);
  assert.equal(first.reports[0].checks[0].result, 'passed'); assert.equal(first.reports[0].provenance, 'worker-self-reported');
  const events = await call('work_events', { taskId: task.taskId, generation: 1 });
  assert.equal(events.events.filter(event => event.kind === 'report').length, 3); assert.equal(events.collection.public, 'off');
  assert.equal((await call('status', { taskId: task.taskId })).reportHistory, undefined);
  assert.deepEqual(hub.state, before);
  await assert.rejects(call('work_reports', { taskId: task.taskId, generation: 0, cursor: first.cursor }), { code: 'CLAUDEX_INVALID_CURSOR' });
  assert.throws(() => validateOutcome(report({ checks: [{ name: 'raw tool', result: 'passed', stdout: 'forbidden' }] })), { code: 'CLAUDEX_INVALID_OUTCOME' });
});

test('blocker responses are exact-generation decisions and instruction adoption is worker evidence', async t => {
  const { hub, call, start, launch } = await fixture(t);
  const task = await start(); const invocation = await launch();
  const blocked = report({ outcome: 'needs-input', blocker: { id: 'choose-target', question: 'Which target?', impact: 'Cannot validate the target', needs: 'Choose a target' } });
  await call('report', { requestId: 'blocked-1', taskId: task.taskId, report: blocked }, invocation);
  await call('report', { requestId: 'blocked-2', taskId: task.taskId, report: blocked }, invocation);
  assert.equal(hub.state.tasks[task.taskId].blockers.length, 1); assert.equal(hub.state.tasks[task.taskId].blockers[0].revision, 1);
  await assert.rejects(call('work_control', { requestId: 'stale', taskId: task.taskId, generation: 0, action: 'respond-blocker', blockerId: 'choose-target', text: 'A' }), { code: 'CLAUDEX_STALE_GENERATION' });
  const response = await call('work_control', { requestId: 'decision', taskId: task.taskId, generation: 1, action: 'respond-blocker', blockerId: 'choose-target', text: 'Use target A' });
  assert.equal(hub.state.tasks[task.taskId].blockers[0].state, 'responded');
  await assert.rejects(call('work_control', { requestId: 'early-ack', taskId: task.taskId, generation: 1, action: 'ack-instruction', instructionId: response.instructionId, decision: 'accepted' }, invocation), /delivered instruction/);
  await call('report', { requestId: 'blocked-3', taskId: task.taskId, report: blocked }, invocation);
  assert.equal(hub.state.tasks[task.taskId].blockers[0].state, 'responded', 'repeat reports never reopen a handled blocker');
  invocation.finish({ text: 'Waiting for the queued decision.' }); await until(() => hub.state.tasks[task.taskId].status === 'ready');
  const next = await launch();
  assert.equal(hub.state.tasks[task.taskId].instructions[0].state, 'delivered');
  assert.match(next.prompt, /Use target A/);
  await call('work_control', { requestId: 'adopt', taskId: task.taskId, generation: 2, action: 'ack-instruction', instructionId: response.instructionId, decision: 'accepted' }, next);
  assert.equal(hub.state.tasks[task.taskId].instructions[0].acknowledgmentProvenance, 'worker-self-reported');
  await assert.rejects(call('work_control', { requestId: 'old-blocker', taskId: task.taskId, generation: 1, action: 'resolve-blocker', blockerId: 'choose-target', text: 'Resolved' }), { code: 'CLAUDEX_STALE_GENERATION' });
  next.finish({ text: 'Finished the requested validation.' }); await until(() => hub.state.tasks[task.taskId].status === 'completed');
  await call('work_control', { requestId: 'review', taskId: task.taskId, generation: 2, action: 'review-result', decision: 'integrated' });
  assert.equal((await call('status', { taskId: task.taskId, view: 'summary' })).resultReview.state, 'integrated');
});

test('safe pause waits for native exit, fences mutations, survives restart and resumes exactly once', async t => {
  const { hub, root, run, call, start, launch } = await fixture(t);
  const task = await start(); const invocation = await launch();
  const pause = { requestId: 'pause', taskId: task.taskId, generation: 1, action: 'request-pause' };
  await call('work_control', pause);
  assert.equal(hub.state.tasks[task.taskId].status, 'running');
  await assert.rejects(call('work_control', { ...pause, requestId: 'early-resume', action: 'resume' }), /verified paused boundary/);
  await assert.rejects(call('handoff', { taskId: task.taskId, requestId: 'race-handoff', revision: hub.state.tasks[task.taskId].revision, provider: 'claude', message: 'Transfer' }), /pause/);
  const checkpoint = { requestId: 'checkpoint', taskId: task.taskId, generation: 1, action: 'checkpoint', text: 'Files saved, all child tools exited.' };
  const receipt = await call('work_control', checkpoint, invocation);
  assert.equal(receipt.nextAction, 'end-turn'); assert.equal(receipt.finalResponse, 'CLAUDEX_PAUSE');
  assert.equal(hub.state.tasks[task.taskId].status, 'running');
  assert.equal((await call('work_control', checkpoint, invocation)).replayed, true);
  await assert.rejects(call('report', { requestId: 'after-boundary', taskId: task.taskId, report: report() }, invocation), /relinquished/);
  invocation.finish({ text: 'CLAUDEX_PAUSE' }); await until(() => hub.state.tasks[task.taskId].status === 'paused');
  assert.equal((await call('status', { taskId: task.taskId })).resultFinal, false);
  await hub.close();
  const reopened = await new CollaborationHub({ root, run, mcp: async ({ token }) => ({ token }) }).initialize(); reopened.schedule = () => {};
  t.after(() => reopened.close());
  assert.equal(reopened.state.tasks[task.taskId].status, 'paused');
  const envelope = { peer: 'codex', token: reopened.controllerToken, method: 'work_control', params: { requestId: 'resume', taskId: task.taskId, generation: 1, action: 'resume' } };
  await reopened.dispatch(envelope); assert.equal((await reopened.dispatch(envelope)).replayed, true);
  await reopened.pump(); await until(() => reopened.state.tasks[task.taskId].generation === 2);
  assert.equal(reopened.running.size, 1);
});

test('cancel wins over a pause checkpoint and failure never becomes paused', async t => {
  for (const outcome of ['cancel', 'failure']) {
    const { hub, call, start, launch } = await fixture(t);
    const task = await start(); const invocation = await launch();
    await call('work_control', { requestId: 'pause', taskId: task.taskId, generation: 1, action: 'request-pause' });
    await call('work_control', { requestId: 'checkpoint', taskId: task.taskId, generation: 1, action: 'checkpoint', text: 'Safe self-reported boundary.' }, invocation);
    if (outcome === 'cancel') await call('cancel', { requestId: 'cancel', taskId: task.taskId });
    else invocation.fail(Object.assign(new Error('Unknown native exit'), { executionUncertain: true }));
    await until(() => ['cancelled', 'uncertain'].includes(hub.state.tasks[task.taskId].status));
    assert.notEqual(hub.state.tasks[task.taskId].pause.state, 'paused');
    await assert.rejects(call('work_control', { requestId: 'resume', taskId: task.taskId, generation: 1, action: 'resume' }));
  }
});

test('managed blockers wake only the authorized parent without native chat authority or child ACK', async t => {
  const { hub, call, start, launch } = await fixture(t);
  const parent = await start(); const parentInvocation = await launch();
  const child = await call('start', { requestId: 'child', provider: 'claude', cwd: hub.root, prompt: 'Child work', observability: { blockerNotifications: true } }, parentInvocation);
  const childInvocation = await launch();
  parentInvocation.finish({ text: 'Waiting for the child.' }); await until(() => hub.state.tasks[parent.taskId].status === 'waiting');
  await call('report', { requestId: 'blocked', taskId: child.taskId, report: report({ outcome: 'blocked', blocker: { id: 'choice', question: 'Which route?', impact: 'Cannot proceed', needs: 'Choose route' } }) }, childInvocation);
  assert.equal(hub.state.tasks[parent.taskId].status, 'ready');
  assert.equal(hub.state.tasks[parent.taskId].messages.filter(item => item.kind === 'child-progress').length, 1);
  assert.deepEqual(hub.state.tasks[parent.taskId].lastExecution.seenChildren, {});
  const resumed = await launch();
  const before = structuredClone(hub.state.tasks[parent.taskId].active.seenChildren);
  await call('work_events', { taskId: child.taskId, generation: 1 }, resumed);
  await call('work_reports', { taskId: child.taskId, generation: 1 }, resumed);
  assert.deepEqual(hub.state.tasks[parent.taskId].active.seenChildren, before);
  await assert.rejects(call('work_events', { taskId: parent.taskId, generation: 2 }, childInvocation), { code: 'CLAUDEX_ACCESS_DENIED' });
  await assert.rejects(call('work_control', { requestId: 'wrong-parent', taskId: parent.taskId, generation: 2, action: 'request-pause' }, childInvocation), { code: 'CLAUDEX_ACCESS_DENIED' });
  await call('work_control', { requestId: 'parent-decision', taskId: child.taskId, generation: 1, action: 'respond-blocker', blockerId: 'choice', text: 'Use route A' }, resumed);
  assert.equal(hub.state.tasks[child.taskId].blockers[0].response.provenance, 'parent-worker-reported');
});

test('new observability and cooperative controls are reachable over private Unix RPC', async t => {
  const { hub, root, call, start, launch } = await fixture(t);
  const server = await serveCollaborationSocket({ root, dispatch: envelope => hub.dispatch(envelope) }); t.after(() => server.close());
  const task = await start({ observability: { timeline: 'public' } }); const invocation = await launch();
  const rpc = (method, params, token = hub.controllerToken) => callCollaboration({ root, peer: 'codex', token, method, params });
  await invocation.onWorkEvent({ kind: 'assistant-message', nativeId: 'public-message', text: 'Public working note' });
  const before = hub.state.tasks[task.taskId].revision;
  const page = await rpc('work_events', { taskId: task.taskId, generation: 1 });
  assert.equal(page.events[0].text, 'Public working note'); assert.equal(hub.state.tasks[task.taskId].revision, before);
  await call('report', { requestId: 'report-rpc', taskId: task.taskId, report: report() }, invocation);
  assert.equal((await rpc('work_reports', { taskId: task.taskId, generation: 1 })).reports.length, 1);
  await rpc('work_control', { requestId: 'rpc-pause', taskId: task.taskId, generation: 1, action: 'request-pause' });
  assert.equal((await rpc('status', { taskId: task.taskId, view: 'summary' })).pause.state, 'requested');
});

test('artifact content never returns after the calling worker capability expires during the read', async t => {
  const { hub, root, call, start, launch } = await fixture(t);
  const reference = join(root, 'artifact.txt'); await writeFile(reference, 'Declared task artifact', { mode: 0o600 });
  const task = await start(); const invocation = await launch();
  await call('report', { requestId: 'artifact-report', taskId: task.taskId,
    report: report({ artifacts: [{ kind: 'file', reference }] }) }, invocation);
  const reading = call('artifact_read', { taskId: task.taskId, generation: 1, reference }, invocation);
  // Deterministic synthetic capability retirement after dispatch's initial check
  // and before its first asynchronous filesystem operation can settle.
  const previous = hub.state.tasks[task.taskId].active.tokenHash;
  hub.state.tasks[task.taskId].active.tokenHash = 'f'.repeat(64);
  await assert.rejects(reading, /Worker capability expired/);
  hub.state.tasks[task.taskId].active.tokenHash = previous;
  assert.equal((await call('artifact_read', { taskId: task.taskId, generation: 1, reference })).content, 'Declared task artifact');
});

test('explicit check-in delivers and acknowledges instructions within one invocation without changing ordinary status reads', async t => {
  const { hub, call, start, launch, invocations } = await fixture(t);
  const task = await start(); const worker = await launch();
  const sent = await call('send', { requestId: 'same-turn-send', taskId: task.taskId, message: 'Inspect the revised target before finishing.' });
  const before = structuredClone(hub.state);
  const status = await call('status', { taskId: task.taskId }, worker);
  assert.equal(status.messages.at(-1).text, 'Inspect the revised target before finishing.');
  assert.equal(status.instructions[0].state, 'queued'); assert.deepEqual(hub.state, before);
  const check = { requestId: 'same-turn-check', taskId: task.taskId, generation: 1, action: 'check-in' };
  const delivered = await call('work_control', check, worker);
  assert.equal(delivered.instructions[0].instructionId, sent.instructionId);
  assert.equal(delivered.instructions[0].text, 'Inspect the revised target before finishing.');
  assert.equal(delivered.instructions[0].generation, 1); assert.equal(delivered.instructions[0].deliveryProvenance, 'worker-check-in');
  await call('work_control', { requestId: 'same-turn-ack', taskId: task.taskId, generation: 1, action: 'ack-instruction', instructionId: sent.instructionId, decision: 'accepted' }, worker);
  assert.equal((await call('work_control', check, worker)).replayed, true);
  assert.equal(hub.state.tasks[task.taskId].instructions[0].state, 'accepted', 'receipt replay never reopens adoption');
  worker.finish({ text: 'Finished the original work and revised target.' });
  await until(() => hub.state.tasks[task.taskId].status === 'completed');
  assert.equal(invocations.length, 1); assert.equal(hub.state.tasks[task.taskId].generation, 1);
});

test('check-in uses bounded exact pages and preserves undelivered and late-arriving instructions', async t => {
  const { hub, call, start, launch } = await fixture(t);
  const task = await start(); const worker = await launch();
  const sent = [];
  for (let i = 0; i < 6; i++) sent.push(await call('send', { requestId: `bounded-${i}`, taskId: task.taskId, message: `${i}:${'"'.repeat(16000)}` }));
  const before = structuredClone(hub.state.tasks[task.taskId]);
  const small = await call('worker_check_in', { requestId: 'too-small', limit: 16, responseBudgetBytes: 1024 }, worker);
  assert.equal(small.instructions.length, 0); assert.equal(small.hasMore, true);
  assert.deepEqual(hub.state.tasks[task.taskId], before);
  const receipt = await call('work_control', { requestId: 'bounded-check', taskId: task.taskId, generation: 1, action: 'check-in', limit: 16 }, worker);
  assert.ok(receipt.instructions.length > 0 && receipt.instructions.length < 6);
  assert.equal(receipt.hasMore, true);
  assert.ok(Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(receipt) }] })) <= 192 * 1024);
  assert.equal(hub.state.tasks[task.taskId].instructions.filter(item => item.state === 'delivered').length, receipt.instructions.length);
  for (const item of receipt.instructions) await call('work_control', { requestId: `reject-${item.instructionId}`, taskId: task.taskId,
    generation: 1, action: 'ack-instruction', instructionId: item.instructionId, decision: 'rejected' }, worker);
  const next = await call('work_control', { requestId: 'bounded-next', taskId: task.taskId, generation: 1, action: 'check-in', limit: 1 }, worker);
  assert.equal(next.instructions.length, 1); assert.equal(next.instructions[0].instructionId, sent[receipt.instructions.length].instructionId);
  await call('send', { requestId: 'late-send', taskId: task.taskId, message: 'A new instruction after the check-in.' });
  worker.finish({ text: 'Current work ended before all messages were handled.' }); await until(() => hub.state.tasks[task.taskId].status === 'ready');
  const following = await launch();
  assert.match(following.prompt, /A new instruction after the check-in/);
  assert.equal(hub.state.tasks[task.taskId].instructions.find(item => item.id === next.instructions[0].instructionId).generation, 2,
    'a delivered but unacknowledged late instruction remains actionable in the next invocation context');
});

test('internal check-in derives worker identity, refuses privilege borrowing, and empty boundaries do not fill the journal', async t => {
  const { hub, call, start, launch } = await fixture(t);
  const task = await start(); const worker = await launch();
  const baseline = structuredClone(hub.state);
  for (let i = 0; i < 20; i++) {
    const value = await call('worker_check_in', { requestId: `empty-${i}` }, worker);
    assert.deepEqual(value.instructions, []); assert.deepEqual(value.childProgress, []); assert.equal(value.pause, null);
  }
  assert.deepEqual(hub.state, baseline);
  await assert.rejects(call('worker_check_in', { requestId: 'controller-inbox' }), { code: 'CLAUDEX_WORKER_REQUIRED' });
  await assert.rejects(call('worker_check_in', { requestId: 'forged-inbox', taskId: task.taskId }, worker), { code: 'CLAUDEX_INVALID_CONTROL' });
  await assert.rejects(call('work_control', { requestId: 'old-inbox', taskId: task.taskId, generation: 0, action: 'check-in' }, worker), { code: 'CLAUDEX_STALE_GENERATION' });
  await assert.rejects(call('work_control', { requestId: 'controller-control', taskId: task.taskId, generation: 1, action: 'check-in' }), /Only the active worker/);
  const child = await call('start', { requestId: 'child-inbox', provider: 'claude', cwd: hub.root, prompt: 'Child' }, worker);
  await launch();
  await assert.rejects(call('work_control', { requestId: 'borrow-child-inbox', taskId: child.taskId, generation: 1, action: 'check-in' }, worker), /Only the active worker/);
});

test('milestone follow-up resumes a waiting parent and same-generation duplicates never create wake storms', async t => {
  const { hub, call, start, launch } = await fixture(t);
  const parent = await start(); const firstParent = await launch();
  const child = await call('start', { requestId: 'milestone-child', provider: 'claude', cwd: hub.root, prompt: 'Report useful boundaries', observability: { reports: 'milestones' } }, firstParent);
  const childWorker = await launch();
  firstParent.finish({ text: 'Waiting for child progress.' }); await until(() => hub.state.tasks[parent.taskId].status === 'waiting');
  await call('report', { requestId: 'milestone-a', taskId: child.taskId, report: report({ summary: 'Root cause identified.' }) }, childWorker);
  assert.equal(hub.state.tasks[parent.taskId].status, 'ready');
  assert.equal(hub.state.tasks[child.taskId].notification, undefined, 'milestones never turn on external native wake');
  const activeParent = await launch();
  for (const [index, summary] of ['Implementation ready.', 'Checks complete.'].entries())
    await call('report', { requestId: `milestone-next-${index}`, taskId: child.taskId, report: report({ summary }) }, childWorker);
  const before = structuredClone(hub.state.tasks[child.taskId]), parentRevision = hub.state.tasks[parent.taskId].revision;
  const duplicate = await call('report', { requestId: 'milestone-duplicate', taskId: child.taskId,
    report: { ...report({ summary: 'Checks complete.' }) } }, childWorker);
  assert.equal(duplicate.reportChanged, false); assert.deepEqual(hub.state.tasks[child.taskId], before);
  assert.equal(hub.state.tasks[parent.taskId].revision, parentRevision);
  const first = await call('worker_check_in', { requestId: 'parent-progress-1', limit: 1 }, activeParent);
  assert.equal(first.childProgress.length, 1); assert.equal(first.hasMore, true);
  const second = await call('worker_check_in', { requestId: 'parent-progress-2', limit: 1 }, activeParent);
  assert.equal(second.childProgress.length, 1); assert.notEqual(second.childProgress[0].reportId, first.childProgress[0].reportId);
  assert.deepEqual(hub.state.tasks[parent.taskId].active.seenChildren, {}, 'progress delivery must never ACK a child result');
  assert.equal(hub.state.tasks[parent.taskId].active.seenProgress[child.taskId], second.childProgress[0].revision);
  activeParent.finish({ text: 'I reviewed the intermediate progress; waiting for final child result.' });
  await until(() => hub.state.tasks[parent.taskId].status === 'waiting');
  await call('report', { requestId: 'duplicate-while-waiting', taskId: child.taskId, report: report({ summary: 'Checks complete.' }) }, childWorker);
  assert.equal(hub.state.tasks[parent.taskId].status, 'waiting');
});

test('a later exact child-result acknowledgement consumes older result notices without another parent invocation', async t => {
  const { hub, call, start, launch } = await fixture(t);
  const parent = await start(); const parentWorker = await launch();
  const child = await call('start', { requestId: 'repeat-child', provider: 'claude', cwd: hub.root, prompt: 'Child' }, parentWorker);
  const first = await launch(); first.finish({ text: 'First child result.' });
  await until(() => hub.state.tasks[child.taskId].status === 'completed');
  await call('send', { requestId: 'repeat-child-send', taskId: child.taskId, message: 'Complete the follow-up.' }, parentWorker);
  const second = await launch(); second.finish({ text: 'Second child result.' });
  await until(() => hub.state.tasks[child.taskId].status === 'completed');
  await call('status', { taskId: child.taskId }, parentWorker);
  parentWorker.finish({ text: 'Integrated the current child result and its follow-up.' });
  await until(() => hub.state.tasks[parent.taskId].status !== 'running');
  assert.equal(hub.state.tasks[parent.taskId].status, 'completed'); assert.equal(hub.state.tasks[parent.taskId].generation, 1);
});

test('check-in honors end-turn and cancellation fences and duplicate reports stay generation-local', async t => {
  const { hub, call, start, launch } = await fixture(t);
  const task = await start(); const worker = await launch();
  await call('report', { requestId: 'same-report-one', taskId: task.taskId, report: report() }, worker);
  await call('work_control', { requestId: 'pause-for-inbox', taskId: task.taskId, generation: 1, action: 'request-pause' });
  const inbox = await call('worker_check_in', { requestId: 'pause-inbox' }, worker);
  assert.equal(inbox.pause.state, 'requested');
  await call('work_control', { requestId: 'inbox-checkpoint', taskId: task.taskId, generation: 1, action: 'checkpoint', text: 'Safe boundary reached.' }, worker);
  await assert.rejects(call('worker_check_in', { requestId: 'after-checkpoint' }, worker), /relinquished/);
  worker.finish({ text: 'CLAUDEX_PAUSE' }); await until(() => hub.state.tasks[task.taskId].status === 'paused');
  await call('work_control', { requestId: 'resume-inbox', taskId: task.taskId, generation: 1, action: 'resume' });
  const next = await launch();
  assert.equal((await call('worker_check_in', { requestId: 'resume-no-old-pause' }, next)).pause, null);
  const result = await call('report', { requestId: 'same-report-two', taskId: task.taskId, report: report() }, next);
  assert.equal(result.reportChanged, true); assert.equal(hub.state.tasks[task.taskId].reportHistory.length, 2);
  await call('cancel', { requestId: 'cancel-inbox', taskId: task.taskId });
  await assert.rejects(call('worker_check_in', { requestId: 'after-cancel' }, next), /relinquished|expired/);
});
