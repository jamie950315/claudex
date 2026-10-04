/** Run with `claude plugin test <staged plugin>`.
 * Native test-kit coverage; no sign-in, model call, network or real helper execution. */
import { expect, test, mock } from 'claude-code/testing'
import { textChunks, usageLine } from '../hooks/controller.mjs'
import { catalogs } from '../hooks/locales.mjs'
import { MOD_VERSION, MOD_BUILD } from '../hooks/delivery.mjs'
import { CACHE_TTL_PREFERENCE_KEY } from '../hooks/cache-warm.mjs'
const ID = '11111111-1111-4111-8111-111111111111'
const PANE = {
  plugin: 'claudex', component: 'Pane', requestId: 'claudex',
  viewport: { columns: 120, rows: 35 },
  props: { title: 'Claudex', isFocused: true, bodyColumns: 64, placement: 'inline',
    scroll: { offset: 0, bodyRows: 24 }, view: {} },
} as const
const BAND = {
  plugin: 'claudex', component: 'AbovePrompt', requestId: 'band',
  viewport: { columns: 120, rows: 35 },
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const
function stubs(on: any, worker = false, bridge?: (request: any, event: any) => any, language = 'en', settings?: (event: any) => any, store: Record<string, unknown> = {}) {
  const environment: Record<string, string | undefined> = worker ? { CLAUDEX_COLLABORATION_WORKER: '1' } : {}
  on('env.get', (_: any, e: any) => ({ value: environment[e.name] }))
  on('env.set', (_: any, e: any) => {
    expect(e.name).toBe('CLAUDE_CODE_PROMPT_CACHE_TTL')
    environment[e.name] = e.value
    return { value: undefined }
  })
  mock.store(on, { 'ui-language': language, ...store })
  mock.clock(on, { now: 1000 })
  on('session.id', () => ({ value: ID }))
  on('session.cwd', () => ({ value: '/fixture' }))
  on('session.version', () => ({ value: { version: '2.1.287' } }))
  on('session.usage', () => ({ value: { context: { percent: 42 }, rateLimits: [] } }))
  on('settings.read', (_: any, event: any) => ({ value: settings ? settings(event) : { crossSessionInbound: 'hold' } }))
  on('tool.list', () => ({ value: [] }))
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', () => ({ cwd: '/fixture' }))
  on('classic.SessionStart', () => ({}))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['Existing native or peer-mod content'] }))
  on('process.run', async (_: any, e: any) => {
    if (e.argv[0] === '/usr/bin/defaults') return { value: { exitCode: 0, stdout: '("zh-Hant-TW", "en-TW")', stderr: '' } }
    const request = JSON.parse(e.init.stdin)
    const result = bridge ? await bridge(request, e) : request.op === 'doctor' ? { root: '/fixture/state', stopped: false }
      : request.method === 'list' ? { tasks: [], limits: {} } : {}
    return { value: { exitCode: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' } }
  })
}
test('pane draws for terminal and Desktop using native element validation', async ($, on) => {
  stubs(on)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  const answer = await $.command.run({ command: 'claudex', args: '' })
  expect(answer.text).toBe('Claudex')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'tab-compose' })).toBeDefined()
    await ui.press({ key: 'tab-compose' })
    expect(await ui.find({ key: 'template-codex' })).toBeDefined()
    expect(await ui.find({ key: 'action-json' })).toBeDefined()
    await ui.unmount()
  }
})

test('work pane exposes exact-generation evidence and reviewed controls without read acknowledgements', async ($, on) => {
  const seen: any[] = []
  stubs(on, false, request => {
    seen.push(request)
    if (request.op === 'doctor') return { stopped: false }
    if (request.method === 'list') return { tasks: [{ id: 'task', owner: 'codex', status: 'running' }], limits: {} }
    if (request.method === 'status') return { id: 'task', owner: 'codex', generation: 2, status: 'running',
      objective: 'Inspect public work', execution: { activity: { lastNativeEventAt: 1000 } },
      progress: { stage: 'validation', lastReportedAt: 2000, next: 'Review evidence', provenance: 'worker-self-reported' },
      children: [{ taskId: 'child', status: 'completed', unread: true }],
      blockers: [{ id: 'blocker', generation: 2, current: true, state: 'open', question: 'Which behavior?', impact: 'Validation waits', needs: 'Decision' }],
      instructions: [{ id: 'instruction', requestedGeneration: 2, state: 'queued' }],
      outcome: { summary: 'Ready to validate', provenance: 'worker-self-reported', artifacts: [{ kind: 'file', reference: 'result.txt' }], checks: [{ name: 'unit', result: 'passed' }] } }
    if (request.method === 'work_events') return { events: [{ sequence: 1, kind: 'assistant-message', source: 'native:codex', at: 3000, text: 'Public message' }], cursor: 'cursor', collection: { status: 'collecting' } }
    if (request.method === 'work_reports') return { reports: [{ summary: 'Report body', reportedAt: 2000, provenance: 'worker-self-reported' }], cursor: 'report-cursor', collection: 'collected' }
    if (request.method === 'artifact_read') return { content: 'Artifact bytes', provenance: 'file-observed', attribution: 'unknown' }
    if (request.op === 'prepare') return { id: ID, state: 'prepared', method: request.method, params: request.params, context: request.context }
    return {}
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 40 } })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab-tasks' })
  await ui.press({ key: 'task-task-0' })
  expect(await ui.find({ type: 'Text', text: /Inspect public work/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Unread result/ })).toBeDefined()
  await ui.press({ key: 'events-recent' })
  expect(await ui.find({ type: 'Text', text: /Public message/ })).toBeDefined()
  await ui.press({ key: 'reports-recent' })
  expect(await ui.find({ type: 'Text', text: /Report body/ })).toBeDefined()
  await ui.press({ key: 'artifact-diff-0' })
  expect(await ui.find({ type: 'Text', text: /Artifact bytes/ })).toBeDefined()
  expect(seen.filter(item => item.op === 'commit').length).toBe(0)
  expect(seen.find(item => item.method === 'work_events').params.generation).toBe(2)
  expect(seen.find(item => item.method === 'artifact_read').params.view).toBe('diff')
  await ui.select({ key: 'history-generation', value: '1' })
  await ui.press({ key: 'events-start' })
  expect(seen.filter(item => item.method === 'work_events').at(-1).params.generation).toBe(1)
  expect(seen.filter(item => item.method === 'work_events').at(-1).params.recent).toBeUndefined()
  await ui.press({ key: 'task-pause' })
  expect(await ui.find({ key: 'confirm-action' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /request-pause/ })).toBeDefined()
  expect(seen.filter(item => item.op === 'commit').length).toBe(0)
  await ui.unmount()
})
test('prompt area preserves native and peer-mod content without a Claudex band', async ($, on) => {
  stubs(on)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'Existing native or peer-mod content' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claudex/ })).toBeUndefined()
    await ui.unmount()
  }
})
test('managed workers pass native UI through without opening controller actions', async ($, on) => {
  stubs(on, true)
  const answer = await $.command.run({ command: 'claudex', args: '' })
  expect(answer.text).toMatch(/generation-scoped/)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'tab-compose' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Existing native or peer-mod content' })).toBeDefined()
  await ui.unmount()
})
test('unrelated panes remain unchanged', async ($, on) => {
  stubs(on)
  const ui = await $.ui.mount({ ...PANE, requestId: 'another-plugin', surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Existing native or peer-mod content' })).toBeDefined()
  await ui.unmount()
})
test('handoff fills the draft using append with no automatic submit', async ($, on) => {
  stubs(on)
  let mode = '', sent = 0
  on('prompt.fill', (_: any, e: any) => { mode = e.mode; return { isFilled: true } })
  on('prompt.submit', (_: any, e: any) => { sent++; return { text: e.text } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'handoff-codex' })
  expect(mode).toBe('append')
  expect(sent).toBe(0)
  await ui.unmount()
})
test('long plain-text children are split losslessly for the native bound', () => {
  const source = 'x'.repeat(25000)
  const chunks = textChunks(source)
  expect(chunks.join('')).toBe(source)
  expect(chunks.every((chunk: string) => chunk.length <= 8000)).toBe(true)
  expect(usageLine(null)).toBe('Context unknown')
})

test('native compose previews the entire operation before exactly one dispatch', async ($, on) => {
  const seen: any[] = []
  let prepared: any
  stubs(on, false, (request, event) => {
    seen.push(request)
    expect(event.argv[1]).toMatch(/\/runtime\/bin\/claudex-mod-bridge\.mjs$/)
    expect(event.argv[2]).toBe('--root')
    expect(event.init.timeoutMs).toBe(20000)
    if (request.op === 'prepare') {
      prepared = { id: ID, state: 'prepared', method: request.method,
        params: request.params, context: request.context }
      return prepared
    }
    if (request.op === 'commit') return { ...prepared, state: 'completed', result: { taskId: 'fixture-task' } }
    return {}
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 40 } })
    await ui.press({ key: 'tab-compose' })
    const params = { provider: 'codex', cwd: '/fixture', permission: 'read-only', prompt: 'Review only; preserve files.' }
    await ui.input({ key: 'action-json', text: JSON.stringify({ method: 'start', params }) })
    expect(await ui.find({ type: 'Text', text: /Attention:/ })).toBeUndefined()
    expect(await ui.find({ key: 'confirm-action' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Review only; preserve files\./ })).toBeDefined()
    expect(seen.filter(item => item.op === 'commit').length).toBe(surface === 'terminal' ? 0 : 1)
    await ui.press({ key: 'confirm-action' })
    expect(await ui.find({ key: 'confirm-action' })).toBeUndefined()
    expect(await ui.find({ key: 'receipt-refresh' })).toBeDefined()
    await ui.unmount()
  }
  expect(seen.filter(item => item.op === 'commit').length).toBe(2)
})

test('duplicate native titles retain exact recipient IDs in the preview', async ($, on) => {
  const other = '22222222-2222-4222-8222-222222222222'
  let preview: any
  stubs(on, false, request => {
    if (request.method === 'chat_list') return { chats: [ID, other].map(sessionId => ({
      provider: 'claude', sessionId, title: 'Same title', cwd: '/fixture' })), nextCursor: null }
    if (request.op === 'prepare') {
      preview = request.params
      return { id: ID, state: 'prepared', method: request.method, params: request.params, context: request.context }
    }
    return {}
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-chats' })
  await ui.input({ key: 'chat-query', text: 'Same title' })
  expect(await ui.find({ type: 'Text', text: /Attention:/ })).toBeUndefined()
  expect(await ui.find({ key: `chat-claude-${ID}` })).toBeDefined()
  expect(await ui.find({ key: `chat-claude-${other}` })).toBeDefined()
  await ui.press({ key: `chat-claude-${other}` })
  const input = await ui.find({ key: 'action-json' })
  await ui.input({ key: 'action-json', text: input.props.value })
  expect(preview.sessionId).toBe(other)
  expect(preview.expectedTitle).toBe('Same title')
  expect(preview.wake).toBe(false)
  await ui.unmount()
})

test('native clear removes a pending confirm without dispatching it', async ($, on) => {
  let commits = 0
  stubs(on, false, request => {
    if (request.op === 'commit') commits++
    return { id: ID, state: 'prepared', method: request.method, params: request.params, context: request.context }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-compose' })
  await ui.input({ key: 'action-json', text: JSON.stringify({ method: 'cancel', params: { taskId: 'fixture-task' } }) })
  expect(await ui.find({ type: 'Text', text: /Attention:/ })).toBeUndefined()
  expect(await ui.find({ key: 'confirm-action' })).toBeDefined()
  await $.classic.SessionStart({ source: 'clear' })
  expect(await ui.find({ key: 'confirm-action' })).toBeUndefined()
  expect(commits).toBe(0)
  await ui.unmount()
})

test('all nine languages render both native surfaces without dispatch or lost input', async ($, on) => {
  let calls = 0, submissions = 0
  stubs(on, false, () => { calls++; return {} })
  on('prompt.submit', (_: any, e: any) => { submissions++; return { text: e.text } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 32 } })
    await ui.press({ key: 'tab-compose' })
    const draft = '{"method":"start","params":{"prompt":"unsent 日本語 中文 {value}"}}'
    await ui.input({ key: 'action-json', text: draft, kind: 'change' })
    for (const [language, catalog] of Object.entries(catalogs) as [string, Record<string, string>][]) {
      await ui.select({ key: 'language', value: language })
      expect((await ui.find({ key: 'tab-compose' })).props.label).toBe(catalog.Compose)
      expect((await ui.find({ key: 'action-json' })).props.value).toBe(draft)
    }
    await ui.press({ key: 'tab-chats' })
    await ui.input({ key: 'chat-query', text: 'Unsubmitted title 中文', kind: 'change' })
    await ui.select({ key: 'language', value: 'en' })
    expect((await ui.find({ key: 'chat-query' })).props.value).toBe('Unsubmitted title 中文')
    await ui.unmount()
  }
  expect(calls).toBe(0)
  expect(submissions).toBe(0)
})

test('language changes preserve the complete prepared action and do not dispatch it', async ($, on) => {
  let commits = 0, prepared: any
  stubs(on, false, request => {
    if (request.op === 'commit') commits++
    if (request.op === 'prepare') prepared = { id: ID, state: 'prepared', method: request.method,
      params: request.params, context: request.context }
    return prepared
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-compose' })
  const params = { taskId: 'exact-native-ID', message: 'Unchanged user text 日本語 {value}' }
  await ui.input({ key: 'action-json', text: JSON.stringify({ method: 'send', params }) })
  await ui.select({ key: 'language', value: 'zh-Hant' })
  expect(await ui.find({ key: 'confirm-action' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: JSON.stringify(params, null, 2) })).toBeDefined()
  expect(commits).toBe(0)
  await ui.select({ key: 'language', value: 'de' })
  expect(await ui.find({ type: 'Text', text: new RegExp(ID) })).toBeDefined()
  expect(commits).toBe(0)
  await ui.unmount()
})

test('system language resolves Traditional Chinese and diagnostics expand only on request', async ($, on) => {
  stubs(on, false, undefined, 'system')
  await $.session.start({ cwd: '/fixture', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'claudex', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'tab-overview' })).props.label).toBe(catalogs['zh-Hant'].Overview)
  expect(await ui.find({ type: 'Text', text: /"socketPresent"/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /"root"/ })).toBeUndefined()
  await ui.press({ key: 'details-session' })
  expect(await ui.find({ type: 'Text', text: /"root"/ })).toBeDefined()
  await ui.unmount()
})

// Run the staged candidate with both nativeWake and selfWake defaults enabled.
const SELF = 'CLAUDEX_SELF_INBOX_V1\n'
const selfEnvelope = () => SELF + JSON.stringify({ messageId: ID, claimId: ID, target: { sessionId: ID, cwd: '/fixture' } })
test('own-inbox guard retrieves peer text from the exact broker claim, not the socket payload', async ($, on) => {
  let delivered = ''
  stubs(on, false, request => {
    expect(request.op).toBe('wake-self-receive')
    expect(request.route).toBe('mod-self')
    expect(request.context).toEqual({ sessionId: ID, cwd: '/fixture' })
    return { ready: true, context: 'Original broker-quoted peer message' }
  })
  on('session.receive', (_: any, e: any) => { delivered = e.text; return { consumed: 'native-test-sink' } })
  await $.session.receive({ origin: { kind: 'peer-send-message' }, text: selfEnvelope() })
  expect(delivered).toBe('Original broker-quoted peer message')
})
test('own-inbox guard preserves ordinary peer events and rejects malformed routing hints', async ($, on) => {
  let calls = 0, delivered = ''
  stubs(on, false, () => { calls++; return {} })
  on('session.receive', (_: any, e: any) => { delivered = e.text; return { consumed: 'native-test-sink' } })
  await $.session.receive({ origin: { kind: 'peer' }, text: 'Ordinary peer note' })
  expect(delivered).toBe('Ordinary peer note')
  delivered = ''
  await $.session.receive({ origin: { kind: 'peer-send-message' }, text: SELF + '{}' })
  expect(delivered).toBe('')
  // The private bridge, not an untrusted prefix, remains authoritative.
  expect(calls).toBeLessThanOrEqual(1)
})
test('own-inbox delivery is fenced when clear happens during the final broker check', async ($, on) => {
  let delivered = 0
  stubs(on, false, async request => {
    if (request.op !== 'wake-self-receive') return {}
    await $.classic.SessionStart({ source: 'clear' })
    return { ready: true, context: 'Must not reach the cleared context' }
  })
  on('session.receive', () => { delivered++; return { consumed: 'native-test-sink' } })
  await $.session.receive({ origin: { kind: 'peer-send-message' }, text: selfEnvelope() })
  expect(delivered).toBe(0)
})

test('native lifecycle publishes bounded policy observations and clear retires the previous observer', async ($, on) => {
  const observed: any[] = []
  stubs(on, false, request => { if (request.op === 'wake-observe') observed.push(request); return {} })
  await $.session.start({ cwd: '/fixture', surface: 'desktop', isInteractive: true })
  expect(observed.length).toBe(1)
  expect(observed[0].context).toEqual({ sessionId: ID, cwd: '/fixture' })
  expect(observed[0].observation.inboundPolicy).toBe('hold')
  expect(observed[0].observation.usage).toEqual({ contextPercent: 42 })
  expect(observed[0].observation.capabilities).toEqual({ sendMessage: false })
  expect(observed[0].observation.modVersion).toBe(MOD_VERSION)
  expect(observed[0].observation.modBuild).toBe(MOD_BUILD)
  await $.classic.SessionStart({ source: 'clear' })
  expect(observed.length).toBe(3)
  expect(observed[1].observation.lifecycle).toBe('ended')
  expect(observed[1].observation.observerId).toBe(observed[0].observation.observerId)
  expect(observed[2].observation.lifecycle).toBe('loaded')
  expect(observed[2].observation.modVersion).toBe(MOD_VERSION)
  expect(observed[2].observation.observerId).not.toBe(observed[0].observation.observerId)
})

test('technical session details read supported setting scopes and show only exact public option diagnostics', async ($, on) => {
  const sources: string[] = []
  stubs(on, false, request => request.method === 'list'
    ? { tasks: Array.from({ length: 100 }, (_, index) => ({ id: `task-${index}` })), totalCount: 133, nextCursor: '100' } : {}, 'en', event => {
    if (!event.source) return { crossSessionInbound: 'hold' }
    sources.push(event.source)
    return { pluginConfigs: { 'claudex@claudex-local': { options: {
      nativeWake: event.source === 'user', selfWake: event.source === 'user', secret: 'NEVER_COPY_NATIVE',
    } }, 'claudex@inline': { options: { nativeWake: true, selfWake: true } },
    'other@market': { options: { token: 'NEVER_COPY_NATIVE' } } } }
  })
  await $.session.start({ cwd: '/fixture', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'claudex', args: '' })
  expect(sources).toEqual(['user', 'flag', 'policy'])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /100 \/ 133/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /"registration"/ })).toBeUndefined()
  await ui.press({ key: 'details-session' })
  expect(await ui.find({ type: 'Text', text: /"registration"/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /"claudex@claudex-local"/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /"claudex@inline"/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /NEVER_COPY_NATIVE/ })).toBeUndefined()
  await ui.unmount()
})

test('cache warming status stays read-only and plugin-origin commands cannot opt in', async ($, on) => {
  const seen: any[] = []
  stubs(on, false, request => { seen.push(request); return { policies: [] } })
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  seen.length = 0
  const status = await $.command.run({ command: 'claudex', args: 'warm status' })
  expect(JSON.parse(status.text).local.enabled).toBe(false)
  expect(seen.map(item => item.action)).toEqual(['list'])
  expect(seen[0].op).toBe('cache-warm')
  expect(seen[0].context).toEqual({ sessionId: ID, cwd: '/fixture' })
  const enable = await $.command.run({ command: 'claudex', args: 'warm on' })
  expect(enable.text).toMatch(/explicit native user command/)
  expect(seen.length).toBe(1)
})

test('saved TTL preference is applied through native startup APIs without enabling warming', async ($, on) => {
  const seen: any[] = []
  stubs(on, false, request => { seen.push(request); return { policies: [] } }, 'en', undefined,
    { [CACHE_TTL_PREFERENCE_KEY]: { version: 1, mode: 'default', ttl: '5m' } })
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  expect(seen.filter(item => item.op === 'cache-warm').length).toBe(0)
  const status = JSON.parse((await $.command.run({ command: 'claudex', args: 'warm status' })).text)
  if (status.local.ttlRestore.state !== 'applied') throw new Error(JSON.stringify(status.local.ttlRestore))
  expect(status.nativeCache.value).toBe('5m')
  expect(status.local.enabled).toBe(false)
  expect(status.local.ttlRestore.state).toBe('applied')
  expect(status.ttlPreference).toEqual({ version: 1, mode: 'default', ttl: '5m' })
  // A normal /clear binding does not reapply startup defaults.
  await $.classic.SessionStart({ source: 'clear' })
  const cleared = JSON.parse((await $.command.run({ command: 'claudex', args: 'warm status' })).text)
  expect(cleared.local.ttlRestore.state).toBe('not-requested')
})

test('startup TTL policy conflicts are visible and do not rewrite the saved choice', async ($, on) => {
  stubs(on, false, () => ({ policies: [] }), 'en', event => event.source === 'policy'
    ? { promptCacheTtl: '5m' } : { crossSessionInbound: 'hold', promptCacheTtl: '5m' },
    { [CACHE_TTL_PREFERENCE_KEY]: { version: 1, mode: 'remember', ttl: '1h', revision: 'warm-fixture' } })
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  const status = JSON.parse((await $.command.run({ command: 'claudex', args: 'warm status' })).text)
  expect(status.nativeCache.environmentValue).toBe(null)
  expect(status.local.ttlRestore.state).toBe('failed')
  expect(status.local.ttlRestore.error).toMatch(/Managed/)
  expect(status.local.enabled).toBe(false)
  expect(status.ttlPreference.ttl).toBe('1h')
})

test('cache pane applies TTL and startup preferences through explicit native UI confirmation', async ($, on) => {
  const seen: any[] = []
  stubs(on, false, request => { seen.push(request); return { policies: [] } })
  await $.session.start({ cwd: '/fixture', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 40 } })
  await ui.press({ key: 'tab-cache' })
  await ui.select({ key: 'cache-ttl', value: '5m' })
  await ui.select({ key: 'cache-mode', value: 'default' })
  await ui.press({ key: 'cache-preview-preference' })
  let status = JSON.parse((await $.command.run({ command: 'claudex', args: 'warm status' })).text)
  expect(status.ttlPreference.mode).toBe('session')
  expect(status.nativeCache.value).toBe(null)
  for (const [language, catalog] of Object.entries(catalogs) as [string, Record<string, string>][]) {
    await ui.select({ key: 'language', value: language })
    expect((await ui.find({ key: 'tab-cache' })).props.label).toBe(catalog['Cache settings'])
    expect((await ui.find({ key: 'cache-mode' })).props.value).toBe('default')
    expect((await ui.find({ key: 'cache-ttl' })).props.value).toBe('5m')
    expect(await ui.find({ type: 'Text', text: /Save a plugin-wide preference/ })).toBeDefined()
  }
  await ui.press({ key: 'cache-confirm' })
  expect(await ui.find({ key: 'cache-confirm' })).toBeUndefined()
  status = JSON.parse((await $.command.run({ command: 'claudex', args: 'warm status' })).text)
  expect(status.ttlPreference).toEqual({ version: 1, mode: 'default', ttl: '5m' })
  expect(status.nativeCache.value).toBe('5m')
  expect(status.local.enabled).toBe(false)
  await ui.select({ key: 'cache-ttl', value: '1h' })
  await ui.press({ key: 'cache-preview-ttl' })
  await ui.press({ key: 'cache-confirm' })
  status = JSON.parse((await $.command.run({ command: 'claudex', args: 'warm status' })).text)
  expect(status.nativeCache.value).toBe('1h')
  expect(status.ttlPreference.ttl).toBe('5m')
  expect(seen.some(item => item.op === 'cache-warm' && item.action === 'configure' && item.params.enabled)).toBe(false)
  await ui.press({ key: 'cache-preview-ttl' })
  await ui.press({ key: 'cache-discard' })
  expect(await ui.find({ key: 'cache-confirm' })).toBeUndefined()
  await ui.unmount()
})
