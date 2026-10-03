import { randomUUID, createHash } from 'node:crypto';
import { appendWorkEvent, initializeWorkEvents } from './collaboration-events.mjs';
import { validateOutcome } from './collaboration-outcome.mjs';

const fail = (message, code = 'CLAUDEX_INVALID_CONTROL') => { throw Object.assign(new Error(message), { code }); };
const text = (value, maximum = 4096) => typeof value === 'string' && value.trim() && !value.includes('\0') && Buffer.byteLength(value) <= maximum;
const copy = value => structuredClone(value);
export function observabilityPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['timeline', 'reports', 'blockerNotifications'].includes(key))
    || value.timeline !== undefined && !['off', 'public'].includes(value.timeline)
    || value.reports !== undefined && !['off', 'milestones'].includes(value.reports)
    || value.blockerNotifications !== undefined && typeof value.blockerNotifications !== 'boolean')
    fail('Invalid observability policy.', 'CLAUDEX_INVALID_OBSERVABILITY');
  return { timeline: value.timeline ?? 'off', reports: value.reports ?? 'off', blockerNotifications: value.blockerNotifications ?? false };
}

export function instruction(task, actor, message, extra = {}) {
  if ((task.instructions?.length ?? 0) >= 256) fail('Instruction capacity reached; existing receipts were preserved.');
  const record = { id: randomUUID(), state: 'queued', requestedGeneration: task.generation,
    provenance: actor.task ? 'parent-worker-reported' : 'controller-reported', from: actor.task?.id ?? actor.peer,
    createdAt: Date.now(), ...extra };
  (task.instructions ??= []).push(record);
  initializeWorkEvents(task);
  task.messages.push({ from: record.from, kind: 'message', text: message, instructionId: record.id, at: record.createdAt });
  appendWorkEvent(task, { generation: task.generation, source: 'broker', kind: 'instruction', instructionId: record.id, status: 'queued' });
  return record.id;
}

export function recordProgress(task, report) {
  // A bounded immutable history is separate from the latest report. Never silently
  // discard older declarations, which may still be referenced by review evidence.
  if ((task.reportHistory?.length ?? 0) >= 128) fail('Report history capacity reached; existing reports were preserved.', 'CLAUDEX_REPORT_CAPACITY');
  const saved = { ...copy(report), id: randomUUID() };
  (task.reportHistory ??= []).push(saved);
  initializeWorkEvents(task);
  appendWorkEvent(task, { generation: report.generation, source: 'worker-self-report', kind: 'report', reportId: saved.id,
    phase: report.stage, summary: report.summary, nextStep: report.next, outcome: report.outcome });
  let blockerChanged = false;
  if (report.blocker) {
    const input = report.blocker;
    const id = input.id ?? createHash('sha256').update(JSON.stringify([report.generation, input.question, input.impact, input.needs])).digest('hex').slice(0, 32);
    let blocker = (task.blockers ??= []).find(item => item.id === id && item.generation === report.generation);
    if (blocker && ['responded', 'resolved'].includes(blocker.state)) return { reportId: saved.id, blockerId: id, blockerChanged: false };
    if (!blocker) {
      if (task.blockers.length >= 64) fail('Blocker capacity reached; existing decisions were preserved.');
      blocker = { id, generation: report.generation, state: 'open', revision: 1, provenance: 'worker-self-reported', createdAt: Date.now() };
      task.blockers.push(blocker); blockerChanged = true;
    } else if (['question', 'impact', 'needs'].some(key => blocker[key] !== input[key])) { blocker.revision++; blockerChanged = true; }
    if (blockerChanged) {
      Object.assign(blocker, { question: input.question, impact: input.impact, needs: input.needs, updatedAt: Date.now() });
      appendWorkEvent(task, { generation: report.generation, source: 'worker-self-report', kind: 'blocker', blockerId: id,
        status: blocker.state, question: blocker.question, impact: blocker.impact, requestedAction: blocker.needs });
    }
    return { reportId: saved.id, blockerId: id, blockerChanged };
  }
  return { reportId: saved.id, blockerChanged };
}

export function progressPresentation(task) {
  return { observability: observabilityPolicy(task.observability),
    progress: { provenance: task.reportHistory?.length ? 'worker-self-reported' : 'unreported',
      reportCount: task.reportHistory?.length ?? 0, lastReportedAt: task.reportHistory?.at(-1)?.reportedAt ?? null,
      stage: task.reportHistory?.at(-1)?.stage ?? null, next: task.reportHistory?.at(-1)?.next ?? null,
      current: task.reportHistory?.at(-1)?.generation === task.generation && ['running', 'waiting', 'paused', 'completed'].includes(task.status) },
    blockers: copy((task.blockers ?? []).map(item => ({ ...item, current: item.generation === task.generation }))),
    instructions: copy(task.instructions ?? []), pause: copy(task.pause ?? null), resultReview: copy(task.resultReview ?? null) };
}

export function queryWorkReports(task, { generation, cursor, limit = 8, recent = false } = {}) {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > task.generation
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 16 || typeof recent !== 'boolean') fail('Invalid report query.');
  let after = 0;
  if (cursor !== undefined) {
    try {
      if (typeof cursor !== 'string' || cursor.length > 512 || recent) throw new Error();
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (Object.keys(value).length !== 3 || value.taskId !== task.id || value.generation !== generation
        || !Number.isSafeInteger(value.after) || value.after < 0 || value.after > (task.reportHistory?.length ?? 0)) throw new Error();
      after = value.after;
    } catch { fail('Report cursor does not match the query.', 'CLAUDEX_INVALID_CURSOR'); }
  }
  const rows = (task.reportHistory ?? []).map((report, index) => ({ report, index: index + 1 }))
    .filter(row => row.index > after && row.report.generation === generation);
  const page = recent ? rows.slice(-limit) : rows.slice(0, limit);
  return { taskId: task.id, generation, reports: copy(page.map(row => row.report)),
    cursor: Buffer.from(JSON.stringify({ taskId: task.id, generation, after: page.at(-1)?.index ?? after })).toString('base64url'),
    hasMore: !recent && rows.length > page.length,
    collection: task.reportHistory !== undefined || task.workEvents ? 'collected' : 'not-collected', limit: 128 };
}

export function controlWork(task, params, actor, state) {
  if (Object.keys(params).some(key => !['requestId', 'taskId', 'generation', 'action', 'text', 'blockerId', 'instructionId', 'decision'].includes(key))) fail('Unknown control fields.');
  if (!Number.isSafeInteger(params.generation) || params.generation !== task.generation)
    fail('Control generation does not match the current task.', 'CLAUDEX_STALE_GENERATION');
  const self = actor.task?.id === task.id;
  const at = Date.now(), provenance = self ? 'worker-self-reported' : actor.task ? 'parent-worker-reported' : 'controller-reported';
  const action = params.action;
  if (!['respond-blocker', 'resolve-blocker', 'ack-instruction', 'request-pause', 'checkpoint', 'resume', 'review-result'].includes(action)) fail('Unknown work control action.');
  if (params.text !== undefined && !text(params.text)) fail('Control text must be bounded nonempty text.');
  if (['ack-instruction', 'checkpoint'].includes(action) && (!self || task.status !== 'running')) fail('Only the active worker may acknowledge its own instruction or checkpoint.');
  if (['respond-blocker', 'request-pause', 'resume', 'review-result'].includes(action) && self) fail('This action requires the parent or external controller.');
  if (task.pendingHandoff || task.cancelRequested) fail('Task is already transferring or cancelling.');
  let receipt = {};
  if (action === 'respond-blocker' || action === 'resolve-blocker') {
    const blocker = task.blockers?.find(item => item.id === params.blockerId && item.generation === params.generation);
    if (!blocker) fail('Blocker does not belong to the exact generation.');
    if (!text(params.text)) fail('A blocker response or resolution requires text.');
    if (blocker.state === 'resolved' || action === 'respond-blocker' && blocker.state !== 'open') fail('Blocker is no longer awaiting this transition.');
    blocker.state = action === 'respond-blocker' ? 'responded' : 'resolved'; blocker.revision++; blocker.updatedAt = at;
    blocker[action === 'respond-blocker' ? 'response' : 'resolution'] = { text: params.text, provenance, at, generation: params.generation };
    if (action === 'respond-blocker') {
      receipt.instructionId = instruction(task, actor, `Decision for blocker ${blocker.id} from generation ${params.generation}: ${params.text}`, { blockerId: blocker.id });
      if (task.status === 'completed') task.status = 'ready';
    }
    receipt.blockerId = blocker.id;
    appendWorkEvent(task, { generation: task.generation, source: self ? 'worker-self-report' : 'broker', kind: 'blocker', blockerId: blocker.id, status: blocker.state });
  } else if (action === 'ack-instruction') {
    const record = task.instructions?.find(item => item.id === params.instructionId && item.generation === params.generation);
    if (!record || record.state !== 'delivered' || !['accepted', 'rejected'].includes(params.decision)) fail('A delivered instruction and explicit accepted/rejected decision are required.');
    Object.assign(record, { state: params.decision, acknowledgedAt: at, acknowledgmentProvenance: 'worker-self-reported', ...(params.text ? { reason: params.text } : {}) });
    receipt.instructionId = record.id;
    appendWorkEvent(task, { generation: task.generation, source: 'worker-self-report', kind: 'instruction', instructionId: record.id, status: record.state });
  } else if (action === 'request-pause') {
    if (task.status !== 'running' || task.pause && ['requested', 'checkpoint', 'paused'].includes(task.pause.state)) fail('Cooperative pause requires a running task without a pending pause.');
    task.pause = { state: 'requested', generation: task.generation, requestedAt: at, provenance, ...(params.text ? { reason: params.text } : {}) };
    receipt.nextAction = 'await-checkpoint';
  } else if (action === 'checkpoint') {
    if (task.pause?.state !== 'requested' || task.pause.generation !== task.generation || !text(params.text)) fail('Checkpoint requires the exact pending pause and a boundary summary.');
    if (Object.values(state.tasks).some(child => child.parentId === task.id && !['completed', 'failed', 'cancelled'].includes(child.status))) fail('Finish or cancel child work before acknowledging a safe pause.');
    Object.assign(task.pause, { state: 'checkpoint', checkpointAt: at, summary: params.text, checkpointProvenance: 'worker-self-reported' });
    receipt = { nextAction: 'end-turn', finalResponse: 'CLAUDEX_PAUSE', instruction: 'End this native turn immediately with exactly CLAUDEX_PAUSE. Do not call more tools. Paused status requires successful native completion and process exit.' };
  } else if (action === 'resume') {
    if (task.status !== 'paused' || task.pause?.state !== 'paused') fail('Resume requires a verified paused boundary; a pending request is not paused.');
    task.pause.state = 'resumed'; task.pause.resumedAt = at; task.status = 'ready';
    task.messages.push({ kind: 'message', from: actor.task?.id ?? actor.peer, text: params.text ?? 'Resume the paused work from its saved checkpoint. Do not replay completed actions.', at });
  } else {
    if (task.status !== 'completed' || task.result?.generation !== task.generation || !['reviewed', 'integrated'].includes(params.decision)) fail('Result review requires a final result and explicit reviewed/integrated decision.');
    task.resultReview = { generation: task.generation, state: params.decision, provenance, at, ...(params.text ? { notes: params.text } : {}) };
  }
  if (['request-pause', 'checkpoint', 'resume', 'review-result'].includes(action)) appendWorkEvent(task,
    { generation: task.generation, source: self ? 'worker-self-report' : 'broker', kind: 'control', status: action });
  return receipt;
}

export function validateProgress(task) {
  const generation = value => Number.isSafeInteger(value) && value >= 0 && value <= task.generation;
  const identity = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
  if (task.reportHistory !== undefined) {
    if (!Array.isArray(task.reportHistory) || task.reportHistory.length > 128) fail('Malformed report history.');
    const ids = new Set();
    for (const report of task.reportHistory) {
      if (!report || !identity(report.id) || ids.has(report.id) || !generation(report.generation)
        || report.provenance !== 'worker-self-reported' || !['codex', 'claude'].includes(report.provider)
        || !Number.isSafeInteger(report.reportedAt) || report.reportedAt < 1) fail('Malformed persisted report.');
      ids.add(report.id);
      const { id, generation: ignoredGeneration, provenance, provider, reportedAt, ...outcome } = report;
      validateOutcome(outcome);
    }
  }
  if (task.blockers !== undefined && (!Array.isArray(task.blockers) || task.blockers.length > 64
    || task.blockers.some(item => !item || !identity(item.id) || !generation(item.generation)
      || !['open', 'responded', 'resolved'].includes(item.state) || !Number.isSafeInteger(item.revision) || item.revision < 1
      || !['question', 'impact', 'needs'].every(key => text(item[key], 2048))))) fail('Malformed persisted blockers.');
  if (task.instructions !== undefined && (!Array.isArray(task.instructions) || task.instructions.length > 256
    || task.instructions.some(item => !item || !identity(item.id) || !generation(item.requestedGeneration)
      || !['queued', 'delivered', 'accepted', 'rejected'].includes(item.state)
      || item.state !== 'queued' && !generation(item.generation)))) fail('Malformed persisted instructions.');
  if (task.pause !== undefined && (!task.pause || !generation(task.pause.generation)
    || !['requested', 'checkpoint', 'paused', 'resumed', 'cancelled', 'not-paused'].includes(task.pause.state)
    || task.status === 'paused' && task.pause.state !== 'paused')) fail('Malformed pause record.');
  if (task.status === 'paused' && !task.pause) fail('Paused work lacks its checkpoint record.');
  if (task.resultReview !== undefined && (!task.resultReview || !generation(task.resultReview.generation)
    || !['reviewed', 'integrated'].includes(task.resultReview.state))) fail('Malformed result review.');
  assertProgressCapacity(task);
}

export function assertProgressCapacity(task) {
  if (Buffer.byteLength(JSON.stringify([task.blockers ?? [], task.instructions ?? [], task.pause ?? null, task.resultReview ?? null])) > 192 * 1024)
    fail('Work control record capacity reached; existing decisions and instructions were preserved.', 'CLAUDEX_PROGRESS_CAPACITY');
}
