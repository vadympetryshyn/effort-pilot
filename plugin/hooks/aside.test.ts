import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// Where effort is one setting of the whole request (older models, a provider other than Anthropic's API, a numeric
// effort), every switch rewrites the conversation's prompt cache: the pilot stands aside and the person's effort goes.

const BUILD = '{"phase":"implement","hard":false,"continues":false,"asked":"none","build":"none","faulted":false,"why":"add the button"}'
const CHAT = '{"phase":"chat","hard":false,"continues":false,"asked":"none","build":"none","faulted":false,"why":"a question"}'
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const usage = (cacheRead: number, cacheWrite = 0): Usage => ({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite })

/** A session on a model and a credential: counts classifier calls and records what each request carried. */
function engine(on: On, model: string, credential: boolean, answers: Usage[] = []) {
  const seen = { calls: 0, sent: [] as unknown[], toasts: [] as string[], replies: [BUILD, CHAT, BUILD, CHAT] }
  let now = 0
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: model }))
  on('session.authorize', () => ({ value: credential ? { handle: 'h', kind: 'bearer' as const } : null }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: (now += 1000) }))
  on('model.complete', () => ({ value: { isAnswered: true, text: seen.replies[seen.calls++ % seen.replies.length]!, usage: usage(0) } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(String((e as { text?: unknown }).text ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  on('session.start', () => ({ cwd: '/' }))
  on('ui.render', () => ({ type: 'Box', children: [] }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  let i = 0
  on('turn.step', async function* (_$, e) {
    seen.sent.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage: answers[i++] ?? usage(0) } as never
  })
  return seen
}

let n = 0
/** One turn: a prompt, its first request at the session's own effort. */
async function turn($: Engine, model: string, effort: string | number = 'high', messageCount = 1) {
  const id = `t${++n}`
  await $.prompt.submit({ text: 'Add an export button to the reports page.', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'Add an export button to the reports page.', turnId: id })
  for await (const _ of $.turn.step({ turnId: id, index: 0, model, effort: effort as never, messageCount })) { /* drain */ }
}
const start = ($: Engine) => $.session.start({ cwd: '/', surface: null, isInteractive: true })
const status = async ($: Engine) => (await $.command.run({ command: 'effort-pilot', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text
const band = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: 'effort-pilot', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never })
  const found = await ui.find({ type: 'Text', text: /Effort Pilot: off on/ })
  await ui.unmount()
  return found?.text
}

test('on a per-message model the pilot switches as before', async ($, on) => {
  const seen = engine(on, 'claude-opus-5-5', true)
  await start($)
  await turn($, 'claude-opus-5-5')
  expect(seen.calls).toBe(1)
  expect(seen.sent).toEqual(['medium'])
  expect(await status($)).not.toContain('off on')
})

test('on Claude 4.x the person\'s effort goes, nothing is classified, and the band says why', async ($, on) => {
  const seen = engine(on, 'claude-opus-4-6', true)
  await start($)
  await turn($, 'claude-opus-4-6')
  expect(seen.calls).toBe(0)
  expect(seen.sent).toEqual(['high'])
  expect(await band($)).toContain('off on claude-opus-4-6 — effort is one setting per request here')
  expect(await status($)).toContain('your own effort stands')
})

test('without a first-party credential the pilot stands aside on any model', async ($, on) => {
  const seen = engine(on, 'claude-opus-5-5', false)
  await start($)
  await turn($, 'claude-opus-5-5')
  expect(seen.calls).toBe(0)
  expect(seen.sent).toEqual(['high'])
  expect(await band($)).toContain('no first-party Anthropic login')
})

test('a numeric effort is the person\'s: it goes untouched', async ($, on) => {
  const seen = engine(on, 'claude-opus-5-5', true)
  await start($)
  await turn($, 'claude-opus-5-5', 20000)
  await turn($, 'claude-opus-5-5', 20000, 3)
  expect(seen.sent).toEqual([20000, 20000])
})

test('a subagent on a whole-request model is not classified', async ($, on) => {
  const seen = engine(on, 'claude-opus-4-6', true)
  on('agent.spawn', () => ({ model: 'claude-opus-4-6', agentId: 'a1' }))
  await start($)
  await $.agent.spawn({ prompt: 'Find why the login test fails.', description: 'investigate', subagentType: 'general-purpose', parentModel: 'claude-opus-4-6', provider: { plugin: 'engine', tier: 'core' } } as never)
  expect(seen.calls).toBe(0)
})

test('a switch seen to rewrite the cache leaves the person\'s effort from the next request, with one toast', async ($, on) => {
  // Turn 2 switches to low and reads the cache; turn 3 switches back to medium and reads almost nothing of it.
  const seen = engine(on, 'claude-opus-6', true, [usage(40_000, 10_000), usage(49_000, 2_000), usage(1_000, 50_000), usage(50_000)])
  await start($)
  await turn($, 'claude-opus-6', 'high', 2)
  await turn($, 'claude-opus-6', 'high', 4)
  await turn($, 'claude-opus-6', 'high', 6)
  await turn($, 'claude-opus-6', 'high', 8)
  expect(seen.sent).toEqual(['medium', 'low', 'medium', 'high'])
  expect(seen.calls).toBe(3)
  expect(seen.toasts.filter(t => t.includes('rewrite the prompt cache'))).toHaveLength(1)
  expect(await band($)).toContain('a switch was seen to rewrite the prompt cache')
})

test('a switch that reads the cache marks nothing', async ($, on) => {
  const seen = engine(on, 'claude-opus-6', true, [usage(40_000, 10_000), usage(49_000, 2_000), usage(50_000)])
  await start($)
  await turn($, 'claude-opus-6', 'high', 2)
  await turn($, 'claude-opus-6', 'high', 4)
  await turn($, 'claude-opus-6', 'high', 6)
  expect(seen.sent).toEqual(['medium', 'low', 'medium'])
  expect(seen.calls).toBe(3)
})

test('the loss from a session\'s first request to its second is no rewrite: the pilot keeps steering', async ($, on) => {
  // As measured on a fresh headless session: Claude Code sends part of the first turn again on the second, so the second
  // request reads back only the system and tools prefix, a switch or none.
  const seen = engine(on, 'claude-opus-6', true, [usage(13_235, 7_689), usage(13_759, 12_252), usage(26_000, 600)])
  await start($)
  await turn($, 'claude-opus-6', 'high', 1)
  await turn($, 'claude-opus-6', 'high', 3)
  await turn($, 'claude-opus-6', 'high', 5)
  expect(seen.sent).toEqual(['medium', 'low', 'medium'])
  expect(seen.toasts.filter(t => t.includes('rewrite the prompt cache'))).toHaveLength(0)
})
