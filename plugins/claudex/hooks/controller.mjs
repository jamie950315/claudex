/** User-facing control state. New operations require preview/confirmation;
 * delivery.mjs separately handles previously authorized broker messages. */
import { deliverNativeWake } from './delivery.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const same = (a, b) => a?.sessionId === b?.sessionId && a?.cwd === b?.cwd;
const message = error => typeof error?.message === 'string' ? error.message : 'Companion operation failed.';
export function shortJSON(value, limit = 12000) {
  const text = JSON.stringify(value, null, 2) ?? '';
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[UI preview truncated. Use the exact-ID status/receipt workflow for the complete record.]`;
}
export function textChunks(value, limit = 8000) {
  const text = String(value), chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks.length ? chunks : [''];
}
export function usageLine(usage) {
  const valid = value => Number.isFinite(value) && value >= 0;
  const context = valid(usage?.context?.percent) ? `${usage.context.percent.toFixed(1)}%` : 'unknown';
  const rates = Array.isArray(usage?.rateLimits) ? usage.rateLimits
    .filter(item => typeof item.kind === 'string' && valid(item.percentUsed))
    .map(item => `${item.kind} ${item.percentUsed.toFixed(1)}%`).join(' | ') : '';
  return `Context ${context}${rates ? ` | ${rates}` : ''}`;
}
function blank(context = null, epoch = 0) {
  return { context, epoch, enabled: false, busy: false, tab: 'overview', error: '', notice: '',
    usage: null, version: null, doctor: null, tasks: null, chats: null, chatQuery: '', chatCursor: null,
    taskOffset: 0, selectedTask: null, detail: null, pending: null, lastReceipt: null,
    wakes: [], wakeTarget: null, wakePreview: null, form: '' };
}
export function createController({ nativeWake = false } = {}) {
  let state = blank();
  const changed = api => { api.redraw(); };
  function reset() { state = blank(null, state.epoch + 1); }
  async function bind(api) {
    if (await api.worker()) { reset(); return null; }
    const current = await api.context();
    if (!uuid.test(current?.sessionId ?? '') || typeof current?.cwd !== 'string' || !current.cwd.startsWith('/')) {
      reset(); return null;
    }
    current.sessionId = current.sessionId.toLowerCase();
    if (!same(current, state.context)) state = blank(current, state.epoch + 1);
    state.enabled = true;
    return { context: { ...current }, epoch: state.epoch };
  }
  function current(ticket) { return ticket?.epoch === state.epoch && same(ticket.context, state.context); }
  async function stillBound(api, ticket) {
    const value = await bind(api);
    return value !== null && current(ticket);
  }
  async function run(api, action) {
    const ticket = await bind(api);
    if (!ticket || state.busy) return;
    state.busy = true; state.error = ''; changed(api);
    try { return await action(ticket); }
    catch (error) { if (current(ticket)) state.error = message(error); }
    finally { if (current(ticket)) state.busy = false; changed(api); }
  }
  const call = (api, ticket, op, more = {}) => api.bridge({ version: 1, op, context: ticket.context, ...more });
  async function read(api, method, params = {}, key = 'detail') {
    return run(api, async ticket => {
      const result = await call(api, ticket, 'read', { method, params });
      if (await stillBound(api, ticket)) state[key] = result;
      return result;
    });
  }
  return {
    get state() { return state; }, reset, bind,
    tab(api, tab) { state.tab = tab; changed(api); },
    edit(api, text) { state.form = text; changed(api); },
    page(api, delta) { state.taskOffset = Math.max(0, state.taskOffset + delta); changed(api); },
    async refresh(api) {
      return run(api, async ticket => {
        const doctor = await call(api, ticket, 'doctor');
        // Even status calls stay tied to one root and one exact native session.
        const [usage, version] = await Promise.all([api.usage().catch(() => null), api.version().catch(() => null)]);
        let tasks = null;
        if (!doctor.stopped) tasks = await call(api, ticket, 'read', { method: 'list', params: {} });
        if (await stillBound(api, ticket)) Object.assign(state, { doctor, usage, version, tasks });
      });
    },
    async refreshUsage(api) {
      const ticket = await bind(api);
      if (!ticket) return;
      const usage = await api.usage().catch(() => null);
      if (current(ticket)) state.usage = usage;
    },
    async searchChats(api, query, cursor) {
      return run(api, async ticket => {
        const params = { limit: 12, ...(query.trim() ? { query, match: 'contains' } : {}), ...(cursor ? { cursor } : {}) };
        const result = await call(api, ticket, 'read', { method: 'chat_list', params });
        if (await stillBound(api, ticket)) Object.assign(state, { chats: result, chatQuery: query, chatCursor: cursor ?? null });
      });
    },
    async task(api, id) {
      return run(api, async ticket => {
        const result = await call(api, ticket, 'read', { method: 'status', params: { taskId: id, view: 'summary' } });
        if (await stillBound(api, ticket)) Object.assign(state, { selectedTask: id, tab: 'detail', detail: result });
      });
    },
    read,
    async prepare(api, method, params) {
      return run(api, async ticket => {
        if (state.pending || ['dispatching', 'uncertain', 'locked'].includes(state.lastReceipt?.state))
          throw new Error('Inspect or discard the current preview; preserve any uncertain receipt before preparing further work.');
        const result = await call(api, ticket, 'prepare', { method, params });
        if (await stillBound(api, ticket)) {
          if (result.state !== 'prepared' || typeof result.id !== 'string') throw new Error('An equivalent preview is locked. Inspect the existing receipt before preparing again.');
          // Confirm controls always display the complete action, including directory grants.
          if (JSON.stringify(result.params).length > 20000) throw new Error(`Action ${result.id} exceeds the full-preview UI bound. Use the operator workflow; it remains uncommitted.`);
          state.pending = result; state.tab = 'confirm'; state.notice = 'Prepared only. Confirm explicitly to dispatch.';
        }
      });
    },
    async prepareJSON(api, raw) {
      let value;
      try {
        if (raw.length > 24000) throw new Error('Action JSON exceeds 24,000 characters.');
        value = JSON.parse(raw);
        if (!value || typeof value.method !== 'string' || !value.params || Object.keys(value).some(key => !['method', 'params'].includes(key)))
          throw new Error('Use {"method":"start","params":{...}}.');
      } catch (error) { state.error = message(error); changed(api); return; }
      return this.prepare(api, value.method, value.params);
    },
    discard(api) { state.pending = null; state.wakePreview = null; state.tab = 'overview'; state.notice = 'Preview discarded; the prepared audit record remains local.'; changed(api); },
    async commit(api) {
      const captured = state.pending;
      if (!captured) return;
      return run(api, async ticket => {
        if (!same(captured.context, ticket.context) || state.pending?.id !== captured.id)
          throw new Error('Session or preview changed; the old action was left uncommitted.');
        // Clear the button before awaiting dispatch, including transport failures.
        state.pending = null;
        state.lastReceipt = { ...captured, state: 'dispatching', automaticReplay: false };
        state.tab = 'receipt'; changed(api);
        try {
          const result = await call(api, ticket, 'commit', { id: captured.id });
          if (await stillBound(api, ticket)) state.lastReceipt = { ...captured, ...result };
        } catch {
          if (current(ticket)) state.lastReceipt = { ...captured, state: 'uncertain', automaticReplay: false };
          throw new Error(`Dispatch outcome requires inspection. Receipt ${captured.id}; automatic replay is disabled.`);
        }
      });
    },
    async receipt(api, id) {
      return run(api, async ticket => {
        const result = await call(api, ticket, 'receipt', { id });
        if (await stillBound(api, ticket)) { state.lastReceipt = result; state.tab = 'receipt'; }
      });
    },
    template(api, method, params) {
      state.form = JSON.stringify({ method, params }); state.tab = 'compose'; changed(api);
    },
    async handoffDraft(api, destination = 'codex') {
      return run(api, async ticket => {
        const draft = `Prepare a Claudex handoff to ${destination}. Summarize completed work, exact files, tests, constraints and remaining work. Use the existing claudex-work MCP protocol. For an existing managed task, its current owner must call claudex_handoff with its latest revision, then finish with CLAUDEX_HANDOFF. For this external native chat, create an explicitly authorized root delegation and stop your own edits after the acknowledged handoff. Preserve directory grants and uncertain outcomes. Do not switch models or native histories by editing databases. Ask for any genuinely missing authorization before model work.\n`;
        if (await stillBound(api, ticket)) {
          const result = await api.fill({ text: `\n${draft}`, mode: 'append' });
          state.notice = result?.isFilled ? 'Handoff instructions appended to the draft. Review and submit manually.' : 'The native composer could not accept the draft.';
        }
      });
    },
    async wakeList(api, target) {
      if (!nativeWake) { state.error = 'Native receipt is disabled until local acceptance.'; changed(api); return; }
      return run(api, async ticket => {
        const exactTarget = target ?? state.wakeTarget ?? ticket.context;
        const result = await call(api, ticket, 'wake-peek', { target: exactTarget });
        if (await stillBound(api, ticket)) { state.wakes = result.messages; state.wakeTarget = result.target ?? exactTarget; state.tab = 'inbox'; }
      });
    },
    previewWake(api, id) {
      if (!nativeWake || !state.wakes.some(item => item.messageId === id)) return;
      state.wakePreview = { messageId: id, context: { ...state.context }, target: { ...(state.wakeTarget ?? state.context) } }; state.tab = 'wake-confirm'; changed(api);
    },
    async acceptWake(api) {
      const preview = state.wakePreview;
      if (!nativeWake || !preview) return;
      return run(api, async ticket => {
        if (!same(preview.context, ticket.context)) throw new Error('Session changed; refresh exact pending messages.');
        state.wakePreview = null;
        const outcome = await deliverNativeWake(api, ticket.context, preview.target, preview.messageId, () => current(ticket));
        if (current(ticket)) {
          if (outcome.state !== 'waiting') state.wakes = state.wakes.filter(item => item.messageId !== preview.messageId);
          state.notice = outcome.state === 'accepted'
            ? 'Native recipient queue accepted the message. Recipient ACK and requested-work completion remain separate checks.'
            : `Native delivery: ${outcome.state} (${outcome.reason}). ${outcome.nativeReason ?? ''} No automatic resend.`;
          if (['rejected', 'uncertain'].includes(outcome.state)) state.error = state.notice;
          state.tab = 'inbox';
        }
      });
    },
  };
}
