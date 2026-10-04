import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { codexChatSocket } from './native-chat-catalog.mjs';
import { CodexWebSocketClient } from './codex-websocket.mjs';
import { preflightCodexChatWake } from './codex-chat-wake.mjs';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const FIELDS = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
const SAFE_ITEMS = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan']);
const INVALIDATIONS = new Map([
  ['thread/compacted', 'context-compacted'],
  ['model/rerouted', 'model-rerouted'], ['thread/closed', 'thread-closed'],
  ['thread/archived', 'thread-archived'], ['thread/deleted', 'thread-deleted'], ['error', 'native-error'],
]);
const fail = reason => { throw new Error(`Codex cache native: ${reason}.`); };
const seconds = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
  && Number.isSafeInteger(value * 1000) ? value * 1000 : null;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('\0');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).length === expected.length
  && expected.every(key => Object.hasOwn(value, key));
const nullable = value => value === null || identifier(value);
const pathValue = value => typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && !/[\x00-\x1f\x7f]/u.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const CORE_SETTINGS = ['model', 'modelProvider', 'cwd', 'serviceTier', 'disabledPluginIds', 'approvalPolicy',
  'approvalsReviewer', 'sandboxPolicy', 'activePermissionProfile', 'effort', 'collaborationMode', 'multiAgentMode'];
const SECURITY_SETTINGS = ['modelProvider', 'disabledPluginIds', 'approvalPolicy', 'approvalsReviewer',
  'sandboxPolicy', 'activePermissionProfile'];

/** Validate the reviewed 0.160 schema and retain hashes, never instruction text.
 * Resume is a permissions baseline, not evidence of an executed prompt. The
 * first identity/permissions-matched snapshot establishes resolved prompt
 * settings; all subsequent snapshots must retain that complete fingerprint. */
function settingsHashes(source, { resume = false } = {}) {
  if (!record(source) || !resume && !keys(source, [...CORE_SETTINGS, 'summary', 'personality'])) fail('invalid-native-settings');
  const value = Object.fromEntries(CORE_SETTINGS.map(key => [key,
    source[resume && key === 'sandboxPolicy' ? 'sandbox' : resume && key === 'effort' ? 'reasoningEffort' : key]]));
  const array = (items, check) => Array.isArray(items) && items.length <= 1024 && items.every(check);
  if (!identifier(value.model) || !identifier(value.modelProvider) || !pathValue(value.cwd)
    || !nullable(value.serviceTier) || !nullable(value.effort) || !array(value.disabledPluginIds, identifier)
    || !['user', 'auto_review', 'guardian_subagent'].includes(value.approvalsReviewer)) fail('invalid-native-settings');
  value.disabledPluginIds = [...value.disabledPluginIds].sort();
  const approval = value.approvalPolicy;
  if (!['untrusted', 'on-request', 'never'].includes(approval)
    && !(keys(approval, ['granular']) && keys(approval.granular,
      ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations'])
      && Object.values(approval.granular).every(item => typeof item === 'boolean'))) fail('invalid-native-settings');
  const sandbox = value.sandboxPolicy;
  if (!record(sandbox)) fail('invalid-native-settings');
  if (sandbox.type === 'dangerFullAccess') {
    if (!keys(sandbox, ['type'])) fail('invalid-native-settings');
  } else if (sandbox.type === 'readOnly') {
    if (!keys(sandbox, ['type', 'networkAccess']) || typeof sandbox.networkAccess !== 'boolean') fail('invalid-native-settings');
  } else if (sandbox.type === 'externalSandbox') {
    if (!keys(sandbox, ['type', 'networkAccess']) || !['restricted', 'enabled'].includes(sandbox.networkAccess)) fail('invalid-native-settings');
  } else if (sandbox.type === 'workspaceWrite') {
    if (!keys(sandbox, ['type', 'writableRoots', 'networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'])
      || !array(sandbox.writableRoots, pathValue)
      || !['networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'].every(key => typeof sandbox[key] === 'boolean')) fail('invalid-native-settings');
    value.sandboxPolicy = { ...sandbox, writableRoots: [...sandbox.writableRoots].sort() };
  } else fail('invalid-native-settings');
  const profile = value.activePermissionProfile;
  if (profile !== null && !(keys(profile, ['id', 'extends']) && identifier(profile.id) && nullable(profile.extends))) fail('invalid-native-settings');
  const collaboration = value.collaborationMode;
  if (collaboration === null && !resume) fail('invalid-native-settings');
  if (collaboration !== null) {
    if (!keys(collaboration, ['mode', 'settings']) || !['plan', 'default'].includes(collaboration.mode)
      || !keys(collaboration.settings, ['model', 'reasoning_effort', 'developer_instructions'])
      || !identifier(collaboration.settings.model) || !nullable(collaboration.settings.reasoning_effort)
      || !(collaboration.settings.developer_instructions === null
        || typeof collaboration.settings.developer_instructions === 'string' && collaboration.settings.developer_instructions.length <= 262144)) fail('invalid-native-settings');
    value.collaborationMode = { mode: collaboration.mode, settings: { ...collaboration.settings,
      developer_instructions: collaboration.settings.developer_instructions === null ? null : digest(collaboration.settings.developer_instructions) } };
  }
  const multi = value.multiAgentMode;
  if (!['explicitRequestOnly', 'proactive'].includes(multi)) {
    if (!keys(multi, ['custom']) || typeof multi.custom !== 'string' || multi.custom.length > 262144) fail('invalid-native-settings');
    value.multiAgentMode = { custom: digest(multi.custom) };
  }
  const security = digest(canonical(Object.fromEntries(SECURITY_SETTINGS.map(key => [key, value[key]]))));
  if (resume) return { security };
  if (![null, 'auto', 'concise', 'detailed', 'none'].includes(source.summary)
    || ![null, 'none', 'friendly', 'pragmatic'].includes(source.personality)) fail('invalid-native-settings');
  return { security, model: digest(value.model), cwd: digest(value.cwd), effort: digest(canonical(value.effort)),
    collaborationModel: digest(collaboration.settings.model),
    full: digest(canonical({ ...value, summary: source.summary, personality: source.personality })) };
}

function target(value) {
  if (!value || !UUID.test(value.sessionId ?? '') || !isAbsolute(value.cwd ?? '') || value.cwd.includes('\0')) fail('invalid target');
  return { sessionId: value.sessionId, cwd: value.cwd };
}

function version(result) {
  // This is an independent cache-observer compatibility gate, not the sync allowlist.
  const match = typeof result?.userAgent === 'string'
    ? /(?:^|[\s/])([0-9]+\.[0-9]+\.[0-9]+(?:[-+][^\s;)]+)?)(?=$|[\s;)])/.exec(result.userAgent) : null;
  if (match?.[1] !== '0.160.0') fail('unsupported native version');
  return match[1];
}

function metadata(thread, expected, nativeVersion, ownerClientId) {
  if (thread?.id !== expected.sessionId || thread.cwd !== expected.cwd || thread.ephemeral !== false
      || thread.parentThreadId != null || thread.forkedFromId != null
      || !['cli', 'vscode', 'exec'].includes(thread.source)
      || !['idle', 'active'].includes(thread.status?.type)
      || !identifier(thread.model) || (thread.reasoningEffort != null && !identifier(thread.reasoningEffort)))
    fail('thread is not an exact loaded persistent primary target');
  const state = { ...expected, model: thread.model, effort: thread.reasoningEffort ?? 'native-default',
    phase: thread.status.type === 'idle' ? 'idle' : 'busy', ownerClientId, nativeVersion };
  state.fingerprint = createHash('sha256').update(JSON.stringify({ ...state, effort: thread.reasoningEffort ?? null, phase: undefined })).digest('hex');
  return state;
}

function counts(value) {
  if (!value || FIELDS.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
  return Object.fromEntries(FIELDS.map(key => [key, value[key]]));
}

function notification(event, sessionId, now) {
  const p = event?.params;
  if (p?.threadId !== sessionId) return null;
  if (INVALIDATIONS.has(event.method)) return { type: 'invalidated', reason: INVALIDATIONS.get(event.method) };
  if (event.method === 'thread/status/changed' && ['notLoaded', 'systemError'].includes(p.status?.type))
    return { type: 'invalidated', reason: 'native-thread-unavailable' };
  if (event.method === 'turn/started') {
    const startedAt = seconds(p.turn?.startedAt);
    return identifier(p.turn?.id) && startedAt !== null
      ? { type: 'start', turnId: p.turn.id, startedAt }
      : { type: 'invalidated', reason: 'invalid-turn-start' };
  }
  if (event.method === 'turn/completed') {
    const completedAt = seconds(p.turn?.completedAt);
    return identifier(p.turn?.id) && completedAt !== null && ['completed', 'failed', 'interrupted'].includes(p.turn?.status)
      ? { type: 'complete', turnId: p.turn.id, status: p.turn.status, completedAt }
      : { type: 'invalidated', reason: 'invalid-turn-completion' };
  }
  if (event.method === 'thread/tokenUsage/updated') {
    const total = counts(p.tokenUsage?.total), last = counts(p.tokenUsage?.last);
    return identifier(p.turnId) && total && last
      ? { type: 'usage', turnId: p.turnId, tokenUsage: { total, last }, at: now() }
      : { type: 'invalidated', reason: 'invalid-native-usage' };
  }
  if (event.method === 'item/started') {
    if (p.item?.type === 'contextCompaction') return { type: 'invalidated', reason: 'context-compacted' };
    if (SAFE_ITEMS.has(p.item?.type)) return null;
    return identifier(p.turnId) && identifier(p.item?.type)
      ? { type: 'tool', turnId: p.turnId, itemType: p.item.type }
      : { type: 'invalidated', reason: 'invalid-native-item' };
  }
  return null;
}

/** Observe the existing Desktop backend; never launch, acquire or unload an owner. */
export function createCodexCacheNative({ syncRoot, codexHome, clientFactory,
  preflight = preflightCodexChatWake, now = Date.now } = {}) {
  const client = async () => clientFactory ? clientFactory()
    : new CodexWebSocketClient({ socketPath: await codexChatSocket({ syncRoot, codexHome }), timeoutMs: 5000 });
  async function owner(expected) {
    const handle = await preflight({ sessionId: expected.sessionId, codexHome });
    if (handle?.status !== 'ready' || !UUID.test(handle.ownerClientId ?? '')) {
      handle?.close?.(); fail('native owner unavailable');
    }
    return handle;
  }
  async function read(connection, expected, nativeVersion) {
    const { thread } = await connection.request('thread/read', { threadId: expected.sessionId, includeTurns: false });
    // A stored idle status alone is not proof of a currently loaded owner.
    const loaded = await connection.request('thread/loaded/list', {});
    if (!Array.isArray(loaded?.data) || !loaded.data.includes(expected.sessionId)) fail('thread is not loaded');
    const handle = await owner(expected);
    try { return metadata(thread, expected, nativeVersion, handle.ownerClientId); }
    finally { handle.close?.(); }
  }
  async function inspect(input) {
    const expected = target(input), connection = await client();
    try { return await read(connection, expected, version(await connection.initialize())); }
    finally { await connection.close(); }
  }
  async function verifyCommand(input) {
    const expected = target(input);
    if (!identifier(input.turnId) || !pathValue(input.transcriptPath)) fail('command identity unavailable');
    const connection = await client();
    try {
      const nativeVersion = version(await connection.initialize());
      const state = await read(connection, expected, nativeVersion);
      const { thread } = await connection.request('thread/read', { threadId: expected.sessionId, includeTurns: false });
      if (thread?.path !== input.transcriptPath || state.phase !== 'busy'
        || metadata(thread, expected, nativeVersion, state.ownerClientId).fingerprint !== state.fingerprint)
        fail('command is not from this primary transcript');
      // Subagent hook session_id can name its parent. Require the native primary
      // transcript path AND its exact active turn; never open arbitrary hook paths.
      const page = await connection.request('thread/turns/list', {
        threadId: expected.sessionId, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc',
      });
      const turn = page?.data?.[0];
      if (!Array.isArray(page?.data) || page.data.length !== 1 || turn?.id !== input.turnId || turn.status !== 'inProgress'
        || turn.itemsView !== 'notLoaded' || !Array.isArray(turn.items) || turn.items.length)
        fail('command is not the current primary turn');
      return true;
    } finally { await connection.close(); }
  }
  async function connect(input, onEvent) {
    const expected = target(input);
    if (typeof onEvent !== 'function') fail('event callback required');
    const connection = await client();
    let listening = false, closed = false, invalidated = false, buffered = [];
    let securitySettings = null, confirmedSettings = null, fullSettings = null, earlySettings = [];
    const emit = value => {
      if (!value || closed || invalidated) return;
      if (!listening && buffered.length >= 128) value = { type: 'invalidated', reason: 'event-buffer-overflow' };
      if (value.type === 'invalidated') { invalidated = true; if (!listening) buffered = []; }
      if (listening) onEvent(value);
      else buffered.push(value);
    };
    const compareSettings = hashes => {
      if (hashes.security !== securitySettings || hashes.model !== confirmedSettings.model || hashes.cwd !== confirmedSettings.cwd
        || hashes.collaborationModel !== confirmedSettings.model
        || confirmedSettings.effort !== null && hashes.effort !== confirmedSettings.effort
        || fullSettings !== null && hashes.full !== fullSettings)
        emit({ type: 'invalidated', reason: 'settings-changed' });
      else fullSettings = hashes.full;
    };
    const observe = event => {
      if (closed || invalidated) return;
      if (event?.method === 'thread/settings/updated' && event.params?.threadId === expected.sessionId) {
        try {
          const hashes = settingsHashes(event.params.threadSettings);
          if (securitySettings === null) {
            if (earlySettings.length >= 128) emit({ type: 'invalidated', reason: 'settings-buffer-overflow' });
            else earlySettings.push(hashes);
          } else compareSettings(hashes);
        } catch { emit({ type: 'invalidated', reason: 'invalid-native-settings' }); }
        return;
      }
      emit(notification(event, expected.sessionId, now));
    };
    const disconnected = () => emit({ type: 'invalidated', reason: 'disconnected' });
    connection.on('notification', observe);
    connection.on('disconnected', disconnected);
    const close = async () => {
      if (closed) return;
      closed = true; buffered = []; earlySettings = []; securitySettings = null; confirmedSettings = null; fullSettings = null;
      connection.off('notification', observe); connection.off('disconnected', disconnected);
      await connection.close();
    };
    try {
      const nativeVersion = version(await connection.initialize());
      const state = await read(connection, expected, nativeVersion);
      // Recheck immediately before the documented running-thread rejoin. No
      // configuration override or offline-resume fallback is permitted.
      const checked = await read(connection, expected, nativeVersion);
      if (checked.fingerprint !== state.fingerprint) fail('native context changed before rejoin');
      const goal = await connection.request('thread/goal/get', { threadId: expected.sessionId });
      if (goal?.goal !== null) fail('active-goal-unsupported');
      if (invalidated) fail('native observation invalidated before rejoin');
      const resumed = await connection.request('thread/resume', { threadId: expected.sessionId, excludeTurns: true });
      if (metadata(resumed?.thread, expected, nativeVersion, state.ownerClientId).fingerprint !== state.fingerprint)
        fail('native context changed during rejoin');
      securitySettings = settingsHashes(resumed, { resume: true }).security;
      confirmedSettings = { model: digest(state.model), cwd: digest(state.cwd),
        effort: state.effort === 'native-default' ? null : digest(canonical(state.effort)) };
      // thread/read metadata can retain null/default effort while resume reports
      // the resolved value. Keep that metadata fingerprint independent.
      if (resumed.cwd !== expected.cwd) fail('native settings changed during rejoin');
      for (const hashes of earlySettings) { compareSettings(hashes); if (invalidated) break; }
      earlySettings = [];
      if (invalidated) fail('native settings invalidated during rejoin');
      const result = await connection.request('thread/turns/list', {
        threadId: expected.sessionId, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc',
      });
      if (!Array.isArray(result?.data) || result.data.length > 1) fail('invalid initial turn page');
      const turn = result.data[0];
      let initialTurn = null;
      if (turn) {
        const startedAt = seconds(turn.startedAt);
        if (!identifier(turn.id) || startedAt === null || !['inProgress', 'completed', 'failed', 'interrupted'].includes(turn.status)
          || turn.itemsView !== 'notLoaded' || !Array.isArray(turn.items) || turn.items.length) fail('invalid metadata-only initial turn');
        initialTurn = { id: turn.id, startedAt, status: turn.status };
      }
      return { state: checked, initialTurn,
        get settingsReady() { return !closed && !invalidated && fullSettings !== null; },
        listen() {
          if (closed || listening) return;
          listening = true;
          const pending = buffered; buffered = [];
          for (const event of pending) { if (closed) break; onEvent(event); }
        },
        async inspect() {
          if (closed || invalidated) fail('observer unavailable');
          if (fullSettings === null) fail('native-settings-unobserved');
          const result = await read(connection, expected, nativeVersion);
          if (closed || invalidated) fail('observer unavailable');
          return result;
        },
        async preflight() {
          if (closed || invalidated) fail('observer unavailable');
          if (fullSettings === null) fail('native-settings-unobserved');
          const handle = await owner(expected);
          if (closed || invalidated || handle.ownerClientId !== state.ownerClientId) { handle.close?.(); fail('native owner changed or observer unavailable'); }
          return handle;
        }, close,
      };
    } catch (error) { await close(); throw error; }
  }
  return { inspect, connect, verifyCommand };
}
