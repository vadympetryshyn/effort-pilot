import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { afterPlan, agreed, briefPrompt, carry, fromBrief, isModel, MODEL_LINE, modelId, modelsSplit, parse, prompt, SYSTEM } from './route'

// A model the person asks for in words: the main loop's requests go on it for the rest of the session, until another
// ask, their own /model or /effort-pilot off. A model named for making a plan and another for carrying it out.

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const usage: Usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SESSION = 'claude-opus-5-5'
const APPROVED = 'User has approved your plan. You can now start coding.'
type Fields = { phase: string; asked?: string; build?: string; model?: string; buildModel?: string; continues?: boolean; hard?: boolean }
const reply = (f: Fields) => JSON.stringify({
  phase: f.phase, hard: f.hard ?? false, continues: f.continues ?? false, asked: f.asked ?? 'none', build: f.build ?? 'none',
  model: f.model ?? 'none', buildModel: f.buildModel ?? 'none', faulted: false, why: 'test',
})
const BUILD = reply({ phase: 'implement' })

/**
 * A session on Opus 5.5: replies picks the classifier's answer by the message it reads (the first key the prompt holds),
 * else BUILD. Records each main-loop request's model and effort, the subagents' models, the notices, the lines added,
 * the context a prompt went with, the status lines and the turn records.
 */
function engine(on: On, replies: Record<string, string | string[]> = {}, opts: { refuse?: string; expand?: Engine } = {}) {
  const seen = {
    session: SESSION, models: [] as string[], sent: [] as unknown[], agents: [] as string[], notices: [] as string[],
    added: [] as string[], context: [] as string[], status: [] as string[], toasts: [] as string[], files: new Map<string, string>(),
    skill: null as string | null,
  }
  const records = () => [...seen.files.values()].flatMap(t => t.split('\n').filter(Boolean)).map(l => JSON.parse(l) as Record<string, unknown>)
  const calls = new Map<string, number>()
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: seen.session }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', (_$, e) => {
    // Only the message read now, not the work under way the prompt also quotes.
    const message = e.prompt.slice(e.prompt.lastIndexOf('new message:'))
    const key = Object.keys(replies).find(k => message.includes(k))
    const r = key === undefined ? BUILD : replies[key]!
    const n = calls.get(key ?? '') ?? 0
    calls.set(key ?? '', n + 1)
    return { value: { isAnswered: true, text: Array.isArray(r) ? r[n % r.length]! : r, usage } }
  })
  on('prompt.submit', async (_$, e) => {
    seen.context.push(...(e.context ?? []))
    // A command the engine expands beneath: the prompt the model reads for it.
    if (e.command && opts.expand) seen.skill = (await opts.expand.skill.prompt({ skill: e.command.name, text: 'Review the change.', frontmatter: {} } as never)).text
    return { text: e.text }
  })
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
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('session.append', (_$, e, next) => {
    const text = e.message.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    if (e.message.type === 'system') seen.notices.push(text)
    else seen.added.push(text)
    return next(e)
  })
  on('tool.call', () => ({ result: { plan: 'Add hello.txt.' }, text: APPROVED }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    if (e.agentId === undefined) {
      seen.models.push(e.model)
      seen.sent.push(e.effort)
    } else seen.agents.push(e.model)
    const none = e.agentId === undefined && e.model === opts.refuse
    return { turnId: e.turnId, index: e.index, answer: none ? '' : 'ok', toolUses: [], stopReason: none ? null : 'end_turn', usage: none ? null : usage } as never
  })
  seen0 = seen
  return Object.assign(seen, { records })
}
// The engine of the test running: the context the classic prompt hook adds goes beside prompt.submit's.
let seen0: { context: string[] } | null = null

let n = 0
let messages = 0
async function step($: Engine, turnId: string, index: number) {
  for await (const _ of $.turn.step({ turnId, index, model: SESSION, effort: 'high', messageCount: ++messages })) { /* drain */ }
}
/** A prompt typed in a permission mode, its turn's first request; the turn left open (end it with complete). */
async function turn($: Engine, text: string, permission: 'plan' | 'default' = 'default') {
  const id = `t${++n}`
  await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  const r = await $.classic.UserPromptSubmit({ prompt: text, permission_mode: permission } as never) as { additionalContext?: string[] }
  seen0?.context.push(...(r?.additionalContext ?? []))
  await $.turn.start({ text, turnId: id })
  await step($, id, 0)
  return id
}
const complete = ($: Engine, turnId: string, reason = 'answer') => $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason } as never)
/** One whole turn. */
async function said($: Engine, text: string, permission: 'plan' | 'default' = 'default') {
  const id = await turn($, text, permission)
  await complete($, id)
  return id
}
const run = async ($: Engine, command: string, args = '') => (await $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text
const exit = ($: Engine) => $.tool.call({ tool: 'ExitPlanMode', plan: 'Add hello.txt.', tool_use_id: 'tu1' } as never)

const SONNET_MEDIUM = reply({ phase: 'chat', model: 'sonnet', asked: 'medium' })
const BACK = reply({ phase: 'chat', model: 'opus' })
const SWITCHED = 'Effort Pilot: now on sonnet at medium, as you asked; the model holds until Claude Code restarts (say "back to opus" or use /model to change).'
const ON_SONNET = 'The Effort Pilot plugin already sends this turn\'s requests to sonnet, as the person asked: you run on sonnet now, whatever model the system prompt names. Each turn on another model than the system prompt\'s gets such a line; a turn without one runs on the system prompt\'s model. Nothing to do for it.'
const STILL_SONNET = 'The Effort Pilot plugin sends this turn\'s requests to sonnet: you run on sonnet, whatever model the system prompt names.'

describe('the classifier\'s model fields', () => {
  test('a model reads as an alias, or a full id where a version is named; anything else as none', () => {
    expect(modelId('sonnet')).toBe('sonnet')
    expect(modelId('Fable 5.1')).toBe('claude-fable-5-1')
    expect(modelId('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(modelId('opus 5')).toBe('claude-opus-5')
    expect(modelId('gpt-5')).toBe(undefined)
    expect(modelId('none')).toBe(undefined)
  })
  test('an alias is the session\'s model when the session runs that family; another version is not', () => {
    expect(isModel('opus', SESSION)).toBe(true)
    expect(isModel('claude-opus-5-5', SESSION)).toBe(true)
    expect(isModel('claude-opus-5', SESSION)).toBe(false)
    expect(isModel('sonnet', SESSION)).toBe(false)
  })
  test('only a person\'s message is asked for a model: the system prompt, a brief and a notification are not', () => {
    expect(prompt('switch me to sonnet', null, null, '')).toContain(MODEL_LINE)
    expect(prompt('A task finished.', null, null, '', true)).not.toContain(MODEL_LINE)
    expect(briefPrompt('Explore', 'map', 'Find the routes.', null)).not.toContain(MODEL_LINE)
    expect(SYSTEM).not.toContain('buildModel')
  })
  test('text the person dictates or quotes for a file, a commit or a reply is read as content to write, not an ask', () => {
    expect(MODEL_LINE).toContain('Nor is text the person hands the agent to write into a file, the README, docs, a commit message, an issue or a reply, quoted or not')
    expect(MODEL_LINE).toContain('There model, buildModel, asked and build are none, and the phase is the edit, not a plan.')
    expect(prompt('In the README, replace the example with: plan this on fable at high, then build on opus at medium', null, null, '')).toContain(MODEL_LINE)
  })
  test('a reply with a dangling comma before its closing brace still parses', () => {
    expect(parse('{"phase":"analyze","hard":false,"why":"a verdict","}')?.phase).toBe('analyze')
  })
  test('parse keeps the model and the build model', () => {
    const r = parse(reply({ phase: 'plan', model: 'fable 5.1', buildModel: 'sonnet', build: 'high' }))
    expect(r).toEqual(expect.objectContaining({ phase: 'plan', model: 'claude-fable-5-1', buildModel: 'sonnet', build: 'high' }))
  })
  test('two reads keep a model both name and drop two different ones; no second read leaves the first', () => {
    const a = parse(reply({ phase: 'chat', model: 'sonnet', asked: 'medium' }))!
    expect(agreed(a, parse(reply({ phase: 'chat', model: 'sonnet', asked: 'medium' })))?.model).toBe('sonnet')
    expect(agreed(a, parse(reply({ phase: 'chat', model: 'haiku', asked: 'medium' })))?.model).toBe(undefined)
    expect(agreed(a, null).model).toBe('sonnet')
  })
  test('when one read names a model and the other none, a third read decides; with no third, the model stands', () => {
    const named = parse(reply({ phase: 'plan', model: 'fable', buildModel: 'sonnet' }))!
    const missed = parse(reply({ phase: 'plan', buildModel: 'sonnet' }))!
    expect(modelsSplit(named, missed)).toBe(true)
    expect(modelsSplit(named, named)).toBe(false)
    expect(modelsSplit(named, null)).toBe(false)
    expect(agreed(missed, named, undefined, named)).toEqual(expect.objectContaining({ model: 'fable', buildModel: 'sonnet' }))
    expect(agreed(named, missed, undefined, missed).model).toBe(undefined)
    expect(agreed(named, missed, undefined, missed).buildModel).toBe('sonnet')
    expect(agreed(named, missed, undefined, null).model).toBe('fable')
    expect(agreed(named, missed).model).toBe('fable')
  })
  test('a subagent\'s brief asks for no model', () => {
    const r = fromBrief(parse(reply({ phase: 'implement', model: 'haiku', buildModel: 'sonnet' }))!)
    expect(r.model).toBe(undefined)
    expect(r.buildModel).toBe(undefined)
  })
  test('the build model waits on the plan, and takes over when a follow-up starts building', () => {
    const plan = carry(null, parse(reply({ phase: 'plan', model: 'fable', buildModel: 'sonnet', build: 'high' }))!, 'Plan hello.txt.')
    expect(plan.task.buildModel).toBe('sonnet')
    expect(plan.route.model).toBe('fable')
    const go = carry(plan.task, parse(reply({ phase: 'implement', continues: true }))!, 'go')
    expect(go.route).toEqual(expect.objectContaining({ phase: 'implement', model: 'sonnet', effort: 'high', asked: 'high' }))
    expect(go.task.buildModel).toBe(undefined)
  })
  test('a build model said later during planning is kept on the plan', () => {
    const plan = carry(null, parse(reply({ phase: 'plan' }))!, 'Plan hello.txt.')
    const later = carry(plan.task, parse(reply({ phase: 'plan', continues: true, buildModel: 'haiku' }))!, 'and build it on haiku')
    expect(later.task.buildModel).toBe('haiku')
    expect(later.route.model).toBe(undefined)
  })
  test('an approved plan takes the build model', () => {
    const r = afterPlan('Add hello.txt.', { phase: 'plan', hard: false, effort: 'high', text: 'x', build: 'medium', buildModel: 'sonnet' })
    expect(r.route).toEqual(expect.objectContaining({ model: 'sonnet', effort: 'medium', asked: 'medium' }))
    expect(r.route.why).toBe('plan approved: carrying it out on sonnet at medium, as you asked')
  })
})

test('a model asked for with an effort holds for the rest of the session, at that effort on a model the pilot does not manage', async ($, on) => {
  const seen = engine(on, { 'switch me to sonnet': SONNET_MEDIUM })
  await said($, 'switch me to sonnet at medium')
  await said($, 'Add an export button to the reports page.')
  expect(seen.models).toEqual(['sonnet', 'sonnet'])
  expect(seen.sent).toEqual(['medium', 'medium'])
  expect(seen.notices).toEqual([SWITCHED])
  expect(seen.context).toEqual([`${ON_SONNET} ${SWITCHED}`, STILL_SONNET])
  expect(seen.status.at(-1)).toBe('effort: med · you asked · sonnet')
  expect(await run($, 'effort-pilot')).toContain('on sonnet at medium, as you asked')
})

test('asking for the session\'s own model hands the loop back to it', async ($, on) => {
  const seen = engine(on, { 'switch me to sonnet': SONNET_MEDIUM, 'back to opus': BACK })
  await said($, 'switch me to sonnet at medium')
  await said($, 'back to opus')
  await said($, 'Add an export button to the reports page.')
  expect(seen.models).toEqual(['sonnet', SESSION, SESSION])
  expect(seen.sent).toEqual(['medium', 'low', 'medium'])
  expect(seen.notices.at(-1)).toBe(`Effort Pilot: back on the session's model (${SESSION}) at low.`)
})

test('on a model the pilot manages, the effort is routed turn by turn', async ($, on) => {
  const seen = engine(on, { 'fable 5.1': reply({ phase: 'chat', model: 'fable 5.1' }), 'quick question': reply({ phase: 'chat' }) })
  await said($, 'switch to fable 5.1')
  await said($, 'Add an export button to the reports page.')
  await said($, 'quick question: what is the default port?')
  expect(seen.models).toEqual(['claude-fable-5-1', 'claude-fable-5-1', 'claude-fable-5-1'])
  expect(seen.sent).toEqual(['low', 'medium', 'low'])
  expect(seen.status.at(-1)).toBe('effort: low chat · fable-5-1')
})

test('a model one of the two reads misses is taken when a third read names it; two different models are not', async ($, on) => {
  const seen = engine(on, {
    'switch me to sonnet': [SONNET_MEDIUM, reply({ phase: 'chat', asked: 'medium' })],
    'switch to haiku': [reply({ phase: 'chat', model: 'haiku' }), reply({ phase: 'chat', model: 'fable' })],
    'back to opus': BACK,
  })
  await said($, 'switch me to sonnet at medium')
  await said($, 'back to opus')
  await said($, 'switch to haiku')
  expect(seen.models).toEqual(['sonnet', SESSION, SESSION])
})

test('a model asked with no effort is read twice, and a plan model one read misses is kept when a third read names it', async ($, on) => {
  const seen = engine(on, {
    'plan adding hello.txt': [reply({ phase: 'plan', buildModel: 'sonnet' }), reply({ phase: 'plan', model: 'fable', buildModel: 'sonnet' }), reply({ phase: 'plan', model: 'fable', buildModel: 'sonnet' })],
  })
  await said($, 'plan adding hello.txt on fable, then implement on sonnet', 'plan')
  expect(seen.models).toEqual(['fable'])
  expect(seen.notices[0]).toContain('planning on fable')
  expect(seen.notices[0]).toContain('carried out on sonnet')
})

test('a subagent\'s requests keep their own model', async ($, on) => {
  const seen = engine(on, { 'switch me to sonnet': SONNET_MEDIUM })
  const id = await turn($, 'switch me to sonnet at medium')
  for await (const _ of $.turn.step({ turnId: id, index: 0, model: 'claude-haiku-5', effort: 'high', messageCount: 1, agentId: 'a1' })) { /* drain */ }
  expect(seen.agents).toEqual(['claude-haiku-5'])
  expect(seen.models).toEqual(['sonnet'])
})

test('/effort-pilot off ends the ask', async ($, on) => {
  const seen = engine(on, { 'switch me to sonnet': SONNET_MEDIUM })
  await said($, 'switch me to sonnet at medium')
  await run($, 'effort-pilot', 'off')
  await run($, 'effort-pilot', 'on')
  await said($, 'Add an export button to the reports page.')
  expect(seen.models).toEqual(['sonnet', SESSION])
})

test('/effort-pilot off clears the status line that named the asked model; shadow marks it', async ($, on) => {
  const seen = engine(on, { 'switch me to sonnet': SONNET_MEDIUM })
  await said($, 'switch me to sonnet at medium')
  expect(seen.status.at(-1)).toBe('effort: med · you asked · sonnet')
  await run($, 'effort-pilot', 'off')
  expect(seen.status.at(-1)).toBe('')
  await run($, 'effort-pilot', 'on')
  await said($, 'Add an export button to the reports page.')
  await run($, 'effort-pilot', 'shadow')
  expect(seen.status.at(-1)).toBe('effort (shadow): med implement')
})

test('the person\'s own /model ends the ask', async ($, on) => {
  const seen = engine(on, { 'switch me to sonnet': SONNET_MEDIUM })
  await said($, 'switch me to sonnet at medium')
  seen.session = 'claude-fable-5-2'
  await run($, 'model', 'claude-fable-5-2')
  for await (const _ of $.turn.step({ turnId: 'x', index: 0, model: 'claude-fable-5-2', effort: 'high', messageCount: ++messages })) { /* drain */ }
  expect(seen.models).toEqual(['sonnet', 'claude-fable-5-2'])
})

test('a model the API refuses is dropped once its turn ends on an error, and the next turn goes on the session\'s model', async ($, on) => {
  const seen = engine(on, { 'sonnet 9.9': reply({ phase: 'chat', model: 'sonnet 9.9' }) }, { refuse: 'claude-sonnet-9-9' })
  const id = await turn($, 'switch to sonnet 9.9')
  await complete($, id, 'error')
  await said($, 'Add an export button to the reports page.')
  expect(seen.models).toEqual(['claude-sonnet-9-9', SESSION])
  expect(seen.notices.at(-1)).toBe(`Effort Pilot: claude-sonnet-9-9 is not available here; back on the session's model (${SESSION}).`)
})

test('a turn on an asked model is recorded on it, and as asked', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
  const seen = engine(on, { 'fable 5.1': reply({ phase: 'chat', model: 'fable 5.1' }) })
  await said($, 'switch to fable 5.1')
  await said($, 'Add an export button to the reports page.')
  expect(seen.records().at(-1)).toEqual(expect.objectContaining({ model: 'claude-fable-5-1', phase: 'implement', asked: true }))
})

const PLAN_BOTH = reply({ phase: 'plan', model: 'fable', asked: 'high', buildModel: 'sonnet', build: 'medium' })
const BUILD_LINE = 'Effort Pilot: carrying out the plan on sonnet at medium, as you asked.'

test('a plan model holds while planning, and an approved plan goes on the build model at the build effort', async ($, on) => {
  const seen = engine(on, { 'plan adding hello.txt': PLAN_BOTH })
  const id = await turn($, 'plan adding hello.txt on fable at high, then implement on sonnet at medium')
  await exit($)
  await step($, id, 1)
  await complete($, id)
  await said($, 'Add an export button to the reports page.')
  expect(seen.models).toEqual(['fable', 'sonnet', 'sonnet'])
  expect(seen.sent).toEqual(['high', 'medium', 'medium'])
  expect(seen.added).toEqual([BUILD_LINE])
})

test('a follow-up that starts building takes the build model', async ($, on) => {
  const seen = engine(on, { 'plan adding hello.txt': PLAN_BOTH, 'go, implement': reply({ phase: 'implement', continues: true }) })
  await said($, 'plan adding hello.txt on fable at high, then implement on sonnet at medium')
  await said($, 'go, implement it')
  expect(seen.models).toEqual(['fable', 'sonnet'])
  expect(seen.sent).toEqual(['high', 'medium'])
  expect(seen.notices).toEqual([
    'Effort Pilot: planning on fable at high, as you asked. Effort Pilot: the plan will be carried out on sonnet at medium, as you asked; the pilot switches to it when building starts.',
    BUILD_LINE,
  ])
})

test('in plan mode a model asked for the plan wins over the plan-mode model', { options: { planModeModel: 'claude-fable-5-2' } }, async ($, on) => {
  const seen = engine(on, { 'on haiku': reply({ phase: 'plan', model: 'haiku' }) })
  await said($, 'plan the export on haiku', 'plan')
  expect(seen.models).toEqual(['haiku'])
})

test('a model asked earlier gives way to the plan-mode model in plan mode, and comes back after the approval', { options: { planModeModel: 'claude-fable-5-2' } }, async ($, on) => {
  const seen = engine(on, { 'switch me to sonnet': SONNET_MEDIUM })
  await said($, 'switch me to sonnet at medium')
  const id = await turn($, 'Plan a CSV export for the reports page.', 'plan')
  await exit($)
  await step($, id, 1)
  expect(seen.models).toEqual(['sonnet', 'claude-fable-5-2', 'sonnet'])
  expect(seen.sent).toEqual(['medium', 'high', 'medium'])
  expect(seen.added).toEqual(['Effort Pilot: reasoning effort is now medium, on sonnet, for carrying out the approved plan.'])
})

describe('what a switch tells the person and the model', () => {
  test('a switch shows one toast naming the model and the effort, and no effort toast beside it', async ($, on) => {
    const seen = engine(on, { 'switch me to sonnet': reply({ phase: 'chat', model: 'sonnet', asked: 'low' }) })
    await said($, 'Add an export button to the reports page.')
    seen.toasts.length = 0
    await said($, 'switch me to sonnet at low')
    expect(seen.models).toEqual([SESSION, 'sonnet'])
    expect(seen.sent).toEqual(['medium', 'low'])
    expect(seen.toasts).toEqual(['Effort Pilot: now on sonnet at low'])
    expect(seen.notices).toEqual(['Effort Pilot: now on sonnet at low, as you asked; the model holds until Claude Code restarts (say "back to opus" or use /model to change).'])
  })
  test('an effort-only change still toasts the effort', async ($, on) => {
    const seen = engine(on, { 'quick question': reply({ phase: 'chat' }) })
    await said($, 'Add an export button to the reports page.')
    await said($, 'quick question: what is the default port?')
    expect(seen.toasts).toEqual(['effort: med → low chat'])
  })
  test('a switch with no effort named goes at the person\'s own effort, and says so', async ($, on) => {
    const seen = engine(on, { 'switch to sonnet': reply({ phase: 'chat', model: 'sonnet' }) })
    await said($, 'switch to sonnet')
    expect(seen.sent).toEqual(['high'])
    expect(seen.toasts).toEqual(['Effort Pilot: now on sonnet at your own effort'])
    expect(seen.notices).toEqual(['Effort Pilot: now on sonnet at your own effort; the model holds until Claude Code restarts (say "back to opus" or use /model to change).'])
    expect(seen.status.at(-1)).toBe('effort: your own · sonnet')
  })
  test('going back with an effort named shows one toast and says the effort was asked', async ($, on) => {
    const seen = engine(on, { 'switch me to sonnet': SONNET_MEDIUM, 'back to opus': reply({ phase: 'chat', model: 'opus', asked: 'high' }) })
    await said($, 'switch me to sonnet at medium')
    seen.toasts.length = 0
    seen.context.length = 0
    await said($, 'back to opus at high')
    expect(seen.models).toEqual(['sonnet', SESSION])
    expect(seen.sent).toEqual(['medium', 'high'])
    expect(seen.toasts).toEqual([`Effort Pilot: back on ${SESSION} at high`])
    expect(seen.notices.at(-1)).toBe(`Effort Pilot: back on the session's model (${SESSION}) at high, as you asked.`)
    expect(seen.context).toEqual([`The Effort Pilot plugin already sends this turn's requests to ${SESSION}, as the person asked: you run on ${SESSION} now, whatever model the system prompt names. Each turn on another model than the system prompt's gets such a line; a turn without one runs on the system prompt's model. Nothing to do for it. Effort Pilot: back on the session's model (${SESSION}) at high, as you asked.`])
  })
  test('once back on the session\'s model, later prompts carry no model line', async ($, on) => {
    const seen = engine(on, { 'switch me to sonnet': SONNET_MEDIUM, 'back to opus': BACK })
    await said($, 'switch me to sonnet at medium')
    await said($, 'back to opus')
    seen.context.length = 0
    await said($, 'Add an export button to the reports page.')
    expect(seen.context).toEqual([])
  })
  test('asking for the model already in use says so, once', async ($, on) => {
    const seen = engine(on, { 'use opus': reply({ phase: 'chat', model: 'opus' }) })
    await said($, 'use opus for this')
    expect(seen.models).toEqual([SESSION])
    expect(seen.toasts).toEqual([`Effort Pilot: already on ${SESSION} at low`])
    expect(seen.notices).toEqual([`Effort Pilot: already on the session's model (${SESSION}) at low.`])
  })
  test('a model the API refuses toasts once its turn ends, and says where requests go', async ($, on) => {
    const seen = engine(on, { 'sonnet 9.9': reply({ phase: 'chat', model: 'sonnet 9.9' }) }, { refuse: 'claude-sonnet-9-9' })
    const id = await turn($, 'switch to sonnet 9.9')
    expect(seen.toasts).toEqual(['Effort Pilot: now on claude-sonnet-9-9 at your own effort'])
    await complete($, id, 'error')
    expect(seen.toasts.at(-1)).toBe(`Effort Pilot: claude-sonnet-9-9 is not available here; back on ${SESSION}`)
    expect(seen.status.at(-1)).toBe('effort: back on opus-5-5 · claude-sonnet-9-9 is not available')
  })
  test('in shadow mode a switch is not made, and the line says so', async ($, on) => {
    const seen = engine(on, { 'switch me to sonnet': SONNET_MEDIUM })
    await run($, 'effort-pilot', 'shadow')
    await said($, 'switch me to sonnet at medium')
    expect(seen.models).toEqual([SESSION])
    expect(seen.toasts).toEqual([])
    expect(seen.notices).toEqual(['Effort Pilot is in shadow mode: it does not switch the model (/effort-pilot on lets it, or use /model).'])
    expect(seen.context[0]).toStartWith('A note from the Effort Pilot plugin; nothing to do for it now.')
  })
  test('a build model for later is not said to take effect now', async ($, on) => {
    const seen = engine(on, { 'plan adding hello.txt': reply({ phase: 'plan', buildModel: 'sonnet' }) })
    await said($, 'plan adding hello.txt, then implement on sonnet')
    expect(seen.models).toEqual([SESSION])
    expect(seen.toasts).toEqual([])
    expect(seen.context).toEqual(['A note from the Effort Pilot plugin; nothing to do for it now. Effort Pilot: the plan will be carried out on sonnet, as you asked; the pilot switches to it when building starts.'])
  })
  test('a plan model and a build model: the context names only the plan model as in effect', async ($, on) => {
    const seen = engine(on, { 'plan adding hello.txt': PLAN_BOTH })
    await said($, 'plan adding hello.txt on fable at high, then implement on sonnet at medium')
    expect(seen.toasts).toEqual(['Effort Pilot: planning on fable at high'])
    expect(seen.context[0]).toStartWith('The Effort Pilot plugin already sends this turn\'s requests to fable, as the person asked: you run on fable now')
    expect(seen.context[0]).toContain('the pilot switches to it when building starts')
    expect(seen.context).toHaveLength(1)
  })
  test('a turn in plan mode on the plan-mode model is told which model it runs on', { options: { planModeModel: 'claude-fable-5-2' } }, async ($, on) => {
    const seen = engine(on)
    await said($, 'Plan a CSV export for the reports page.', 'plan')
    expect(seen.models).toEqual(['claude-fable-5-2'])
    expect(seen.context).toEqual(['The Effort Pilot plugin sends this turn\'s requests to claude-fable-5-2: you run on claude-fable-5-2, whatever model the system prompt names.'])
  })
  test('an approved plan on a build model shows one toast, the build model\'s', async ($, on) => {
    const seen = engine(on, { 'plan adding hello.txt': PLAN_BOTH })
    const id = await turn($, 'plan adding hello.txt on fable at high, then implement on sonnet at medium')
    seen.toasts.length = 0
    await exit($)
    await step($, id, 1)
    expect(seen.toasts).toEqual(['Effort Pilot: carrying out the plan on sonnet at medium'])
  })
})

const NOTE = 'A note from the Effort Pilot plugin; nothing to do for it now. '

describe('where the pilot switches no model, the model reads why', () => {
  test('with the effort set by hand, the first prompt after it says the pilot is paused, once, and no switch is made', async ($, on) => {
    const seen = engine(on, { 'switch me to sonnet': SONNET_MEDIUM })
    await run($, 'effort', 'high')
    await said($, 'switch me to sonnet at medium')
    await said($, 'Add an export button to the reports page.')
    expect(seen.models).toEqual([SESSION, SESSION])
    expect(seen.notices).toEqual([])
    expect(seen.context).toEqual([`${NOTE}Effort Pilot: The person set the effort by hand (/effort high), so the pilot is paused in this session: it sets no effort and switches no model asked for in words until /effort-pilot on (or /effort auto). The person's /model switches the model.`])
  })
  test('another level set by hand says so again; once the pilot is back, nothing is said', async ($, on) => {
    const seen = engine(on)
    await run($, 'effort', 'high')
    await said($, 'Add an export button to the reports page.')
    await run($, 'effort', 'low')
    await said($, 'Add a print button to the reports page.')
    await run($, 'effort', 'auto')
    await said($, 'Add a share button to the reports page.')
    expect(seen.context).toHaveLength(2)
    expect(seen.context[1]).toContain('(/effort low)')
  })
  test('on a model the pilot does not steer, the first prompt says so, once', async ($, on) => {
    const seen = engine(on, { 'switch to opus': reply({ phase: 'chat', model: 'opus' }) })
    seen.session = 'claude-sonnet-5'
    await said($, 'switch to opus')
    await said($, 'Add an export button to the reports page.')
    expect(seen.models).toEqual([SESSION, SESSION])
    expect(seen.context).toEqual([`${NOTE}Effort Pilot: The pilot does not steer claude-sonnet-5 (it steers: opus, fable): it sets no effort and switches no model asked for in words while the session is on it. The person's /model switches the model.`])
  })
  test('on a model where effort is one setting of the whole request, the first prompt says the pilot stands aside', async ($, on) => {
    const seen = engine(on)
    seen.session = 'claude-opus-4-6'
    await said($, 'switch to sonnet')
    expect(seen.context).toEqual([`${NOTE}Effort Pilot: The pilot stands aside on claude-opus-4-6: effort is one setting of the whole request on it, so a change would rewrite the prompt cache. It sets no effort and switches no model asked for in words while the session is on it. The person's /model switches the model.`])
  })
  test('a queued message that starts a turn of its own leaves no line of why no switch is made for a later prompt', async ($, on) => {
    const seen = engine(on)
    await run($, 'effort', 'high')
    const id = await turn($, 'Add a share button to the reports page.')
    seen.context.length = 0
    await $.prompt.submit({ text: 'Add an export button to the reports page.', turnId: id, origin: { kind: 'composer' } } as never)
    await complete($, id)
    await run($, 'effort', 'low')
    await $.turn.start({ text: 'Add an export button to the reports page.', turnId: 'queued1' })
    await complete($, 'queued1')
    await said($, 'Add a print button to the reports page.')
    expect(seen.context).toEqual([])
  })
  test('a switch typed mid-turn: the model reads its line with the next tool result, and the person sees it', async ($, on) => {
    const seen = engine(on, { 'switch me to sonnet': SONNET_MEDIUM })
    const id = await turn($, 'Add an export button to the reports page.')
    await $.prompt.submit({ text: 'switch me to sonnet at medium', turnId: id, origin: { kind: 'composer' } } as never)
    await step($, id, 1)
    const r = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu2' } as never) as { context?: string[] }
    const later = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu3' } as never) as { context?: string[] }
    expect(seen.models).toEqual([SESSION, 'sonnet'])
    expect(r.context).toEqual([`${ON_SONNET} ${SWITCHED}`])
    expect(later.context).toBe(undefined)
    expect(seen.notices).toEqual([SWITCHED])
  })
  test('a switch typed mid-turn whose turn ends before a tool runs leaves no line for later', async ($, on) => {
    engine(on, { 'switch me to sonnet': SONNET_MEDIUM })
    const id = await turn($, 'Add an export button to the reports page.')
    await $.prompt.submit({ text: 'switch me to sonnet at medium', turnId: id, origin: { kind: 'composer' } } as never)
    await step($, id, 1)
    await complete($, id)
    const r = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu2' } as never) as { context?: string[] }
    expect(r.context).toBe(undefined)
  })
  test('a switch asked in a slash command\'s arguments goes with the command\'s prompt the model reads', async ($, on) => {
    const seen = engine(on, { 'switch me to sonnet': SONNET_MEDIUM }, { expand: $ })
    await $.prompt.submit({ text: '/review switch me to sonnet at medium', command: { name: 'review', args: 'switch me to sonnet at medium' }, origin: { kind: 'composer' } } as never)
    expect(seen.skill).toBe(`Review the change.\n\n${ON_SONNET} ${SWITCHED}`)
    expect(seen.notices).toEqual([SWITCHED])
  })
})

test('a model only one read takes from text to be written, and a third read does not, is not switched to', async ($, on) => {
  const text = 'In the README, replace the example with: plan this on fable at high, then build on opus at medium'
  const wrong = reply({ phase: 'plan', model: 'fable', buildModel: 'opus' })
  const right = reply({ phase: 'trivial' })
  const seen = engine(on, { 'In the README, replace the example': [wrong, right, right] })
  await said($, text)
  expect(seen.models).toEqual([SESSION])
  expect(seen.toasts.some(t => t.includes('fable'))).toBe(false)
})
