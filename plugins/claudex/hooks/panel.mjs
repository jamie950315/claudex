import { textChunks, taskInventoryCount } from './controller.mjs';
import { localizedUsage } from './localization.mjs';

// Presentation state belongs to the exact controller context, never a receipt.
const disclosures = new WeakMap();
const languages = [
  ['en', 'English'], ['zh-Hant', '繁體中文'], ['zh-Hans', '简体中文'],
  ['ja', '日本語'], ['ko', '한국어'], ['es', 'Español'], ['de', 'Deutsch'],
  ['fr', 'Français'], ['it', 'Italiano'],
];

export function renderPanel({ ui, state, controller, host, options, wake, t, language, setLanguage, languageError = '' }) {
  const { Box, Text, Button, Input, Select } = ui;
  let expanded = disclosures.get(state);
  if (!expanded) { expanded = new Set(); disclosures.set(state, expanded); }
  const text = (value, props = {}) => Text({ ...props, children: textChunks(value), wrap: 'wrap' });
  const muted = value => text(value, { dimColor: true });
  const button = (key, label, action, primary = false) => Button({ key, label,
    variant: primary ? 'primary' : 'secondary', dimColor: state.busy || undefined,
    onPress: async () => { if (controller.state === state && !controller.state.busy) await action(); } });
  const row = children => Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, rowGap: 0, children });
  const section = (title, children) => Box({ flexDirection: 'column', rowGap: 0, marginTop: 1,
    children: [text(title, { bold: true }), ...children] });
  const field = (label, value) => text(`${label}: ${value ?? t('Unknown')}`);
  const raw = value => {
    const serialized = JSON.stringify(value, null, 2) ?? '';
    return text(serialized.length <= 12000 ? serialized : `${serialized.slice(0, 12000)}\n${t('Preview truncated. Read the exact-ID status or receipt for the complete record.')}`);
  };
  const details = (key, value, title = t('Technical details')) => {
    const visible = expanded.has(key);
    return Box({ flexDirection: 'column', children: [Button({ key: `details-${key}`, plain: true,
      label: `${visible ? '▾' : '▸'} ${title}`, onPress: () => {
        if (controller.state !== state) return;
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
        host().redraw();
      } }), ...(visible ? [raw(value)] : [])] });
  };
  const status = value => typeof value === 'string' && value.startsWith('blocked-')
    ? t('Blocked: {code}', { code: value.slice('blocked-'.length) }) : ({
    ready: t('Ready'), running: t('Running'), waiting: t('Waiting'), queued: t('Queued'),
    completed: t('Completed'), failed: t('Failed'), cancelled: t('Cancelled'), uncertain: t('Uncertain'),
    prepared: t('Prepared'), dispatching: t('Dispatching'), accepted: t('Accepted'), rejected: t('Rejected'),
    acknowledged: t('Acknowledged'), offered: t('Offered'), stopped: t('Stopped'), disabled: t('Disabled'),
    idle: t('Idle'), listening: t('Listening'), 'waiting-for-children': t('Waiting for child tasks'),
    'handoff-pending': t('Handoff pending'), cancelling: t('Cancelling'),
    'not-started': t('Not started'), 'managed-worker': t('Managed worker'),
    'waiting-for-authorized-message': t('Waiting for an authorized message'),
    stopping: t('Stopping'), 'paused-by-app': t('Paused by app'),
    'connection-or-receipt-recovery': t('Recovering connection or receipt'), submitted: t('Submitted'),
  }[value] ?? value ?? t('Unknown'));
  const permission = value => ({ 'read-only': t('Read only'), 'workspace-write': t('Workspace write'),
    'full-access': t('Full access') }[value] ?? value ?? t('Unknown'));
  const modelFields = value => [
    field('Codex', value?.defaultModels?.codex ?? t('Native default')),
    field('Claude', value?.defaultModels?.claude ?? t('Native default')),
    ...(value?.defaultPermission ? [field(t('Default access'), permission(value.defaultPermission))] : []),
  ];
  const body = [row([text('Claudex', { bold: true }), muted(t('Work & conversations'))]),
    Select({ key: 'language', label: t('Language'), value: language,
      options: [{ value: 'system', label: t('Follow system') }, ...languages.map(([value, label]) => ({ value, label }))],
      onSelect: value => setLanguage(value) })];
  const tabs = [ ['overview', t('Overview')], ['tasks', t('Tasks')], ['chats', t('Chats')],
    ['compose', t('Compose')], ['inbox', t('Inbox')] ];
  const selectedTab = ['detail'].includes(state.tab) ? 'tasks'
    : ['confirm', 'receipt'].includes(state.tab) ? 'compose' : state.tab === 'wake-confirm' ? 'inbox' : state.tab;
  // Keep two rows even on a wide surface; wrapping also protects longer locales.
  for (const group of [tabs.slice(0, 3), tabs.slice(3)]) body.push(row(group.map(([tab, label]) =>
    button(`tab-${tab}`, label, () => controller.tab(host(), tab), selectedTab === tab))));
  body.push(muted(localizedUsage(state.usage, t)));
  if (languageError) body.push(section(t('Language setting'), [text(t.diagnostic(languageError))]));
  if (state.busy) body.push(text(t('Operation in progress. Duplicate submission is disabled.'), { bold: true }));
  if (state.error) body.push(section(t('Attention'), [text(t.diagnostic(state.error))]));
  if (state.notice && state.notice !== state.error) body.push(section(t('Update'), [text(t.diagnostic(state.notice))]));

  if (state.tab === 'overview') {
    const broker = state.doctor?.stopped ? t('Stopped by app') : state.tasks ? t('Responding') : t('Not verified');
    body.push(section(t('Connection'), [field(t('Broker'), broker),
      ...(options.nativeWake === true ? [field(t('Automatic delivery'), status(wake.state.status))] : []),
      button('refresh', t('Refresh status'), () => controller.refresh(host()), true)]));
    if (state.tasks) body.push(section(t('Work summary'), [
      field(t('Tasks'), taskInventoryCount(state.tasks)),
      ...(state.tasks.blockedByUncertainWork ? [text(t('Uncertain work needs inspection before overlapping writes.'))] : []),
      field(t('Worker limit'), state.tasks.limits?.maxWorkers),
      ...modelFields(state.tasks.limits), details('limits', state.tasks.limits),
    ]));
    body.push(section(t('Quick actions'), [
      button('handoff-codex', t('Append handoff draft for Codex'), () => controller.handoffDraft(host(), 'codex')),
      muted(t('Adds instructions to your draft. Nothing is submitted.')),
      button('model-defaults', t('Read provider defaults'), () => controller.read(host(), 'models', {}, 'detail')),
    ]));
    if (state.detail?.defaultModels) body.push(section(t('Provider defaults'), [
      ...modelFields(state.detail), details('models', state.detail),
    ]));
    body.push(section(t('Session & runtime'), [field(t('Engine'), state.version?.version),
      ...(state.context ? [field(t('Directory'), state.context.cwd)] : []),
      details('session', { session: state.context, runtime: state.version, usage: state.usage, doctor: state.doctor,
        configuration: state.configuration }),
      muted(t('Mod API baseline: 2.1.287; also validated on 2.1.286. Synchronization acceptance is separate.')),
    ]));
    if (options.nativeWake === true) body.push(details('delivery', wake.state,
      t('Delivery diagnostics')));
  } else if (state.tab === 'tasks') {
    const tasks = state.tasks?.tasks ?? [];
    body.push(section(t('Task inventory'), [button('tasks-refresh', t('Refresh tasks'), () => controller.refresh(host())),
      muted(t('{count} tasks · showing {first}–{last}', { count: taskInventoryCount(state.tasks),
        first: tasks.length ? Math.min(state.taskOffset + 1, tasks.length) : 0,
        last: Math.min(state.taskOffset + 10, tasks.length) }))]));
    if (!tasks.length) body.push(muted(t('No tasks in this inventory. Create a reviewed task from Compose.')));
    for (const task of tasks.slice(state.taskOffset, state.taskOffset + 10)) body.push(section(
      `${task.owner} · ${status(task.phase ?? task.status)}`, [field(t('Task ID'), task.id),
        button(`task-${task.id}`, t('Inspect task'), () => controller.task(host(), task.id))]));
    body.push(row([
      ...(state.taskOffset > 0 ? [button('tasks-prev', t('Previous 10'), () => controller.page(host(), -10))] : []),
      ...(state.taskOffset + 10 < tasks.length ? [button('tasks-next', t('Next 10'), () => controller.page(host(), 10))] : []),
    ]));
  } else if (state.tab === 'detail') {
    const task = state.detail;
    body.push(section(t('Task details'), [field(t('Task ID'), task?.id ?? state.selectedTask),
      field(t('Owner'), task?.owner), field(t('Status'), status(task?.phase ?? task?.status)),
      field(t('Model'), task?.model ?? t('Native default')), field(t('Access'), permission(task?.permission)),
      field(t('Project'), task?.projectRoot), ...(task?.error ? [text(task.error)] : []),
      ...(task?.result ? [details('task-result', task.result, t('Task result'))] : []), details('task', task)]));
    if (state.selectedTask) body.push(section(t('Task actions'), [
      button('task-refresh', t('Refresh exact task'), () => controller.task(host(), state.selectedTask)),
      button('task-followup', t('Compose follow-up'), () => controller.template(host(), 'send', {
        taskId: state.selectedTask, message: 'Describe the explicitly authorized follow-up.' })),
      button('task-cancel', t('Preview cancellation'), () => controller.prepare(host(), 'cancel', { taskId: state.selectedTask })),
    ]));
  } else if (state.tab === 'chats') {
    body.push(section(t('Find a conversation'), [Input({ key: 'chat-query', label: t('Title search'),
      value: state.chatQuery, submitLabel: t('Search'),
      onInput: value => { if (controller.state === state) { state.chatQuery = value; host().redraw(); } },
      onSubmit: value => { if (controller.state === state) return controller.searchChats(host(), value); } }),
      button('chats-list', t('List registered chats'), () => controller.searchChats(host(), '')),
      muted(t('Choose an exact ID. Duplicate titles and metadata errors remain visible.'))]));
    if (state.chats && !state.chats.chats?.length) body.push(muted(t('No matching conversations. Try another title.')));
    for (const chat of state.chats?.chats ?? []) {
      const items = [field(t('Provider'), chat.provider), field(t('Session ID'), chat.sessionId),
        field(t('Directory'), chat.cwd), ...(chat.titleError ? [field(t('Metadata error'), chat.titleError)] : [])];
      if (chat.title && !chat.titleError && !chat.archived) items.push(button(`chat-${chat.provider}-${chat.sessionId}`,
        t('Compose queue-only message'), () => controller.template(host(), 'chat_send', {
          provider: chat.provider, sessionId: chat.sessionId, expectedTitle: chat.title,
          message: 'Describe the explicitly authorized coordination note.', wake: false })));
      if (options.nativeWake === true && chat.provider === 'claude' && chat.title && !chat.titleError && !chat.archived)
        items.push(button(`inbox-${chat.sessionId}`, t('Inspect pending receipts'),
          () => controller.wakeList(host(), { sessionId: chat.sessionId, cwd: chat.cwd })));
      body.push(section(chat.title ?? t('Title unavailable'), items));
    }
    if (state.chats?.nextCursor) body.push(button('chats-next', t('Next page'),
      () => controller.searchChats(host(), state.chatQuery, state.chats.nextCursor)));
  } else if (state.tab === 'compose') {
    body.push(section(t('1 · Choose a starting point'), [
      button('template-codex', t('New read-only Codex task'), () => controller.template(host(), 'start', {
        provider: 'codex', cwd: state.context?.cwd, permission: 'read-only', prompt: 'Describe the task and relevant context explicitly.' })),
      button('template-claude', t('New read-only Claude task'), () => controller.template(host(), 'start', {
        provider: 'claude', cwd: state.context?.cwd, permission: 'read-only', prompt: 'Describe the task and relevant context explicitly.' })),
    ]));
    body.push(section(t('2 · Edit and preview'), [
      Input({ key: 'action-json', label: t('Action JSON'), value: state.form, submitLabel: t('Preview'),
        onInput: value => { if (controller.state === state) controller.edit(host(), value); },
        onSubmit: value => {
          if (controller.state !== state) return;
          controller.edit(host(), value); return controller.prepareJSON(host(), value);
        } }),
      muted(t('Enter prepares a preview only. Review the complete action before confirming.')),
      text(t('Native model work consumes account allowance.')),
      details('compose-help', {
        methods: ['start', 'send', 'cancel', 'chat_send', 'models'],
        modelAndEffort: t('Omit blank model or effort fields. null selects native CLI defaults.'),
        restrictions: t('Full-access and forced ownership changes stay outside this pane.'),
      }, t('Action format & limits')),
    ]));
  } else if (state.tab === 'confirm') {
    if (state.pending) body.push(section(t('3 · Review exact action'), [
      field(t('Operation'), state.pending.method), field(t('Receipt ID'), state.pending.id),
      field(t('Session ID'), state.pending.context?.sessionId), field(t('Directory'), state.pending.context?.cwd),
      field(t('State root'), options.stateRoot),
      // Unlike optional diagnostics, confirmation always includes every byte of params.
      text(JSON.stringify(state.pending.params, null, 2)),
      text(t('Confirm dispatches exactly this operation. Writable work needs disjoint files or a dedicated checkout. Cancellation retains existing edits.')),
      button('confirm-action', t('Confirm and dispatch once'), () => controller.commit(host()), true),
    ]));
    body.push(button('discard-action', t('Discard preview'), () => controller.discard(host())));
  } else if (state.tab === 'receipt') {
    body.push(section(t('Action receipt'), [field(t('Receipt ID'), state.lastReceipt?.id),
      field(t('Operation'), state.lastReceipt?.method), field(t('Status'), status(state.lastReceipt?.state)),
      text(t('Completed means the broker request returned. Task completion, delivery, ACK and cancellation exit need separate evidence.')),
      details('receipt', state.lastReceipt)]));
    if (state.lastReceipt?.id) body.push(button('receipt-refresh', t('Read receipt without dispatch'),
      () => controller.receipt(host(), state.lastReceipt.id)));
  } else if (state.tab === 'inbox') {
    body.push(section(t('Native message delivery'), [
      text(options.nativeWake === true
        ? t('Automatic delivery follows the broker route. mod-self needs only this loaded session; mod needs another sender. Native hold/refuse remains active.')
        : t('Native Mod delivery is disabled. Existing hooks still work; check the broker route for idle delivery.')),
      muted(t('A socket write or queue acceptance is not a recipient ACK.')),
      ...(options.nativeWake === true ? [field(t('Automatic delivery'), status(wake.state.status)),
        button('inbox-refresh', t('Refresh pending messages'), () => controller.wakeList(host()))] : []),
    ]));
    if (state.wakeTarget) body.push(section(t('Exact recipient'), [field(t('Session ID'), state.wakeTarget.sessionId),
      field(t('Directory'), state.wakeTarget.cwd),
      ...(!state.wakes.length ? [muted(t('No pending messages for this recipient.'))] : [])]));
    for (const message of state.wakes) body.push(section(t('Pending message'), [field(t('Message ID'), message.messageId),
      button(`wake-${message.messageId}`, t('Review delivery'), () => controller.previewWake(host(), message.messageId))]));
    if (options.nativeWake === true) body.push(details('inbox-delivery', wake.state, t('Delivery diagnostics')));
  } else if (state.tab === 'wake-confirm') {
    body.push(section(t('Review exact recipient'), [field(t('Message ID'), state.wakePreview?.messageId),
      field(t('Session ID'), state.wakePreview?.target?.sessionId), field(t('Directory'), state.wakePreview?.target?.cwd),
      text(t('Native queue processing can consume model allowance. Recipient policy remains active; uncertainty blocks automatic replay. Recipient ACK remains a separate check.')),
      button('wake-confirm', t('Confirm exact-recipient delivery'), () => controller.acceptWake(host()), true),
      button('wake-discard', t('Discard receipt preview'), () => controller.discard(host())),
    ]));
  }
  return Box({ flexDirection: 'column', paddingX: 1, paddingBottom: 1, children: body });
}
