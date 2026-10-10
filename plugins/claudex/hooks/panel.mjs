import { textChunks, taskInventoryCount, WARM_LIMIT_PRESETS } from './controller.mjs';
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
  const details = (key, value, title = t('Technical details'), complete = false) => {
    const visible = expanded.has(key);
    return Box({ flexDirection: 'column', children: [Button({ key: `details-${key}`, plain: true,
      label: `${visible ? '▾' : '▸'} ${title}`, onPress: () => {
        if (controller.state !== state) return;
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
        host().redraw();
      } }), ...(visible ? [complete ? text(JSON.stringify(value, null, 2)) : raw(value)] : [])] });
  };
  const status = value => typeof value === 'string' && value.startsWith('blocked-')
    ? t('Blocked: {code}', { code: value.slice('blocked-'.length) }) : ({
    ready: t('Ready'), running: t('Running'), waiting: t('Waiting'), queued: t('Queued'), paused: t('Paused'),
    'pause-pending': t('Pause pending'),
    open: t('Open'), responded: t('Responded'), resolved: t('Resolved'), requested: t('Requested'),
    checkpoint: t('Checkpoint acknowledged'), resumed: t('Resumed'), 'not-paused': t('Not paused'),
    reviewed: t('Reviewed'), integrated: t('Integrated'),
    passed: t('Passed'), 'not-run': t('Not run'), unverified: t('Unverified'),
    collecting: t('Collecting'), 'not-collected': t('Not collected'), collected: t('Collected'),
    'paused-capacity': t('Collection paused at capacity'),
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
  const taskCard = (task, depth = 0) => {
    const branch = state.children?.[task.id];
    return section(`${'↳ '.repeat(depth)}${task.owner} · ${status(task.phase ?? task.status)}`, [
      field(t('Task ID'), task.id), ...(task.objective ? [text(task.objective)] : []),
      ...(task.parentId ? [field(t('Parent task'), task.parentId)] : []),
      ...(task.progress?.stage ? [field(t('Stage'), task.progress.stage)] : []),
      row([button(`task-${task.id}-${depth}`, t('Inspect task'), () => controller.task(host(), task.id)),
        ...(depth < 3 ? [button(`children-${task.id}-${depth}`, branch ? t('Collapse children') : t('Expand children'),
          () => controller.children(host(), task.id))] : [])]),
      ...(branch ? [...(branch.tasks ?? []).map(child => taskCard(child, depth + 1)),
        ...(branch.nextCursor ? [button(`children-next-${task.id}`, t('Next page'),
          () => controller.children(host(), task.id, branch.nextCursor))] : [])] : []),
    ]);
  };
  const body = [row([text('Claudex', { bold: true }), muted(t('Work & conversations'))]),
    Select({ key: 'language', label: t('Language'), value: language,
      options: [{ value: 'system', label: t('Follow system') }, ...languages.map(([value, label]) => ({ value, label }))],
      onSelect: value => setLanguage(value) })];
  const tabs = [ ['overview', t('Overview')], ['tasks', t('Tasks')], ['chats', t('Chats')],
    ['compose', t('Compose')], ['inbox', t('Inbox')], ['cache', t('Cache settings')] ];
  const selectedTab = ['detail'].includes(state.tab) ? 'tasks'
    : ['confirm', 'receipt'].includes(state.tab) ? 'compose' : state.tab === 'wake-confirm' ? 'inbox' : state.tab;
  // Keep two rows even on a wide surface; wrapping also protects longer locales.
  for (const group of [tabs.slice(0, 3), tabs.slice(3)]) body.push(row(group.map(([tab, label]) =>
    button(`tab-${tab}`, label, () => tab === 'cache' ? controller.cacheRefresh(host()) : controller.tab(host(), tab), selectedTab === tab))));
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
  } else if (state.tab === 'cache') {
    const cache = state.cacheStatus;
    const modes = { session: t('This process only'), remember: t('Remember last TTL'), default: t('Fixed startup TTL') };
    body.push(section(t('Cache settings'), [
      field(t('Current native TTL'), cache?.nativeCache?.value),
      field(t('Saved startup mode'), modes[cache?.ttlPreference?.mode] ?? t('Unknown')),
      ...(cache?.ttlPreference?.ttl ? [field(t('Saved TTL'), cache.ttlPreference.ttl)] : []),
      field(t('Default warming limit'), cache?.defaultLimit),
      field(t('Cache warming'), cache ? cache.local?.enabled ? t('Enabled') : t('Disabled') : t('Unknown')),
      ...(cache?.local?.ttlRestore?.state === 'failed' ? [text(cache.local.ttlRestore.error)] : []),
      button('cache-refresh', t('Refresh status'), () => controller.cacheRefresh(host())),
      details('cache-native', cache),
    ]));
    body.push(section(t('TTL and startup behavior'), [
      Select({ key: 'cache-ttl', label: t('Cache TTL'), value: state.cacheForm.ttl,
        options: [{ value: '1h', label: t('1 hour') }, { value: '5m', label: t('5 minutes') }],
        onSelect: value => { if (controller.state === state) controller.cacheEdit(host(), 'ttl', value); } }),
      Select({ key: 'cache-mode', label: t('Startup behavior'), value: state.cacheForm.mode,
        options: Object.entries(modes).map(([value, label]) => ({ value, label })),
        onSelect: value => { if (controller.state === state) controller.cacheEdit(host(), 'mode', value); } }),
      muted(t('Remember follows later confirmed TTL choices. Fixed default restores the selected TTL at startup. This process only disables restoration.')),
      row([button('cache-preview-ttl', t('Preview current TTL change'), () => controller.cachePrepare(host(), 'ttl')),
        button('cache-preview-preference', t('Preview startup preference'), () => controller.cachePrepare(host(), 'preference'))]),
      text(t('Changing these settings stops local warming; it never enables model work. One-hour cache writes may cost more.')),
      muted(t('Global Claude settings, subagent TTL and other running sessions are unchanged.')),
    ]));
    body.push(section(t('Default warming limit'), [
      // A limit saved by command may not be one of the offered choices.
      Select({ key: 'cache-limit', label: t('Default warming limit'), value: state.cacheForm.limit,
        options: [...new Set([...WARM_LIMIT_PRESETS, state.cacheForm.limit])].map(value => ({ value, label: value })),
        onSelect: value => { if (controller.state === state) controller.cacheEdit(host(), 'limit', value); } }),
      muted(t('Used when /claudex:warm on is given no limit. It changes neither a running warm-up nor Codex.')),
      button('cache-preview-limit', t('Preview default limit'), () => controller.cachePrepare(host(), 'limit')),
    ]));
    if (state.cachePending) body.push(section(t('Review cache change'), [
      field(t('Session ID'), state.cachePending.sessionId), field(t('Directory'), state.cachePending.cwd),
      // Always retain the complete confirmation, including scope and effects.
      text(JSON.stringify(state.cachePending, null, 2)),
      row([button('cache-confirm', t('Confirm cache change'), () => controller.cacheConfirm(host()), true),
        button('cache-discard', t('Discard preview'), () => controller.cacheDiscard(host()))]),
    ]));
    if (state.cacheResult) body.push(section(t('Cache change result'), [
      text(state.cacheResult.state === 'disabled' ? t('Disabled') : state.cacheResult.state === 'limit-saved'
        ? t('Default limit saved. Warming is unchanged.') : t('Settings updated. Warming remains off.')), details('cache-result', state.cacheResult),
    ]));
    body.push(button('cache-off', t('Stop cache warming'), () => controller.cacheOff(host())));
  } else if (state.tab === 'tasks') {
    const tasks = state.tasks?.tasks ?? [];
    body.push(section(t('Task inventory'), [button('tasks-refresh', t('Refresh tasks'), () => controller.refresh(host())),
      muted(t('{count} tasks · showing {first}–{last}', { count: taskInventoryCount(state.tasks),
        first: tasks.length ? Math.min(state.taskOffset + 1, tasks.length) : 0,
        last: Math.min(state.taskOffset + 10, tasks.length) }))]));
    if (!tasks.length) body.push(muted(t('No tasks in this inventory. Create a reviewed task from Compose.')));
    for (const task of tasks.slice(state.taskOffset, state.taskOffset + 10)) body.push(taskCard(task));
    body.push(row([
      ...(state.taskOffset > 0 ? [button('tasks-prev', t('Previous 10'), () => controller.page(host(), -10))] : []),
      ...(state.taskOffset + 10 < tasks.length ? [button('tasks-next', t('Next 10'), () => controller.page(host(), 10))] : []),
      ...(state.tasks?.nextCursor ? [button('tasks-page', t('Next page'), () => controller.taskPage(host(), state.tasks.nextCursor))] : []),
    ]));
  } else if (state.tab === 'detail') {
    const task = state.detail;
    const activity = task?.execution?.activity;
    const when = value => Number.isSafeInteger(value) ? new Date(value).toISOString() : value ?? t('Not reported');
    body.push(section(t('Task details'), [field(t('Task ID'), task?.id ?? state.selectedTask),
      ...(task?.objective ? [field(t('Objective'), task.objective)] : []),
      field(t('Generation'), task?.generation),
      ...(task?.parentId ? [button('task-parent', `${t('Parent task')}: ${task.parentId}`, () => controller.task(host(), task.parentId))] : []),
      field(t('Owner'), task?.owner), field(t('Status'), status(task?.phase ?? task?.status)),
      field(t('Model'), task?.model ?? t('Native default')), field(t('Access'), permission(task?.permission)),
      field(t('Project'), task?.projectRoot), ...(task?.error ? [text(task.error)] : []),
      ...(task?.result ? [details('task-result', task.result, t('Task result'))] : []), details('task', task)]));
    const control = (action, extra = {}) => ({ taskId: task.id, generation: task.generation, action, ...extra });
    const canControl = task && ['ready', 'running', 'waiting', 'paused', 'completed'].includes(task.status)
      && !task.pendingHandoff && !task.cancelRequested && !task.cancelPending
      && !['handoff-pending', 'cancelling'].includes(task.phase) && task.pause?.state !== 'checkpoint';
    if (task) {
      if (Number.isSafeInteger(task.generation) && task.generation > 0) body.push(
        Select({ key: 'history-generation', label: t('History generation'), value: String(state.workGeneration ?? task.generation),
          options: Array.from({ length: Math.min(task.generation, 100) }, (_, index) => {
            const value = String(task.generation - index); return { value, label: value };
          }), onSelect: value => { if (controller.state === state) controller.generation(host(), value); } }));
      body.push(section(t('Progress & evidence'), [
        field(t('Stage'), task.progress?.stage ?? t('Not reported')),
        field(t('Latest report'), when(task.progress?.lastReportedAt)),
        field(t('Native activity'), when(activity?.lastNativeEventAt)),
        ...(activity?.models ? [details('observed-models', activity.models, t('Observed models'))] : []),
        ...(task.progress?.current === false && task.progress?.reportCount ? [muted(t('The latest report belongs to an earlier generation.'))] : []),
        ...(task.outcome?.summary ? [text(task.outcome.summary)] : []),
        ...(task.progress?.next ? [field(t('Next step'), task.progress.next)] : []),
        field(t('Provenance'), task.outcome?.provenance ?? task.progress?.provenance ?? t('Not reported')),
        ...(task.waitReason ? [details('wait-reason', task.waitReason, t('Waiting for'))] : []),
        ...(task.children?.length ? [section(t('Child results'), task.children.map(child => row([
          button(`child-result-${child.taskId}`, child.taskId, () => controller.task(host(), child.taskId)),
          text(`${status(child.status)} · ${child.unread ? t('Unread result') : t('No unread result')}`),
        ])))] : []),
        field(t('Result review'), task.resultReview?.state ? status(task.resultReview.state) : t('Not reviewed')),
        muted(t('Reading this view does not acknowledge or integrate child results.')),
      ]));
      body.push(section(t('Report history'), [
        row([button('reports-recent', t('Recent reports'), () => controller.reports(host())),
          button('reports-start', t('Read from beginning'), () => controller.reports(host(), false, true)),
          ...(state.reports?.cursor ? [button('reports-more', t('Read after cursor'), () => controller.reports(host(), true))] : [])]),
        ...(state.reports ? [field(t('Collection'), status(state.reports.collection)),
          ...(state.reports.reports ?? []).map((report, index) => section(when(report.reportedAt), [
            field(t('Generation'), report.generation), field(t('Provenance'), report.provenance), text(report.summary),
            ...(report.artifacts ?? []).filter(artifact => artifact.kind === 'file').map((artifact, artifactIndex) =>
              row([button(`report-artifact-${index}-${artifactIndex}`, `${t('Inspect artifact')}: ${artifact.reference}`,
                () => controller.artifact(host(), artifact.reference, 'content', report.generation)),
              button(`report-diff-${index}-${artifactIndex}`, t('Inspect file diff'),
                () => controller.artifact(host(), artifact.reference, 'diff', report.generation))])),
            details(`report-${index}`, report, t('Technical details'), true)]))] : []),
      ]));
      for (const blocker of task.blockers ?? []) body.push(section(`${t('Blocker')} · ${status(blocker.state)}`, [
        field(t('Generation'), blocker.generation), field(t('Provenance'), blocker.provenance),
        text(blocker.question), field(t('Impact'), blocker.impact), field(t('Needed action'), blocker.needs),
        details(`blocker-${blocker.id}`, blocker),
        ...(canControl && blocker.current !== false && ['open', 'responded'].includes(blocker.state) && blocker.generation === task.generation ? [
          ...(blocker.state === 'open' ? [button(`respond-${blocker.id}`, t('Respond to blocker'), () => controller.template(host(), 'work_control',
            control('respond-blocker', { blockerId: blocker.id, text: 'Describe the decision within the existing authorization.' })))] : []),
          button(`resolve-${blocker.id}`, t('Resolve blocker'), () => controller.template(host(), 'work_control',
            control('resolve-blocker', { blockerId: blocker.id, text: 'Describe the evidence that resolves this blocker.' }))),
        ] : []),
      ]));
      body.push(section(t('Instructions & safe pause'), [
        ...(task.instructions ?? []).map(instruction => section(`${instruction.id} · ${instruction.state === 'delivered' ? t('Included in invocation context') : status(instruction.state)}`, [
          field(t('Generation'), instruction.generation ?? instruction.requestedGeneration),
          field(t('Provenance'), instruction.acknowledgmentProvenance ?? instruction.deliveryProvenance ?? instruction.provenance),
          ...(instruction.reason ? [text(instruction.reason)] : []), details(`instruction-${instruction.id}`, instruction),
        ])),
        field(t('Pause'), task.pause?.state ? status(task.pause.state) : t('Not requested')),
        muted(t('Delivery is not adoption. Pause waits for a worker checkpoint and verified process exit.')),
      ]));
      body.push(section(t('Artifacts & checks'), [
        ...(task.outcome?.checks ?? []).map((check, index) => details(`check-${index}`, check, `${check.name} · ${status(check.result)}`)),
        ...(task.outcome?.artifacts ?? []).map((artifact, index) => section(artifact.reference, [
          ...(artifact.description ? [text(artifact.description)] : []),
          ...(artifact.kind === 'file' ? [button(`artifact-${index}`, t('Inspect artifact'), () => controller.artifact(host(), artifact.reference, 'content', task.outcome?.generation)),
            button(`artifact-diff-${index}`, t('Inspect file diff'), () => controller.artifact(host(), artifact.reference, 'diff', task.outcome?.generation))] : []),
        ])),
        ...(state.artifact ? [field(t('Provenance'), state.artifact.provenance),
          text(state.artifact.content ?? ''), details('artifact-evidence', { ...state.artifact, content: undefined }),
          muted(t('Current file bytes do not prove exclusive worker authorship.'))] : []),
      ]));
      body.push(section(t('Work timeline'), [
        row([button('events-recent', t('Recent events'), () => controller.events(host())),
          button('events-start', t('Read from beginning'), () => controller.events(host(), false, true)),
          ...(state.events?.cursor ? [button('events-more', t('Read after cursor'), () => controller.events(host(), true))] : [])]),
        ...(state.events ? [field(t('Collection'), status(state.events.collection?.status)),
          ...(state.events.gap ? [text(t('The retained timeline has a gap. Inspect collection details.'))] : []),
          ...(state.events.events ?? []).map(event => section(`${event.sequence} · ${event.kind}`, [
            field(t('Provenance'), event.source), field(t('Time'), when(event.at)),
            ...(event.text ? [text(event.text)] : []), ...(event.summary ? [text(event.summary)] : []),
            details(`event-${event.sequence}`, event),
          ])), details('event-collection', { collection: state.events.collection, gap: state.events.gap,
            cursor: state.events.cursor, hasMore: state.events.hasMore }),
        ] : [muted(t('Read on demand. Event cursors are not task revisions.'))]),
      ]));
    }
    if (state.selectedTask) body.push(section(t('Task actions'), [
      button('task-refresh', t('Refresh exact task'), () => controller.task(host(), state.selectedTask)),
      ...(canControl ? [button('task-followup', t('Compose follow-up'), () => controller.template(host(), 'send', {
        taskId: state.selectedTask, message: 'Describe the explicitly authorized follow-up.' }))] : []),
      ...(!['completed', 'failed', 'cancelled', 'uncertain'].includes(task?.status) ? [button('task-cancel', t('Preview cancellation'), () => controller.prepare(host(), 'cancel', { taskId: state.selectedTask }))] : []),
      ...(canControl && task?.generation ? [
        ...(task.status === 'running' && !['requested', 'checkpoint'].includes(task.pause?.state) ? [button('task-pause', t('Request safe pause'), () => controller.prepare(host(), 'work_control', control('request-pause')))] : []),
        ...(task.pause?.state === 'paused' ? [button('task-resume', t('Resume work'), () => controller.prepare(host(), 'work_control', control('resume')))] : []),
        ...(task.resultFinal ? [button('task-reviewed', t('Mark result reviewed'), () => controller.prepare(host(), 'work_control', control('review-result', { decision: 'reviewed' }))),
          button('task-integrated', t('Mark result integrated'), () => controller.prepare(host(), 'work_control', control('review-result', { decision: 'integrated' })))] : []),
      ] : []),
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
        methods: ['start', 'send', 'cancel', 'work_control', 'chat_send', 'models'],
        observability: { timeline: 'off | public', reports: 'off | milestones', blockerNotifications: false },
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
