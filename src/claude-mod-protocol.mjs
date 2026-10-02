/** The companion accepts a deliberately smaller controller surface than the broker.
 * Model-owned handoff and uncertainty resolution retain their existing protocols. */
export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 96 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const READ_METHODS = new Set(['list', 'status', 'chat_list', 'chat_status', 'models']);
export const WRITE_METHODS = new Set(['start', 'send', 'cancel', 'chat_send', 'models']);
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
  if (method === 'list') fields(params, []);
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
  if (method === 'start') {
    fields(params, ['provider', 'cwd', 'prompt', 'permission', 'model', 'effort', 'projectRoot', 'readOnlyDirs', 'writableDirs'], ['provider', 'cwd', 'prompt']);
    provider(params.provider); absolute(params.cwd); text(params.prompt);
    params.permission ??= 'read-only';
    insist(['read-only', 'workspace-write'].includes(params.permission), 'PERMISSION_BOUND', 'Select read-only or workspace-write explicitly.');
    if (params.model !== undefined) model(params.model);
    if (params.effort !== undefined) effort(params.provider, params.effort);
    if (params.projectRoot !== undefined) absolute(params.projectRoot);
    if (params.readOnlyDirs !== undefined) directories(params.readOnlyDirs);
    if (params.writableDirs !== undefined) directories(params.writableDirs);
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
    'wake-next': ['excludeIds'], 'wake-check': ['messageId', 'claimId', 'target'],
  }[value.op];
  insist(extras !== undefined, 'UNSUPPORTED_OPERATION', 'Unsupported companion operation.');
  if (value.op === 'wake-receipt') extras.push('reason');
  fields(value, [...common, ...extras], [...common, ...extras.filter(key => !['params', 'target', 'excludeIds', 'reason'].includes(key))]);
  const request = { ...value, context: context(value.context) };
  if (value.op.startsWith('wake-')) request.target = context(value.target ?? value.context);
  if (['read', 'prepare'].includes(value.op)) request.params = validateParams(value.method, value.params ?? {}, value.op === 'prepare');
  if (value.id !== undefined) identity(value.id, true);
  if (value.messageId !== undefined) identity(value.messageId, true);
  if (value.claimId !== undefined) identity(value.claimId, true);
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

export function validateWakeOutcome(status, reason) {
  insist(status === 'accepted' && reason === 'queued' || status === 'rejected' && reason === 'native_rejected'
    || status === 'uncertain' && ['native_exception', 'context_changed', 'pre_dispatch_stopped'].includes(reason),
  'INVALID_RECEIPT', 'Invalid native wake outcome.');
}
