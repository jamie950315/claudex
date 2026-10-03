import { expect, test, mock } from 'claude-code/testing'

function stubs(on: any, arm: string) {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, { CLAUDEX_CACHE_PROBE_AUTHORIZED: '1', CLAUDEX_CACHE_PROBE_ARM: arm })
  const writes: any[] = [], forks: any[] = []
  on('session.cwd', () => ({ value: '/fixture' }))
  on('session.version', () => ({ value: { version: 'fixture' } }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.messages', () => ({ value: [{ role: 'user', content: 'fixture' }] }))
  on('fs.write', (_: any, e: any) => { writes.push(JSON.parse(e.text)); return { value: undefined } })
  on('model.fork', (_: any, e: any) => { forks.push(e); return { value: { isAnswered: true, text: 'OK',
    usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 } } } })
  on('session.start', () => ({ cwd: '/fixture' }))
  on('turn.start', () => ({ turnId: 'fixture-turn' }))
  on('turn.step', async function* (_: any, e: any) {
    yield { kind: 'text', index: 0, text: 'OK' }
    return { turnId: e.turnId, index: e.index, answer: 'OK', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('turn.complete', () => ({ text: 'OK' }))
  on('session.end', () => ({ sessionId: 'fixture-session' }))
  return { clock, writes, forks }
}

async function seed($: any) {
  await $.session.start({ cwd: '/fixture', surface: 'terminal', isInteractive: false })
  await $.turn.start({ turnId: 'fixture-turn' })
  const stream = $.turn.step({ turnId: 'fixture-turn', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1 })
  let step = await stream.next()
  while (!step.done) step = await stream.next()
  await $.turn.complete({ turnId: 'fixture-turn', answer: 'OK', durationMs: 100, isAborted: false, reason: 'answer' })
}

test('native timer performs one isolated fork and preserves main messages', async ($, on) => {
  const { clock, writes, forks } = stubs(on, 'warm')
  await seed($)
  await clock.advance(239999)
  expect(forks.length).toBe(0)
  await clock.advance(1)
  expect(forks.length).toBe(1)
  expect(writes.at(-1).rows.find((row: any) => row.kind === 'fork-result').mainUnchanged).toBe(true)
  await clock.advance(600000)
  expect(forks.length).toBe(1)
})

test('control never performs a model fork', async ($, on) => {
  const { clock, forks } = stubs(on, 'control')
  await seed($)
  await clock.advance(600000)
  expect(forks.length).toBe(0)
})
