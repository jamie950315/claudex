/** The companion accepts a deliberately smaller controller surface than the broker.
 * Model-owned handoff and uncertainty resolution retain their existing protocols. */
export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 96 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const READ_METHODS = new Set(['list', 'status', 'work_events', 'work_reports', 'artifact_read', 'chat_list', 'chat_status', 'models']);
export const WRITE_METHODS = new Set(['start', 'send', 'cancel', 'work_control', 'chat_send', 'models']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
export class ModError extends Error {
  constructor(code, message) { super(message); this.name = 'ModError'; this.code = code; }
}
export function insist(condition, code = 'INVALID_REQUEST', message = 'Invalid companion request.') {
  if (!condition) throw new ModError(code, message);
}
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function fields(value, allowed, required = []) {
  insist(record(value) && Object.keys(value).every(key => allowed.includes(key))
    && required.every(key => Object.hasOwn(value, key)));
}
export function text(value, max = 16384, empty = false) {
  insist(typeof value === 'string' && (empty || value.trim().length > 0)
    && new TextEncoder().encode(value).length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value));
  return value;
}
export function absolute(value) {
  text(value, 4096);
  insist(value.startsWith('/') && !value.startsWith('//'), 'INVALID_PATH', 'An absolute local POSIX path is required.');
  return value;
}
export function identity(value, uuid = false) {
  insist(typeof value === 'string' && (uuid ? UUID : ID).test(value), 'INVALID_ID', 'Invalid exact identity.');
  return value;
}
export function context(value) {
  fields(value, ['sessionId', 'cwd'], ['sessionId', 'cwd']);
  identity(value.sessionId, true); absolute(value.cwd);
  return { sessionId: value.sessionId.toLowerCase(), cwd: value.cwd };
}
function provider(value) { insist(['claude', 'codex'].includes(value)); }
function boundedInteger(value, min, max) { insist(Number.isSafeInteger(value) && value >= min && value <= max); }
function model(value) {
  if (value === null) return;
  text(value, 200); insist(value === value.trim() && !/[\r\n\t]/u.test(value));
}
function effort(side, value) {
  if (value === null) return;
  insist((side === 'claude' ? ['low', 'medium', 'high', 'xhigh', 'max']
    : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).includes(value));
}
function directories(values) {
  insist(Array.isArray(values) && values.length <= 16); values.forEach(absolute);
}
export function validateParams(method, input, mutation = false) {
  insist((mutation ? WRITE_METHODS : READ_METHODS).has(method), 'UNSUPPORTED_METHOD',
    'This companion keeps worker handoff, resolution, and native lifecycle changes in the existing agent/operator workflows.');
  insist(record(input));
  const params = structuredClone(input);
  if (method === 'list') {
    fields(params, ['parentId', 'limit', 'cursor']);
    if (params.parentId !== undefined && params.parentId !== null) identity(params.parentId);
    if (params.limit !== undefined) boundedInteger(params.limit, 1, 100);
    if (params.cursor !== undefined) text(params.cursor, 8192);
  }
  if (method === 'status') {
    fields(params, ['taskId', 'view'], ['taskId']); identity(params.taskId);
    insist(params.view === undefined || ['summary', 'full'].includes(params.view));
    params.view ??= 'summary';
  }
  if (method === 'chat_list') {
    fields(params, ['limit', 'cursor', 'query', 'provider', 'match']);
    if (params.limit !== undefined) boundedInteger(params.limit, 1, 100);
    if (params.cursor !== undefined) insist(typeof params.cursor === 'string' && /^\d{1,4}$/.test(params.cursor));
    if (params.query !== undefined) text(params.query, 4096);
    if (params.provider !== undefined) provider(params.provider);
    insist(params.match === undefined || ['exact', 'contains'].includes(params.match));
  }
  if (method === 'chat_status') { fields(params, ['messageId'], ['messageId']); identity(params.messageId); }
  if (method === 'work_events' || method === 'work_reports') {
    fields(params, ['taskId', 'generation', 'cursor', 'limit', 'recent'], ['taskId', 'generation']);
    identity(params.taskId); boundedInteger(params.generation, 1, Number.MAX_SAFE_INTEGER);
    if (params.cursor !== undefined) text(params.cursor, 8192);
    if (params.limit !== undefined) boundedInteger(params.limit, 1, method === 'work_events' ? 64 : 16);
    if (params.recent !== undefined) insist(typeof params.recent === 'boolean');
  }
  if (method === 'artifact_read') {
    fields(params, ['taskId', 'generation', 'reference', 'maxBytes', 'view'], ['taskId', 'generation', 'reference']);
    identity(params.taskId); boundedInteger(params.generation, 1, Number.MAX_SAFE_INTEGER); text(params.reference, 2048);
    if (params.maxBytes !== undefined) boundedInteger(params.maxBytes, 1, 65536);
    insist(params.view === undefined || ['content', 'diff'].includes(params.view));
  }
  if (method === 'work_control') {
    // Worker acknowledgements/checkpoints remain in the worker MCP workflow.
    fields(params, ['taskId', 'generation', 'action', 'blockerId', 'text', 'decision'], ['taskId', 'generation', 'action']);
    identity(params.taskId); boundedInteger(params.generation, 1, Number.MAX_SAFE_INTEGER);
    insist(['respond-blocker', 'resolve-blocker', 'request-pause', 'resume', 'review-result'].includes(params.action));
    const blockerId = value => insist(typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value));
    if (params.blockerId !== undefined) blockerId(params.blockerId);
    if (params.text !== undefined) text(params.text, 4096);
    if (['respond-blocker', 'resolve-blocker'].includes(params.action)) { blockerId(params.blockerId); text(params.text, 4096); }
    if (params.action === 'review-result') insist(['reviewed', 'integrated'].includes(params.decision));
    else insist(params.decision === undefined);
  }
  if (method === 'start') {
    fields(params, ['provider', 'cwd', 'prompt', 'permission', 'model', 'effort', 'projectRoot', 'readOnlyDirs', 'writableDirs', 'observability'], ['provider', 'cwd', 'prompt']);
    provider(params.provider); absolute(params.cwd); text(params.prompt);
    params.permission ??= 'read-only';
    insist(['read-only', 'workspace-write'].includes(params.permission), 'PERMISSION_BOUND', 'Select read-only or workspace-write explicitly.');
    if (params.model !== undefined) model(params.model);
    if (params.effort !== undefined) effort(params.provider, params.effort);
    if (params.projectRoot !== undefined) absolute(params.projectRoot);
    if (params.readOnlyDirs !== undefined) directories(params.readOnlyDirs);
    if (params.writableDirs !== undefined) directories(params.writableDirs);
    if (params.observability !== undefined) {
      fields(params.observability, ['timeline', 'reports', 'blockerNotifications']);
      const policy = params.observability;
      insist(policy.timeline === undefined || ['off', 'public'].includes(policy.timeline));
      insist(policy.reports === undefined || ['off', 'milestones'].includes(policy.reports));
      insist(policy.blockerNotifications === undefined || typeof policy.blockerNotifications === 'boolean');
    }
  }
  if (method === 'send') {
    fields(params, ['taskId', 'message'], ['taskId', 'message']); identity(params.taskId); text(params.message);
  }
  if (method === 'cancel') { fields(params, ['taskId'], ['taskId']); identity(params.taskId); }
  if (method === 'chat_send') {
    fields(params, ['title', 'provider', 'sessionId', 'expectedTitle', 'message', 'wake', 'expiresInMs'], ['message']);
    text(params.message, 1500); params.wake ??= false;
    insist(typeof params.wake === 'boolean');
    if (params.provider !== undefined) provider(params.provider);
    if (params.title !== undefined) {
      text(params.title, 4096); insist(params.sessionId === undefined && params.expectedTitle === undefined);
    } else {
      provider(params.provider); identity(params.sessionId); text(params.expectedTitle, 4096);
    }
    if (params.expiresInMs !== undefined) boundedInteger(params.expiresInMs, 1000, 3600000);
  }
  if (method === 'models') {
    fields(params, mutation ? ['defaultModels', 'defaultEfforts', 'defaultPermission'] : []);
    if (mutation) insist(Object.keys(params).length > 0);
    if (params.defaultModels !== undefined) {
      fields(params.defaultModels, ['claude', 'codex'], ['claude', 'codex']);
      model(params.defaultModels.claude); model(params.defaultModels.codex);
    }
    if (params.defaultEfforts !== undefined) {
      fields(params.defaultEfforts, ['claude', 'codex'], ['claude', 'codex']);
      effort('claude', params.defaultEfforts.claude); effort('codex', params.defaultEfforts.codex);
    }
    if (params.defaultPermission !== undefined) insist(['read-only', 'workspace-write'].includes(params.defaultPermission));
  }
  return params;
}
export function validateRequest(value) {
  const common = ['version', 'op', 'context'];
  insist(record(value) && value.version === PROTOCOL_VERSION);
  const extras = {
    doctor: [], read: ['method', 'params'], prepare: ['method', 'params'],
    commit: ['id'], receipt: ['id'], 'wake-peek': ['target'], 'wake-claim': ['messageId', 'target'],
    'wake-receipt': ['messageId', 'claimId', 'status', 'target'],
    'wake-next': ['excludeIds', 'observation'], 'wake-observe': ['observation'], 'wake-check': ['messageId', 'claimId', 'target'],
    'wake-self-send': ['messageId', 'claimId', 'target'],
    'wake-self-receive': ['messageId', 'claimId', 'target'],
  }[value.op];
  insist(extras !== undefined, 'UNSUPPORTED_OPERATION', 'Unsupported companion operation.');
  if (value.op === 'wake-receipt') extras.push('reason');
  if (value.op.startsWith('wake-')) extras.push('route');
  fields(value, [...common, ...extras], [...common, ...extras.filter(key => !['params', 'target', 'excludeIds', 'reason', 'route'].includes(key) && !(key === 'observation' && value.op === 'wake-next'))]);
  const request = { ...value, context: context(value.context) };
  if (value.op.startsWith('wake-')) {
    request.target = context(value.target ?? value.context);
    if (value.route !== undefined) insist(['mod', 'mod-self'].includes(value.route));
  }
  if (['read', 'prepare'].includes(value.op)) request.params = validateParams(value.method, value.params ?? {}, value.op === 'prepare');
  if (value.id !== undefined) identity(value.id, true);
  if (value.messageId !== undefined) identity(value.messageId, true);
  if (value.claimId !== undefined) identity(value.claimId, true);
  if (value.observation !== undefined) request.observation = validateModObservation(value.observation);
  if (value.op === 'wake-receipt') {
    request.reason ??= value.status === 'accepted' ? 'queued' : 'native_exception';
    validateWakeOutcome(value.status, request.reason);
  }
  if (value.op === 'wake-next') {
    request.excludeIds ??= [];
    insist(Array.isArray(request.excludeIds) && request.excludeIds.length <= 64);
    request.excludeIds.forEach(id => identity(id, true));
  }
  return request;
}
export function sameContext(a, b) { return a.sessionId === b.sessionId && a.cwd === b.cwd; }

/** Enumerated, content-free observations are diagnostic only, never capabilities. */
export function validateModObservation(value) {
  fields(value, ['observerId', 'sequence', 'lifecycle', 'nativeWake', 'selfWake', 'inboundPolicy', 'capabilities', 'usage'],
    ['observerId', 'sequence', 'lifecycle', 'nativeWake', 'selfWake', 'inboundPolicy', 'capabilities', 'usage']);
  identity(value.observerId); boundedInteger(value.sequence, 1, Number.MAX_SAFE_INTEGER);
  insist(['loaded', 'ended'].includes(value.lifecycle));
  insist(typeof value.nativeWake === 'boolean' && typeof value.selfWake === 'boolean');
  insist(['allow', 'hold', 'refuse', 'unknown'].includes(value.inboundPolicy));
  fields(value.capabilities, ['sendMessage'], ['sendMessage']);
  insist(value.capabilities.sendMessage === null || typeof value.capabilities.sendMessage === 'boolean');
  if (value.usage !== null) {
    fields(value.usage, ['contextPercent'], ['contextPercent']);
    insist(Number.isFinite(value.usage.contextPercent) && value.usage.contextPercent >= 0 && value.usage.contextPercent <= 100);
  }
  return structuredClone(value);
}

export function validateWakeOutcome(status, reason) {
  insist(status === 'accepted' && reason === 'queued' || status === 'rejected' && reason === 'native_rejected'
    || status === 'submitted' && reason === 'inbox_written'
    || status === 'uncertain' && ['native_exception', 'context_changed', 'pre_dispatch_stopped'].includes(reason),
  'INVALID_RECEIPT', 'Invalid native wake outcome.');
}
