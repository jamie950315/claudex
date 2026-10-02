/** Run with `claude plugin test <staged plugin>`.
 * Native test-kit coverage; no sign-in, model call, network or real helper execution. */
import { expect, test, mock } from 'claude-code/testing'
import { textChunks, usageLine } from '../hooks/controller.mjs'
import { catalogs } from '../hooks/locales.mjs'
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
function stubs(on: any, worker = false, bridge?: (request: any, event: any) => any, language = 'en') {
  mock.env(on, worker ? { CLAUDEX_COLLABORATION_WORKER: '1' } : {})
  mock.store(on, { 'ui-language': language })
  mock.clock(on, { now: 1000 })
  on('session.id', () => ({ value: ID }))
  on('session.cwd', () => ({ value: '/fixture' }))
  on('session.version', () => ({ value: { version: '2.1.287' } }))
  on('session.usage', () => ({ value: { context: { percent: 42 }, rateLimits: [] } }))
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
  await $.command.run({ command: 'claudex', args: '' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'tab-compose' })).toBeDefined()
    await ui.press({ key: 'tab-compose' })
    expect(await ui.find({ key: 'template-codex' })).toBeDefined()
    expect(await ui.find({ key: 'action-json' })).toBeDefined()
    await ui.unmount()
  }
})
test('band composes with later mods instead of replacing their content', async ($, on) => {
  stubs(on)
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: 'Existing native or peer-mod content' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claudex/ })).toBeDefined()
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
  stubs(on, false, async () => {
    await $.classic.SessionStart({ source: 'clear' })
    return { ready: true, context: 'Must not reach the cleared context' }
  })
  on('session.receive', () => { delivered++; return { consumed: 'native-test-sink' } })
  await $.session.receive({ origin: { kind: 'peer-send-message' }, text: selfEnvelope() })
  expect(delivered).toBe(0)
})
