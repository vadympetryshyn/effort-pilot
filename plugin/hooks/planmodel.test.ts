import type { On } from 'claude-code'
import { describe, expect } from 'claude-code/testing'
import { test } from './testkit'
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
function engine(on: On, reply: string | string[], answers: Usage[] = [], $?: Engine) {
  const seen = { models: [] as string[], sent: [] as unknown[], agents: [] as string[], added: [] as string[], status: [] as string[], toasts: [] as string[], context: [] as string[], files: new Map<string, string>() }
  // One classifier answer a call, in order; the last one holds for every call after it.
  const replies = typeof reply === 'string' ? [reply] : [...reply]
  const answer = () => (replies.length > 1 ? replies.shift()! : replies[0]!)
  const records = () => [...seen.files.values()].flatMap(t => t.split('\n').filter(Boolean)).map(l => JSON.parse(l) as Record<string, unknown>)
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: SESSION }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', () => ({ value: { isAnswered: true, text: answer(), usage: usage() } }))
  on('prompt.submit', async (_$, e) => {
    seen.context.push(...(e.context ?? []))
    // A skill command is expanded beneath its prompt.submit: what the model reads of it is the skill's prompt.
    if (e.command && $) seen.context.push((await $.skill.prompt({ skill: e.command.name, text: 'The skill\'s own instructions.', frontmatter: {} })).text)
    return { text: e.text }
  })
  on('skill.prompt', (_$, e) => ({ text: e.text }))
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
  expect(seen.added).toEqual([`Effort Pilot: back on the session's model (${SESSION}) now; reasoning effort goes to medium from the next message, for carrying out the approved plan.`])
  expect(seen.status.at(-1)).toBe('effort: med implement')
})

test('plan mode entered mid-turn moves the next request to the plan-mode model, and its line names it', { options: { planModeModel: 'fable' } }, async ($, on) => {
  const seen = engine(on, BUILD)
  const id = await building($)
  await enter($)
  await step($, id, 1)
  expect(seen.models).toEqual([SESSION, 'fable'])
  expect(seen.sent).toEqual(['medium', 'high'])
  expect(seen.added).toEqual(['Effort Pilot: on fable now; reasoning effort goes to high from the next message, for planning.'])
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

// planModelForPlans: the plan-mode model also for a plan read from a message outside plan mode, following the work under
// way (the carried task), so a side question or pushback on the plan does not switch the model again.
describe('the plan-mode model for plans outside plan mode', () => {
  const ON = { planModeModel: FABLE, planModelForPlans: true }
  const reply = (phase: string, more: string, why: string) => `{"phase":"${phase}","hard":false,"asked":"none","build":"none","faulted":false,${more}"why":"${why}"}`
  const SIDE = reply('chat', '"continues":false,', 'a side question')
  const ABOUT = reply('chat', '"continues":true,', 'a question about the plan')
  const PUSHBACK = reply('fix', '"continues":true,"faulted":true,', 'the plan missed the point')
  const DEEPER = reply('analyze', '"continues":true,', 'weigh the two options of the plan')
  const GO = reply('implement', '"continues":true,', 'carry out the plan')
  const OTHER = reply('implement', '"continues":false,', 'an unrelated change')
  const NAMED = reply('plan', '"continues":false,"model":"sonnet",', 'design the feature')
  const PLANNING = `Effort Pilot: planning on ${FABLE} at high (the plan-mode model, set for plans too); back on the session's model (${SESSION}) when building starts.`
  const BACK = `Effort Pilot: back on the session's model (${SESSION}) at medium for the build.`
  const say = ($: Engine, text: string) => turn($, text, 'default')

  test('is off by default', () => {
    expect(configFrom({}).planForPlans).toBe(false)
    expect(configFrom({ planModelForPlans: true }).planForPlans).toBe(true)
    expect(configFrom({ planModelForPlans: 'yes' }).planForPlans).toBe(false)
  })

  test('a plan asked for in a message goes on the plan-mode model at the plan effort, and says so', { options: ON }, async ($, on) => {
    const seen = engine(on, PLAN)
    await say($, 'Plan a CSV export for the reports page.')
    expect(seen.models).toEqual([FABLE])
    expect(seen.sent).toEqual(['high'])
    expect(seen.status.at(-1)).toBe('effort: high plan · fable-5-2')
    expect(seen.context.join('\n')).toContain(PLANNING)
    expect(seen.added).toEqual([PLANNING])
    expect(seen.toasts).toEqual([`Effort Pilot: planning on ${FABLE} at high`])
    expect(await run($, '')).toContain(`plans and plan mode on ${FABLE}`)
    const ui = await $.ui.mount({ plugin: 'effort-pilot', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10 } as never })
    expect((await ui.find({ type: 'Text', text: /plan on fable-5-2 until building starts/ }))?.text).toBeDefined()
    await ui.unmount()
  })

  test('a planning slash command read as a plan goes on the plan-mode model too', { options: ON }, async ($, on) => {
    const seen = engine(on, PLAN, [], $)
    await $.prompt.submit({ text: '/tools:create-plan a CSV export of the reports page', command: { name: 'tools:create-plan', args: 'a CSV export of the reports page' }, origin: { kind: 'composer' } } as never)
    await $.classic.UserPromptSubmit({ prompt: '/tools:create-plan', permission_mode: 'default' } as never)
    await $.turn.start({ text: '/tools:create-plan', turnId: 'c1' })
    await step($, 'c1', 0)
    expect(seen.models).toEqual([FABLE])
    expect(seen.sent).toEqual(['high'])
    expect(seen.context.join('\n')).toContain(PLANNING)
  })

  test('a side question, a question about the plan, pushback and deeper reasoning on it stay on the plan model with no new switch', { options: ON }, async ($, on) => {
    const seen = engine(on, [PLAN, SIDE, ABOUT, PUSHBACK, DEEPER])
    for (const text of ['Plan a CSV export for the reports page.', 'What time zone are the logs in?', 'Why one file per report?', 'No, you misunderstood: the export goes inside the existing job.', 'Think through which of the two options holds up better.']) {
      await complete($, await say($, text))
    }
    expect(seen.models).toEqual([FABLE, FABLE, FABLE, FABLE, FABLE])
    expect(seen.sent).toEqual(['high', 'low', 'low', 'high', 'high'])
    expect(seen.toasts.filter(t => t.includes('planning on') || t.includes('back on'))).toEqual([`Effort Pilot: planning on ${FABLE} at high`])
    expect(seen.added).toEqual([PLANNING])
  })

  test('building the plan goes back on the session\'s model at the build effort, and the line says so', { options: ON }, async ($, on) => {
    const seen = engine(on, [PLAN, SIDE, GO])
    await complete($, await say($, 'Plan a CSV export for the reports page.'))
    await complete($, await say($, 'What time zone are the logs in?'))
    await say($, 'Looks good, build it.')
    expect(seen.models).toEqual([FABLE, FABLE, SESSION])
    expect(seen.sent).toEqual(['high', 'low', 'medium'])
    expect(seen.context.join('\n')).toContain(BACK)
    expect(seen.added).toEqual([PLANNING, BACK])
    expect(seen.toasts.at(-1)).toBe(`Effort Pilot: back on ${SESSION} at medium for the build`)
    expect(seen.toasts.filter(t => t.startsWith('effort:'))).toEqual(['effort: high → low chat'])
    expect(seen.status.at(-1)).toBe('effort: med implement')
  })

  test('after deeper reasoning on the plan, building it goes back on the session\'s model', { options: ON }, async ($, on) => {
    const seen = engine(on, [PLAN, DEEPER, GO])
    for (const text of ['Plan a CSV export for the reports page.', 'Think through which of the two options holds up better.', 'Go with the first, build it.']) {
      await complete($, await say($, text))
    }
    expect(seen.models).toEqual([FABLE, FABLE, SESSION])
  })

  test('a new task of another kind leaves the plan model', { options: ON }, async ($, on) => {
    const seen = engine(on, [PLAN, OTHER])
    await complete($, await say($, 'Plan a CSV export for the reports page.'))
    await say($, 'Rename the save button to Store.')
    expect(seen.models).toEqual([FABLE, SESSION])
  })

  test('a new task typed while the plan is under way moves the next request back to the session\'s model', { options: ON }, async ($, on) => {
    const seen = engine(on, [PLAN, OTHER])
    const id = await say($, 'Plan a CSV export for the reports page.')
    await $.prompt.submit({ text: 'Rename the save button to Store.', origin: { kind: 'composer' }, turnId: id } as never)
    await step($, id, 1)
    expect(seen.models).toEqual([FABLE, SESSION])
    // A message typed mid-turn never lowers the running turn's effort.
    expect(seen.added).toEqual([PLANNING, BACK.replace('at medium', 'at high')])
  })

  test('a model the person names wins over the setting', { options: ON }, async ($, on) => {
    const seen = engine(on, NAMED)
    await say($, 'Plan a CSV export for the reports page on Sonnet.')
    expect(seen.models).toEqual(['sonnet'])
    expect(seen.toasts.filter(t => t.includes(FABLE))).toEqual([])
  })

  test('a model asked for earlier holds through a plan', { options: ON }, async ($, on) => {
    // A model named is read twice.
    const ask = reply('chat', '"continues":false,"model":"sonnet",', 'switch the model')
    const seen = engine(on, [ask, ask, PLAN])
    await complete($, await say($, 'Switch me to Sonnet.'))
    await say($, 'Plan a CSV export for the reports page.')
    expect(seen.models).toEqual(['sonnet', 'sonnet'])
  })

  test('with the setting off, only plan mode switches the model', { options: { planModeModel: FABLE, planModelForPlans: false } }, async ($, on) => {
    const seen = engine(on, PLAN)
    await complete($, await say($, 'Plan a CSV export for the reports page.'))
    await planning($)
    expect(seen.models).toEqual([SESSION, FABLE])
    expect(seen.added).toEqual([])
  })

  test('with no plan-mode model set, a plan keeps the session\'s model', { options: { planModelForPlans: true } }, async ($, on) => {
    const seen = engine(on, PLAN)
    await say($, 'Plan a CSV export for the reports page.')
    expect(seen.models).toEqual([SESSION])
  })

  test('with the effort set by hand, a plan keeps the session\'s model', { options: ON }, async ($, on) => {
    const seen = engine(on, PLAN)
    await $.command.run({ command: 'effort', args: 'max', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await say($, 'Plan a CSV export for the reports page.')
    expect(seen.models).toEqual([SESSION])
  })

  test('a subagent spawned during plan work keeps its model', { options: ON }, async ($, on) => {
    const seen = engine(on, PLAN)
    const id = await say($, 'Plan a CSV export for the reports page.')
    for await (const _ of $.turn.step({ turnId: id, index: 0, model: 'claude-haiku-5', effort: 'high', messageCount: 1, agentId: 'a1' })) { /* drain */ }
    for await (const _ of $.turn.step({ turnId: id, index: 0, model: SESSION, effort: 'high', messageCount: 1, agentId: 'a2' })) { /* drain */ }
    expect(seen.agents).toEqual(['claude-haiku-5', SESSION])
    expect(seen.models).toEqual([FABLE])
  })

  test('a plan turn is recorded on the plan model; the build turn on the session\'s', { options: { ...ON, measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = engine(on, [PLAN, GO])
    await complete($, await say($, 'Plan a CSV export for the reports page.'))
    await complete($, await say($, 'Looks good, build it.'))
    const [planned, built] = seen.records()
    expect(planned).toEqual(expect.objectContaining({ phase: 'plan', model: FABLE }))
    expect(planned).not.toHaveProperty('planMode')
    expect(planned).not.toHaveProperty('asked')
    expect(built).toEqual(expect.objectContaining({ phase: 'implement', model: SESSION }))
  })
})

// The session's own model is the plan-mode model (a /model choice): no switch is made for the plan or the build, so the
// build stays on it. Said once a conversation, so a person who expected the build on another model knows why.
describe('a session on the plan-mode model', () => {
  const OWN = { planModeModel: SESSION }
  const OWN_PLANS = { planModeModel: SESSION, planModelForPlans: true }
  const reply = (phase: string, more: string, why: string) => `{"phase":"${phase}","hard":false,"asked":"none","build":"none","faulted":false,${more}"why":"${why}"}`
  const GO = reply('implement', '"continues":true,', 'carry out the plan')
  const GO_SONNET = reply('implement', '"continues":true,"model":"sonnet",', 'carry out the plan on another model')
  const LINE = (level: string) => `Effort Pilot: building on the session's model (${SESSION}) at ${level}; it is also the plan-mode model, so the build stays on it (/model fable to build on fable).`
  const TOAST = `Effort Pilot: building on ${SESSION}, your /model choice (also the plan-mode model)`
  const said = (seen: { toasts: string[] }) => seen.toasts.filter(t => t.includes('your /model choice'))
  const say = ($: Engine, text: string) => turn($, text, 'default')

  test('an approved plan builds on it at the build effort, switches no model, and says so once', { options: OWN }, async ($, on) => {
    const seen = engine(on, PLAN)
    const id = await planning($)
    await exit($)
    await step($, id, 1)
    expect(seen.models).toEqual([SESSION, SESSION])
    expect(seen.sent).toEqual(['high', 'medium'])
    expect(seen.added).toEqual([LINE('medium')])
    expect(said(seen)).toEqual([TOAST])
    expect(seen.toasts.filter(t => t.includes('back on') || t.includes('planning on'))).toEqual([])
    expect(seen.status.at(-1)).toBe('effort: med implement')
  })

  test('a second plan and build in the same conversation says nothing again', { options: OWN }, async ($, on) => {
    const seen = engine(on, PLAN)
    const a = await planning($)
    await exit($)
    await step($, a, 1)
    await complete($, a)
    const b = await planning($)
    await exit($)
    await step($, b, 1)
    expect(seen.models).toEqual([SESSION, SESSION, SESSION, SESSION])
    expect(seen.sent).toEqual(['high', 'medium', 'high', 'medium'])
    expect(said(seen)).toEqual([TOAST])
    expect(seen.added).toEqual([LINE('medium'), 'Effort Pilot: reasoning effort goes to medium from the next message, for carrying out the approved plan.'])
  })

  test('leaving plan mode by Shift+Tab to build says so with the build\'s prompt', { options: OWN }, async ($, on) => {
    const seen = engine(on, [PLAN, GO])
    const id = await planning($)
    await complete($, id)
    await building($)
    expect(seen.models).toEqual([SESSION, SESSION])
    expect(seen.sent).toEqual(['high', 'medium'])
    expect(seen.added).toEqual([LINE('medium')])
    expect(said(seen)).toEqual([TOAST])
  })

  test('with plans outside plan mode on it too, building a plan says so once; a later build does not', { options: OWN_PLANS }, async ($, on) => {
    const seen = engine(on, [PLAN, GO, PLAN, GO])
    for (const text of ['Plan a CSV export for the reports page.', 'Looks good, build it.', 'Plan a PDF export too.', 'Build that one as well.']) {
      await complete($, await say($, text))
    }
    expect(seen.models).toEqual([SESSION, SESSION, SESSION, SESSION])
    expect(seen.sent).toEqual(['high', 'medium', 'high', 'medium'])
    expect(seen.context.join('\n')).toContain(`A note from the Effort Pilot plugin; nothing to do for it now. ${LINE('medium')}`)
    expect(seen.added).toEqual([LINE('medium')])
    expect(said(seen)).toEqual([TOAST])
    expect(seen.toasts.filter(t => t.includes('back on') || t.includes('planning on'))).toEqual([])
  })

  test('a new build task typed while the plan\'s turn runs says so with the next tool result', { options: OWN_PLANS }, async ($, on) => {
    const seen = engine(on, [PLAN, reply('implement', '"continues":false,', 'an unrelated change')])
    const id = await say($, 'Plan a CSV export for the reports page.')
    await $.prompt.submit({ text: 'Rename the save button to Store.', origin: { kind: 'composer' }, turnId: id } as never)
    await step($, id, 1)
    expect(seen.models).toEqual([SESSION, SESSION])
    // A message typed mid-turn never lowers the running turn's effort.
    expect(seen.added).toEqual([LINE('high')])
    expect(said(seen)).toEqual([TOAST])
  })

  test('with plans outside plan mode left to the session, a plan read from a message and built says nothing', { options: OWN }, async ($, on) => {
    const seen = engine(on, [PLAN, GO])
    await complete($, await say($, 'Plan a CSV export for the reports page.'))
    await say($, 'Looks good, build it.')
    expect(seen.added).toEqual([])
    expect(said(seen)).toEqual([])
  })

  test('with the only other model the pilot steers of the same family, the line names no model to switch to', { options: { planModeModel: SESSION, managedModels: 'opus' } }, async ($, on) => {
    const seen = engine(on, PLAN)
    const id = await planning($)
    await exit($)
    expect(seen.added).toEqual([LINE('medium').replace('/model fable to build on fable', '/model to build on another')])
  })

  test('a model asked for the build in words takes over, and nothing is said of the session\'s', { options: OWN_PLANS }, async ($, on) => {
    // A model named is read twice.
    const seen = engine(on, [PLAN, GO_SONNET, GO_SONNET])
    await complete($, await say($, 'Plan a CSV export for the reports page.'))
    await say($, 'Looks good, build it on Sonnet.')
    expect(seen.models).toEqual([SESSION, 'sonnet'])
    expect(said(seen)).toEqual([])
  })

  test('with the pilot off, in shadow mode or paused by /effort, nothing is said', { options: OWN }, async ($, on) => {
    const seen = engine(on, PLAN)
    for (const how of [() => run($, 'off'), () => run($, 'shadow'), () => $.command.run({ command: 'effort', args: 'max', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })]) {
      await run($, 'on')
      await how()
      const id = await planning($)
      await exit($)
      await step($, id, 1)
      await complete($, id)
    }
    expect(said(seen)).toEqual([])
    expect(seen.added.filter(t => t.includes('plan-mode model'))).toEqual([])
  })

  test('a headless session run as an agent says nothing when its plan is carried out', { options: { ...OWN_PLANS, headless: true, sessionAgent: 'reviewer' } }, async ($, on) => {
    const seen = engine(on, [PLAN, GO])
    on('session.start', () => ({ cwd: '/' }))
    await $.session.start({ cwd: '/', surface: null, isInteractive: false })
    await $.prompt.submit({ text: 'Plan the CSV export for the reports page, then implement it.', origin: { kind: 'sdk' } } as never)
    await $.turn.start({ text: 'brief', turnId: 'h1' })
    await step($, 'h1', 0)
    await $.tool.call({ tool: 'Skill', skill: 'tools:implement-plan', args: 'docs/plans/csv-export.md', tool_use_id: 'sk1' } as never)
    await step($, 'h1', 1)
    expect(seen.sent).toEqual(['high', 'medium'])
    expect(said(seen)).toEqual([])
    expect(seen.added.filter(t => t.includes('plan-mode model'))).toEqual([])
  })
})

describe('a session on another model than the plan-mode model', () => {
  test('an approved plan goes back on the session\'s model, and nothing says the build stays', { options: { planModeModel: FABLE } }, async ($, on) => {
    const seen = engine(on, PLAN)
    const id = await planning($)
    await exit($)
    await step($, id, 1)
    expect(seen.models).toEqual([FABLE, SESSION])
    expect(seen.added).toEqual([`Effort Pilot: back on the session's model (${SESSION}) now; reasoning effort goes to medium from the next message, for carrying out the approved plan.`])
    expect(seen.toasts.filter(t => t.includes('your /model choice'))).toEqual([])
  })
})
