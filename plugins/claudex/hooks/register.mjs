import { createController, shortJSON, usageLine, textChunks } from './controller.mjs';
import { createNativeWakePump } from './delivery.mjs';
const PANE = 'claudex';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validPath = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\r\n\0]/u.test(value);

function api($, options) {
  return {
    worker: async () => await $.env.get('CLAUDEX_COLLABORATION_WORKER') === '1',
    context: async () => ({ sessionId: await $.session.id(), cwd: await $.session.cwd() }),
    usage: () => $.session.usage(), version: () => $.session.version(),
    redraw: () => { $.ui.invalidate('ui.render'); },
    fill: args => $.prompt.fill(args),
    sendSession: args => $.session.send(args),
    tools: () => $.tool.list(),
    selfEnabled: options.selfWake === true,
    inbound: async () => (await $.settings.read()).crossSessionInbound,
    after: (ms, callback) => $.clock.after(ms, callback),
    bridge: async request => {
      if (await $.env.get('CLAUDEX_COLLABORATION_WORKER') === '1') throw new Error('Managed worker controller access is disabled.');
      if (!validPath(options.stateRoot) || !validPath(options.nodeBinary)) throw new Error('Stage and configure the Claudex companion with canonical root and Node paths.');
      const root = $.plugin.root;
      if (!validPath(root)) throw new Error('The native plugin root is unavailable.');
      const reply = await $.process.run([options.nodeBinary, `${root}/runtime/bin/claudex-mod-bridge.mjs`,
        '--root', options.stateRoot, ...(options.nativeWake === true ? ['--native-wake'] : []), ...(options.selfWake === true ? ['--self-wake'] : [])], {
        stdin: JSON.stringify(request), timeoutMs: request.op === 'wake-next' ? 35000 : 20000,
      });
      if (typeof reply.stdout !== 'string' || reply.stdout.length > 1024 * 1024) throw new Error('Companion output exceeded its bound. Inspect the existing receipt.');
      let decoded;
      try { decoded = JSON.parse(reply.stdout); } catch { throw new Error('Companion response was incomplete. Inspect the existing receipt; preserve uncertainty.'); }
      if (reply.exitCode !== 0 || decoded.ok !== true) {
        const error = new Error(`${decoded.error?.code ?? 'COMPANION_UNAVAILABLE'}: ${decoded.error?.message ?? 'Inspect the companion receipt and broker.'}`);
        error.code = decoded.error?.code ?? 'COMPANION_UNAVAILABLE'; throw error;
      }
      return decoded.result;
    },
  };
}

export function register(on, options = {}) {
  let lifecycle = 0;
  const controller = createController({ nativeWake: options.nativeWake === true });
  const wake = createNativeWakePump({ enabled: options.nativeWake === true });
  on('session.start', async ($, e, next) => {
    if (await $.env.get('CLAUDEX_COLLABORATION_WORKER') !== '1') {
      await $.command.register({ name: 'claudex', description: 'Open the Claudex control pane. /claudex receipt UUID inspects an action.', immediate: true });
      await controller.bind(api($, options));
      await controller.refreshUsage(api($, options));
      wake.start(api($, options));
    }
    return next(e);
  });
  on('classic.SessionStart', async ($, e, next) => {
    // Real settings hooks remain installed and keep their own native registration/ACK work.
    controller.reset();
    lifecycle++;
    wake.start(api($, options));
    $.ui.invalidate('ui.render');
    return next(e);
  });
  on('session.end', async ($, e, next) => { lifecycle++; controller.reset(); wake.stop(); $.ui.invalidate('ui.render'); return next(e); });
  on('session.receive', async ($, e, next) => {
    if (!e.text.startsWith('CLAUDEX_SELF_INBOX_V1\n')) return next(e);
    // This prefix is a routing hint, never authority. Read the original peer text
    // only from a live exact broker claim after checking the current native owner.
    const ticket = lifecycle;
    let phase = 'envelope';
    if (options.nativeWake !== true || options.selfWake !== true || e.agentId)
      return { consumed: 'Claudex own-inbox delivery is not enabled for this session.' };
    try {
      if (e.text.length > 8192) throw new Error('Invalid self-inbox envelope');
      const payload = JSON.parse(e.text.slice('CLAUDEX_SELF_INBOX_V1\n'.length));
      if (!payload || Object.keys(payload).some(key => !['messageId', 'claimId', 'target'].includes(key))) throw new Error('Invalid self-inbox envelope');
      const host = api($, options), context = await host.context();
      phase = 'context';
      if (ticket !== lifecycle || await host.worker()) throw new Error('Session changed');
      phase = 'claim';
      const result = await host.bridge({ version: 1, op: 'wake-self-receive', context, ...payload, route: 'mod-self' });
      phase = 'lifecycle';
      const current = await host.context();
      if (ticket !== lifecycle || current.sessionId !== context.sessionId || current.cwd !== context.cwd
        || result?.ready !== true || typeof result.context !== 'string' || result.context.length > 8192) throw new Error('Unverified self-inbox delivery');
      return next({ ...e, text: result.context });
    } catch (error) {
      const code = typeof error?.code === 'string' && /^[A-Z_]{1,48}$/.test(error.code) ? error.code : 'UNVERIFIED';
      controller.state.error = `Own-inbox receive blocked (${phase}: ${code}). Preserve the receipt; no automatic replay.`;
      $.ui.invalidate('ui.render');
      return { consumed: 'Claudex could not verify this own-inbox claim; it was not delivered or replayed.' };
    }
  });
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    await controller.refreshUsage(api($, options));
    $.ui.invalidate('ui.render');
    return result;
  });
  on('command.run', { command: 'claudex' }, async ($, e) => {
    if (await $.env.get('CLAUDEX_COLLABORATION_WORKER') === '1') return { text: 'Use this managed worker\'s existing generation-scoped MCP tools.' };
    await controller.bind(api($, options));
    const words = (e.args ?? '').trim().split(/\s+/u).filter(Boolean);
    if (words[0] === 'receipt' && UUID.test(words[1] ?? '') && words.length === 2) await controller.receipt(api($, options), words[1]);
    else if (words.length) return { text: 'Use /claudex or /claudex receipt UUID.' };
    else await controller.refresh(api($, options));
    await $.ui.open({ id: PANE, title: 'Claudex', focus: true, closeOnEscape: true, columns: 64 });
    return {};
  });
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const original = await next(e);
    if (await $.env.get('CLAUDEX_COLLABORATION_WORKER') === '1') return original;
    const ticket = await controller.bind(api($, options));
    if (!ticket) return original;
    const { Box, Text } = $.ui.resolve(e);
    if (e.props.maxRows < 1) return original;
    const children = [Text({ wrap: 'truncate', children: [`Claudex | ${usageLine(controller.state.usage)} | /claudex`] })];
    if (original !== null && original !== undefined) children.push(original);
    return Box({ flexDirection: 'column', children });
  });
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE || await $.env.get('CLAUDEX_COLLABORATION_WORKER') === '1') return next(e);
    await controller.bind(api($, options));
    const state = controller.state;
    const { Box, Text, Button, Input } = $.ui.resolve(e);
    const text = value => Text({ children: textChunks(value), wrap: 'wrap' });
    const button = (key, label, action) => Button({ key, label, onPress: async () => { if (!controller.state.busy) await action(); } });
    const host = () => api($, options);
    const body = [];
    const tabs = ['overview', 'tasks', 'chats', 'compose', 'inbox'];
    // Desktop split panes can be narrower than the requested terminal columns.
    for (const row of [tabs.slice(0, 3), tabs.slice(3)])
      body.push(Box({ flexDirection: 'row', columnGap: 1, children: row.map(tab => button(`tab-${tab}`, tab, () => controller.tab(host(), tab))) }));
    body.push(text(state.busy ? 'Operation in progress. Duplicate submission is disabled.' : usageLine(state.usage)));
    if (options.nativeWake === true) body.push(text(`Automatic native delivery: ${wake.state.status}\n${wake.state.lastOutcome ? shortJSON(wake.state.lastOutcome) : 'Only explicitly wake-enabled broker messages are eligible.'}`));
    if (state.context) body.push(text(`Session ${state.context.sessionId}\n${state.context.cwd}`));
    if (state.error) body.push(text(`Attention: ${state.error}`));
    if (state.notice) body.push(text(state.notice));
    if (state.tab === 'overview') {
      body.push(button('refresh', 'Refresh status', () => controller.refresh(host())));
      body.push(text(`Engine: ${state.version?.version ?? 'unknown'}\nPublic Mod API baseline: 2.1.287 (not a load gate)\nNative validation also passed on 2.1.286.\nSynchronization version acceptance: separate; configured policy retained.`));
      body.push(text(shortJSON(state.doctor ?? { status: 'Run Refresh status to inspect the configured root.' })));
      body.push(text(shortJSON(state.tasks?.limits ?? {})));
      body.push(button('handoff-codex', 'Append reviewed handoff draft to Codex', () => controller.handoffDraft(host(), 'codex')));
      body.push(button('model-defaults', 'Read provider defaults', () => controller.read(host(), 'models', {}, 'detail')));
      if (state.detail) body.push(text(shortJSON(state.detail)));
    } else if (state.tab === 'tasks') {
      body.push(button('tasks-refresh', 'Refresh task inventory', () => controller.refresh(host())));
      const tasks = state.tasks?.tasks ?? [];
      body.push(text(`${tasks.length} tasks; showing ${tasks.length ? Math.min(state.taskOffset + 1, tasks.length) : 0}-${Math.min(state.taskOffset + 10, tasks.length)}.`));
      for (const task of tasks.slice(state.taskOffset, state.taskOffset + 10)) {
        body.push(button(`task-${task.id}`, `${task.owner} | ${task.status} | ${task.id}`, () => controller.task(host(), task.id)));
      }
      if (state.taskOffset > 0) body.push(button('tasks-prev', 'Previous 10', () => controller.page(host(), -10)));
      if (state.taskOffset + 10 < tasks.length) body.push(button('tasks-next', 'Next 10', () => controller.page(host(), 10)));
    } else if (state.tab === 'detail') {
      body.push(text(shortJSON(state.detail)));
      if (state.selectedTask) {
        body.push(button('task-refresh', 'Refresh exact task', () => controller.task(host(), state.selectedTask)));
        body.push(button('task-followup', 'Compose follow-up', () => controller.template(host(), 'send', { taskId: state.selectedTask, message: 'Describe the explicitly authorized follow-up.' })));
        body.push(button('task-cancel', 'Preview cancellation', () => controller.prepare(host(), 'cancel', { taskId: state.selectedTask })));
      }
    } else if (state.tab === 'chats') {
      body.push(Input({ key: 'chat-query', label: 'Title search', value: state.chatQuery, submitLabel: 'search',
        onSubmit: value => controller.searchChats(host(), value) }));
      body.push(button('chats-list', 'List registered chats', () => controller.searchChats(host(), '')));
      body.push(text('Choose an exact ID. Duplicate titles and metadata errors remain visible.'));
      for (const chat of state.chats?.chats ?? []) {
        body.push(text(`${chat.provider} | ${chat.title ?? '[title unavailable]'} | ${chat.sessionId}\n${chat.cwd ?? ''}${chat.titleError ? `\nMetadata error: ${chat.titleError}` : ''}`));
        if (chat.title && !chat.titleError && !chat.archived) body.push(button(`chat-${chat.provider}-${chat.sessionId}`, 'Compose queue-only message',
          () => controller.template(host(), 'chat_send', { provider: chat.provider, sessionId: chat.sessionId,
            expectedTitle: chat.title, message: 'Describe the explicitly authorized coordination note.', wake: false })));
        if (options.nativeWake === true && chat.provider === 'claude' && chat.title && !chat.titleError && !chat.archived)
          body.push(button(`inbox-${chat.sessionId}`, 'Inspect native pending receipts for this session',
            () => controller.wakeList(host(), { sessionId: chat.sessionId, cwd: chat.cwd })));
      }
      if (state.chats?.nextCursor) body.push(button('chats-next', 'Next page', () => controller.searchChats(host(), state.chatQuery, state.chats.nextCursor)));
    } else if (state.tab === 'compose') {
      body.push(text('Edit JSON, press Enter to prepare, then review the complete action. Native model work consumes account allowance.'));
      body.push(button('template-codex', 'New read-only Codex task', () => controller.template(host(), 'start', {
        provider: 'codex', cwd: state.context?.cwd, permission: 'read-only', prompt: 'Describe the task and relevant context explicitly.' })));
      body.push(button('template-claude', 'New read-only Claude task', () => controller.template(host(), 'start', {
        provider: 'claude', cwd: state.context?.cwd, permission: 'read-only', prompt: 'Describe the task and relevant context explicitly.' })));
      body.push(Input({ key: 'action-json', label: 'Action JSON', value: state.form, submitLabel: 'preview',
        onSubmit: value => { controller.edit(host(), value); return controller.prepareJSON(host(), value); } }));
      body.push(text('Supported writes: start, send, cancel, chat_send, models. Blank model/effort fields should be omitted; null selects native CLI defaults. Full-access and forced ownership changes stay outside this pane.'));
    } else if (state.tab === 'confirm') {
      if (state.pending) {
        body.push(text(`${state.pending.method} | receipt ${state.pending.id}\nState root: ${options.stateRoot}\n${JSON.stringify(state.pending.params, null, 2)}`));
        body.push(text('Confirm dispatches exactly this operation. Writable work needs disjoint files or a dedicated checkout. Cancellation retains existing edits.'));
        body.push(button('confirm-action', 'Confirm and dispatch once', () => controller.commit(host())));
      }
      body.push(button('discard-action', 'Discard preview', () => controller.discard(host())));
    } else if (state.tab === 'receipt') {
      body.push(text(shortJSON(state.lastReceipt)));
      body.push(text('completed = broker request returned. Task completion, delivery, ACK and cancellation exit each require their own status evidence.'));
      if (state.lastReceipt?.id) body.push(button('receipt-refresh', 'Read existing receipt (no dispatch)', () => controller.receipt(host(), state.lastReceipt.id)));
    } else if (state.tab === 'inbox') {
      body.push(text(options.nativeWake === true ? 'Automatic delivery follows the broker route. The opt-in mod-self route needs only this session; the mod route needs another sender. Native hold/refuse stays effective. A socket write or queue acceptance is not ACK.' : 'Native Mod delivery disabled in this session. Existing hooks still work; check the broker route for idle delivery.'));
      if (options.nativeWake === true) body.push(button('inbox-refresh', 'Refresh identity-only pending messages', () => controller.wakeList(host())));
      if (state.wakeTarget) body.push(text(`Recipient ${state.wakeTarget.sessionId}\n${state.wakeTarget.cwd}`));
      for (const wake of state.wakes) body.push(button(`wake-${wake.messageId}`, wake.messageId, () => controller.previewWake(host(), wake.messageId)));
    } else if (state.tab === 'wake-confirm') {
      body.push(text(`Deliver ${state.wakePreview?.messageId} to exact Claude session ${state.wakePreview?.target?.sessionId}. Native queue processing can consume model allowance. Recipient policy remains active; uncertainty blocks automatic replay. Recipient ACK remains a separate check.`));
      body.push(button('wake-confirm', 'Confirm exact-recipient queue delivery', () => controller.acceptWake(host())));
      body.push(button('wake-discard', 'Discard receipt preview', () => controller.discard(host())));
    }
    return Box({ flexDirection: 'column', children: body });
  });
}
