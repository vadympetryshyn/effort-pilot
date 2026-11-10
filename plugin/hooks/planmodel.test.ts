import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { configFrom, shortModel } from './route'

// planModeModel: the main loop's requests in plan mode go on another model; out of plan mode, on the session's own.

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const usage = (cacheRead = 0, input = 10): Usage => ({ input_tokens: input, output_tokens: 5, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 })
const PLAN = '{"phase":"plan","hard":false,"continues":false,"asked":"none","build":"none","faulted":false,"why":"design the feature"}'
const BUILD = '{"phase":"implement","hard":false,"continues":false,"asked":"none","build":"none","faulted":false,"why":"add the button"}'
const APPROVED = 'User has approved your plan. You can now start coding.'
const SESSION = 'claude-opus-5-5'
const FABLE = 'claude-fable-5-2'

/** A session on a managed model: the model and effort each request went on, the lines added, the status lines, the records. */
function engine(on: On, reply: string, answers: Usage[] = []) {
  const seen = { models: [] as string[], sent: [] as unknown[], agents: [] as string[], added: [] as string[], status: [] as string[], toasts: [] as string[], files: new Map<string, string>() }
  const records = () => [...seen.files.values()].flatMap(t => t.split('\n').filter(Boolean)).map(l => JSON.parse(l) as Record<string, unknown>)
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: SESSION }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', () => ({ value: { isAnswered: true, text: reply, usage: usage() } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.status', (_$, e) => {
    seen.status.push(e.text ?? '')
    return { value: undefined }
  })
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/someone' : undefined }))
  on('fs.exists', (_$, e) => ({ value: seen.files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: seen.files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    seen.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: 'done' }))
  on('ui.toast', (_$, e) => {
    seen.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Box', children: [] }) as never)
  on('command.run', () => ({ text: '' }))
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('session.append', (_$, e, next) => {
    seen.added.push(e.message.content.map(b => (b.type === 'text' ? b.text : '')).join(''))
    return next(e)
  })
  on('tool.call', () => ({ result: { plan: 'Add the button.' }, text: APPROVED }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  let i = 0
  on('turn.step', async function* (_$, e) {
    if (e.agentId === undefined) {
      seen.models.push(e.model)
      seen.sent.push(e.effort)
    } else seen.agents.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage: e.agentId === undefined ? (answers[i++] ?? usage()) : usage() } as never
  })
  return { ...seen, records }
}

let n = 0
let messages = 0
async function step($: Engine, turnId: string, index: number) {
  for await (const _ of $.turn.step({ turnId, index, model: SESSION, effort: 'high', messageCount: ++messages })) { /* drain */ }
}
/** A prompt typed in a permission mode, and its turn's first request. */
async function turn($: Engine, text: string, permission: 'plan' | 'default') {
  const id = `t${++n}`
  await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  await $.classic.UserPromptSubmit({ prompt: text, permission_mode: permission } as never)
  await $.turn.start({ text, turnId: id })
  await step($, id, 0)
  return id
}
const planning = ($: Engine) => turn($, 'Plan a CSV export for the reports page.', 'plan')
const building = ($: Engine) => turn($, 'Add an export button to the reports page.', 'default')
const exit = ($: Engine) => $.tool.call({ tool: 'ExitPlanMode', plan: 'Add the button.', tool_use_id: 'tu1' } as never)
const enter = ($: Engine) => $.tool.call({ tool: 'EnterPlanMode', tool_use_id: 'tu2' } as never)
const complete = ($: Engine, turnId: string) => $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
const run = async ($: Engine, args: string) => (await $.command.run({ command: 'effort-pilot', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text
const band = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: 'effort-pilot', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never })
  const found = await ui.find({ type: 'Text', text: /plan mode →/ })
  await ui.unmount()
  return found?.text
}

describe('the setting', () => {
  test('is empty by default, and an entry is kept as typed, trimmed', () => {
    expect(configFrom({}).planModel).toBe('')
    expect(configFrom({ planModeModel: ' fable ' }).planModel).toBe('fable')
    expect(configFrom({ planModeModel: 5 }).planModel).toBe('')
  })
  test('a model reads short on the status line: its claude- prefix dropped, an alias as it is', () => {
    expect(shortModel('claude-fable-5-2')).toBe('fable-5-2')
    expect(shortModel('fable')).toBe('fable')
  })
})

test('with no plan-mode model set, plan mode keeps the session\'s model', async ($, on) => {
  const seen = engine(on, PLAN)
  await planning($)
  expect(seen.models).toEqual([SESSION])
  expect(seen.sent).toEqual(['high'])
})

test('a prompt typed in plan mode goes on the plan-mode model at the plan effort, and the status line names it', { options: { planModeModel: FABLE } }, async ($, on) => {
  const seen = engine(on, PLAN)
  await planning($)
  expect(seen.models).toEqual([FABLE])
  expect(seen.sent).toEqual(['high'])
  expect(seen.status.at(-1)).toBe('effort: high plan · fable-5-2')
  expect(await band($)).toContain('plan mode → high on fable-5-2')
  expect(await run($, '')).toContain(`plan mode on ${FABLE}`)
})

test('an approved plan goes back to the session\'s model at the build effort, and its line says so', { options: { planModeModel: FABLE } }, async ($, on) => {
  const seen = engine(on, PLAN)
  const id = await planning($)
  await exit($)
  await step($, id, 1)
  expect(seen.models).toEqual([FABLE, SESSION])
  expect(seen.sent).toEqual(['high', 'medium'])
  expect(seen.added).toEqual([`Effort Pilot: reasoning effort is now medium, back on the session's model (${SESSION}), for carrying out the approved plan.`])
  expect(seen.status.at(-1)).toBe('effort: med implement')
})

test('plan mode entered mid-turn moves the next request to the plan-mode model, and its line names it', { options: { planModeModel: 'fable' } }, async ($, on) => {
  const seen = engine(on, BUILD)
  const id = await building($)
  await enter($)
  await step($, id, 1)
  expect(seen.models).toEqual([SESSION, 'fable'])
  expect(seen.sent).toEqual(['medium', 'high'])
  expect(seen.added).toEqual(['Effort Pilot: reasoning effort is now high, on fable, for planning.'])
})

test('plan mode entered mid-turn at the effort already in effect still says the model moves', { options: { planModeModel: 'fable', buildEffort: 'high' } }, async ($, on) => {
  const seen = engine(on, BUILD)
  const id = await building($)
  await enter($)
  expect(seen.added).toEqual(['Effort Pilot: reasoning effort is now high, on fable, for planning.'])
  await step($, id, 1)
  expect(seen.models).toEqual([SESSION, 'fable'])
})

test('a plan the classifier reads outside plan mode stays on the session\'s model', { options: { planModeModel: FABLE } }, async ($, on) => {
  const seen = engine(on, PLAN)
  await turn($, 'Plan a CSV export for the reports page.', 'default')
  expect(seen.models).toEqual([SESSION])
  expect(seen.sent).toEqual(['high'])
})

test('a subagent\'s requests in plan mode keep the model they resolve to', { options: { planModeModel: FABLE } }, async ($, on) => {
  const seen = engine(on, PLAN)
  const id = await planning($)
  for await (const _ of $.turn.step({ turnId: id, index: 0, model: 'claude-haiku-5', effort: 'high', messageCount: 1, agentId: 'a1' })) { /* drain */ }
  for await (const _ of $.turn.step({ turnId: id, index: 0, model: SESSION, effort: 'high', messageCount: 1, agentId: 'a2' })) { /* drain */ }
  expect(seen.agents).toEqual(['claude-haiku-5', SESSION])
  expect(seen.models).toEqual([FABLE])
})

test('with the pilot off, or paused by /effort, plan mode keeps the session\'s model', { options: { planModeModel: FABLE } }, async ($, on) => {
  const seen = engine(on, PLAN)
  await run($, 'off')
  await planning($)
  await run($, 'on')
  await $.command.run({ command: 'effort', args: 'max', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await planning($)
  expect(seen.models).toEqual([SESSION, SESSION])
})

test('on a plan-mode model where effort is one setting of the whole request, the model moves and the effort is left as it is', { options: { planModeModel: 'claude-fable-5', planEffort: 'max' } }, async ($, on) => {
  const seen = engine(on, PLAN)
  await planning($)
  expect(seen.models).toEqual(['claude-fable-5'])
  expect(seen.sent).toEqual(['high'])
  expect(seen.status.at(-1)).toBe('effort: your own · plan · fable-5')
})

test('a switch of model is never read as an effort switch that rewrote the cache, on either model', { options: { planModeModel: FABLE } }, async ($, on) => {
  // A build turn on the session's model whose cache holds; then plan mode on another model, which reads nothing from the
  // cache; then the approved plan back on the session's model, whose cache that request reads only in part.
  const seen = engine(on, BUILD, [usage(0, 20_000), usage(19_000, 2_000), usage(0, 25_000), usage(2_000, 24_000), usage(0, 26_000)])
  const a = await building($)
  await step($, a, 1)
  await complete($, a)
  const b = await planning($)
  await exit($)
  await step($, b, 1)
  await complete($, b)
  await building($)
  expect(seen.models).toEqual([SESSION, SESSION, FABLE, SESSION, SESSION])
  expect(seen.sent).toEqual(['medium', 'medium', 'high', 'medium', 'medium'])
  expect(seen.toasts.filter(t => t.includes('rewrite the prompt cache'))).toEqual([])
  expect(await run($, '')).not.toContain('off on')
})

test('a turn in plan mode is recorded on the model its requests went on; one out of it on the session\'s', { options: { planModeModel: FABLE, measure: true, controlShare: 0 } }, async ($, on) => {
  const seen = engine(on, PLAN)
  const id = await planning($)
  await complete($, id)
  const next = await turn($, 'Plan a CSV export for the reports page.', 'default')
  await complete($, next)
  expect(seen.records()).toEqual([
    expect.objectContaining({ phase: 'plan', planMode: true, model: FABLE }),
    expect.objectContaining({ phase: 'plan', model: SESSION }),
  ])
})

test('leaving plan mode by Shift+Tab stops naming the plan-mode model, and the next prompt goes on the session\'s model', { options: { planModeModel: FABLE } }, async ($, on) => {
  const seen = engine(on, BUILD)
  const id = await planning($)
  await complete($, id)
  expect(seen.status.at(-1)).toBe('effort: high plan · fable-5-2')
  const from = seen.status.length
  await building($)
  expect(seen.status.slice(from)).toEqual(['effort: high plan', 'effort: med implement'])
  expect(seen.models).toEqual([FABLE, SESSION])
  expect(seen.sent).toEqual(['high', 'medium'])
})
