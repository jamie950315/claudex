// Diagnostics describe observed native output, not liveness, useful progress,
// execution success, or independently verified fulfillment of a user's goal.
export const NATIVE_ACTIVITY_INTERVAL_MS = 2000;
const MAX_RECENT = 16;
const MAX_MODELS = 4;
const kinds = new Set(['session', 'turn-start', 'message', 'tool-start', 'tool-end', 'native-event', 'completion']);
const scopes = new Set(['main', 'auxiliary']);
const toolKinds = new Set(['command', 'mcp', 'file-change', 'web-search', 'native-tool']);
const sources = new Set(['claude:system.init', 'claude:assistant.message.model',
  'claude:stream_event.message_start.model', 'claude:result.modelUsage']);
const time = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(value) ? value : null;

function modelEvidence(value) {
  if (!value || !modelId(value.model) || !sources.has(value.source) || time(value.observedAt) === null) return null;
  return { model: value.model, source: value.source, observedAt: value.observedAt };
}

/** Allowlisted clone for runner/hub boundaries, including injected runners. */
export function sanitizeNativeActivity(value) {
  if (!value || !['codex', 'claude'].includes(value.provider)) return null;
  const recent = (Array.isArray(value.recent) ? value.recent.slice(-MAX_RECENT) : []).flatMap(event => {
    if (!event || !kinds.has(event.kind) || !scopes.has(event.scope) || time(event.at) === null) return [];
    return [{ kind: event.kind, scope: event.scope, at: event.at,
      ...(toolKinds.has(event.toolKind) ? { toolKind: event.toolKind } : {}) }];
  });
  const configuration = value.provider === 'claude' && value.models?.configuration?.source === 'claude:system.init'
    ? modelEvidence(value.models.configuration) : null;
  const main = (value.provider === 'claude' && Array.isArray(value.models?.main) ? value.models.main.slice(-MAX_MODELS) : [])
    .map(modelEvidence).filter(entry => entry && entry.source !== 'claude:system.init' && entry.source !== 'claude:result.modelUsage');
  const auxiliary = (value.provider === 'claude' && Array.isArray(value.models?.auxiliary) ? value.models.auxiliary.slice(-MAX_MODELS) : [])
    .map(modelEvidence).filter(Boolean);
  const unclassified = (value.provider === 'claude' && Array.isArray(value.models?.unclassified) ? value.models.unclassified.slice(-MAX_MODELS) : [])
    .map(modelEvidence).filter(entry => entry?.source === 'claude:result.modelUsage');
  const completion = value.completion && time(value.completion.observedAt) !== null
    && ['codex:turn.completed', 'codex:turn.failed', 'claude:result'].includes(value.completion.source)
    && value.completion.source.startsWith(`${value.provider}:`)
    && ['success', 'failed'].includes(value.completion.outcome)
    ? { source: value.completion.source, outcome: value.completion.outcome, observedAt: value.completion.observedAt } : null;
  return { provider: value.provider, lastNativeEventAt: time(value.lastNativeEventAt), eventCount: count(value.eventCount),
    recent, completion, models: { status: main.length ? 'native-reported' : 'unverified',
      configuration, main, auxiliary, unclassified } };
}

export function createNativeActivity(provider, { now = Date.now } = {}) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('Invalid native activity provider.');
  const state = { provider, lastNativeEventAt: null, eventCount: 0, recent: [], completion: null,
    models: { configuration: null, main: [], auxiliary: [], unclassified: [] } };
  const addModel = (target, model, source, at) => {
    if (!modelId(model)) return;
    const entry = { model, source, observedAt: at };
    if (target === 'configuration') { state.models.configuration = entry; return; }
    const list = state.models[target];
    const index = list.findIndex(item => item.model === model && item.source === source);
    if (index >= 0) list.splice(index, 1);
    list.push(entry);
    if (list.length > MAX_MODELS) list.shift();
  };
  const add = (kind, scope, at, toolKind) => {
    const previous = state.recent.at(-1);
    // Token streams retain their latest receipt without allocating a log per token.
    if (previous?.kind === kind && previous.scope === scope && previous.toolKind === toolKind
      && ['native-event', 'message'].includes(kind)) previous.at = at;
    else {
      state.recent.push({ kind, scope, at, ...(toolKind ? { toolKind } : {}) });
      if (state.recent.length > MAX_RECENT) state.recent.shift();
    }
  };
  return {
    snapshot: () => sanitizeNativeActivity(state),
    observe(event) {
      if (!event || typeof event.type !== 'string'
        || ['spawn', 'session', 'processes', 'process-inspection-failed'].includes(event.type)) return null;
      const at = time(now());
      if (at === null) return null;
      state.lastNativeEventAt = at;
      state.eventCount = Math.min(Number.MAX_SAFE_INTEGER, state.eventCount + 1);
      const scope = event.parent_tool_use_id != null || event.isSidechain === true || event.is_sidechain === true
        ? 'auxiliary' : 'main';
      let kind = 'native-event', toolKind;
      if (provider === 'codex') {
        if (event.type === 'thread.started') kind = 'session';
        if (event.type === 'turn.started') kind = 'turn-start';
        const nativeTool = { command_execution: 'command', mcp_tool_call: 'mcp', file_change: 'file-change', web_search: 'web-search' }[event.item?.type];
        if (nativeTool && ['item.started', 'item.completed'].includes(event.type)) {
          kind = event.type === 'item.started' ? 'tool-start' : 'tool-end'; toolKind = nativeTool;
        } else if (event.item?.type === 'agent_message') kind = 'message';
        if (scope === 'main' && ['turn.completed', 'turn.failed'].includes(event.type)) {
          kind = 'completion'; state.completion = { source: `codex:${event.type}`,
            outcome: event.type === 'turn.completed' ? 'success' : 'failed', observedAt: at };
        }
      } else {
        if (event.type === 'system' && event.subtype === 'init') {
          kind = 'session';
          addModel(scope === 'main' ? 'configuration' : 'auxiliary', event.model, 'claude:system.init', at);
        }
        if (event.type === 'assistant') {
          kind = 'message';
          addModel(scope, event.message?.model, 'claude:assistant.message.model', at);
        }
        if (event.type === 'stream_event' && event.event?.type === 'message_start') {
          kind = 'message';
          addModel(scope, event.event.message?.model, 'claude:stream_event.message_start.model', at);
        }
        const content = Array.isArray(event.message?.content) ? event.message.content : [];
        // A native assistant message may contain several tool calls. Retain only
        // bounded type-level evidence, never names, IDs, arguments, or results.
        for (const block of content) {
          if (event.type === 'assistant' && block?.type === 'tool_use') add('tool-start', scope, at, 'native-tool');
          if (event.type === 'user' && block?.type === 'tool_result') add('tool-end', scope, at, 'native-tool');
        }
        if (event.type === 'result') {
          if (scope === 'main' && typeof event.is_error === 'boolean') {
            kind = 'completion'; state.completion = { source: 'claude:result',
              outcome: event.is_error ? 'failed' : 'success', observedAt: at };
          }
          // Aggregate accounting can include sidechains; it does not identify
          // the primary response model or prove that it switched models.
          if (event.modelUsage && typeof event.modelUsage === 'object' && !Array.isArray(event.modelUsage))
            for (const model of Object.keys(event.modelUsage).slice(0, MAX_MODELS))
              addModel('unclassified', model, 'claude:result.modelUsage', at);
        }
      }
      add(kind, scope, at, toolKind);
      return sanitizeNativeActivity(state);
    },
  };
}
