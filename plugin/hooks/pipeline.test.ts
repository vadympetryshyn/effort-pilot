import type { On } from 'claude-code'
import { describe, expect } from 'claude-code/testing'
import { test } from './testkit'
import type { Engine } from 'claude-code/testing'

import { afterPlan, agreed, carry, fromBrief, MODEL_LINE, midTurn, modelsSplit, parse } from './route'

// A pipeline named in one message: plan on one model, build on another, test on a third. Plan and build switch the main
// loop's model; the test stage runs in a subagent the main agent starts on the model the person named, at their effort.

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const usage: Usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SESSION = 'claude-opus-5-5'
const APPROVED = 'User has approved your plan. You can now start coding.'
type Fields = { phase: string; asked?: string; build?: string; model?: string; buildModel?: string; testModel?: string; test?: string; continues?: boolean }
const reply = (f: Fields) => JSON.stringify({
  phase: f.phase, hard: false, continues: f.continues ?? false, asked: f.asked ?? 'none', build: f.build ?? 'none',
  model: f.model ?? 'none', buildModel: f.buildModel ?? 'none', testModel: f.testModel ?? 'none', test: f.test ?? 'none', faulted: false, why: 'test',
})
const BUILD = reply({ phase: 'implement' })
const THREE = reply({ phase: 'plan', model: 'fable', asked: 'high', buildModel: 'opus', build: 'medium', testModel: 'haiku', test: 'low' })
const GO = reply({ phase: 'implement', continues: true })
const ASIDE = reply({ phase: 'chat', continues: false })
const BUILD_TESTED = reply({ phase: 'implement', testModel: 'haiku', test: 'low' })

const FULL = 'From the Effort Pilot plugin: the person asked that testing and review of this work run on haiku at low. When you reach that stage, run it in a subagent (Agent tool) with model "haiku" and effort "low", giving it what it needs to check. Do not switch yourself.'
const REMINDER = 'Reminder from the Effort Pilot plugin: testing and review of this work go to a subagent (Agent tool) with model "haiku" and effort "low", as the person asked; do not switch yourself.'
const NOTICE = 'Effort Pilot: testing and review of this work will run in a subagent on haiku at low, as you asked.'

/**
 * A session on Opus 5.5: the classifier answers by the first key the message read holds, else BUILD. Records each
 * main-loop request's model and effort, each subagent request's model and effort, the descriptions spawns went with,
 * the notices, the lines added after a tool result, the context prompts went with, and the status lines.
 */
function engine(on: On, replies: Record<string, string | string[]> = {}) {
  const seen = {
    models: [] as string[], sent: [] as unknown[], agents: [] as { model: string; effort: unknown }[], spawned: [] as string[],
    notices: [] as string[], added: [] as string[], context: [] as string[], status: [] as string[],
  }
  const calls = new Map<string, number>()
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: SESSION }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', (_$, e) => {
    const message = e.prompt.slice(e.prompt.lastIndexOf('new message:'))
    const key = Object.keys(replies).find(k => message.includes(k))
    const r = key === undefined ? BUILD : replies[key]!
    const n = calls.get(key ?? '') ?? 0
    calls.set(key ?? '', n + 1)
    return { value: { isAnswered: true, text: Array.isArray(r) ? r[n % r.length]! : r, usage } }
  })
  on('prompt.submit', (_$, e) => {
    seen.context.push(...(e.context ?? []))
    return e.context ? { text: e.text, context: e.context } : { text: e.text }
  })
  on('ui.status', (_$, e) => {
    seen.status.push(e.text ?? '')
    return { value: undefined }
  })
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/someone' : undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('turn.complete', () => ({ text: 'done' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Box', children: [] }) as never)
  on('command.run', () => ({ text: '' }))
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('session.start', () => ({ cwd: '/' }))
  on('session.append', (_$, e, next) => {
    const text = e.message.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    if (e.message.type === 'system') seen.notices.push(text)
    else seen.added.push(text)
    return next(e)
  })
  on('tool.call', () => ({ result: { plan: 'Add slugify.' }, text: APPROVED }) as never)
  on('agent.spawn', (_$, e) => {
    seen.spawned.push(e.description)
    return { model: e.model ?? SESSION, agentId: e.name ?? 'a1' }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    if (e.agentId === undefined) {
      seen.models.push(e.model)
      seen.sent.push(e.effort)
    } else seen.agents.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  return seen
}

let n = 0
let messages = 0
async function step($: Engine, turnId: string, index: number) {
  for await (const _ of $.turn.step({ turnId, index, model: SESSION, effort: 'high', messageCount: ++messages })) { /* drain */ }
}
async function turn($: Engine, text: string, permission: 'plan' | 'default' = 'default', kind = 'composer') {
  const id = `t${++n}`
  await $.prompt.submit({ text, origin: { kind } } as never)
  await $.classic.UserPromptSubmit({ prompt: text, permission_mode: permission } as never)
  await $.turn.start({ text, turnId: id })
  await step($, id, 0)
  return id
}
const complete = ($: Engine, turnId: string) => $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
async function said($: Engine, text: string, permission: 'plan' | 'default' = 'default', kind = 'composer') {
  const id = await turn($, text, permission, kind)
  await complete($, id)
  return id
}
const exit = ($: Engine) => $.tool.call({ tool: 'ExitPlanMode', plan: 'Add slugify.', tool_use_id: 'tu1' } as never)
const run = async ($: Engine) => (await $.command.run({ command: 'effort-pilot', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text

/** The main agent starts a subagent: the Agent call (its model and effort as given), the spawn, its first request on `on`. */
async function spawn($: Engine, o: { model?: string; effort?: string; on?: string; stepEffort?: string | null; id?: string } = {}) {
  const id = o.id ?? 'a1'
  const tu = `tu-${id}`
  const prompt = 'Check that slugify handles empty strings and unicode, and run the tests.'
  await $.tool.call({ tool: 'Agent', prompt, description: 'check slugify', subagent_type: 'general-purpose', tool_use_id: tu, ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}) } as never)
  await $.agent.spawn({ prompt, description: 'check slugify', subagentType: 'general-purpose', parentModel: SESSION, provider: { plugin: 'engine', tier: 'core' }, tool_use_id: tu, name: id, ...(o.model ? { model: o.model } : {}) } as never)
  await $.turn.start({ text: prompt, turnId: `s-${id}`, agentId: id } as never)
  const effort = o.stepEffort === null ? {} : { effort: o.stepEffort ?? 'high' }
  for await (const _ of $.turn.step({ turnId: `s-${id}`, index: 0, model: o.on ?? o.model ?? SESSION, messageCount: 1, agentId: id, ...effort } as never)) { /* drain */ }
}

describe('the classifier\'s test stage', () => {
  test('the model line asks for a test model and a test level, and keeps text to write out of them', () => {
    expect(MODEL_LINE).toContain('Also add "testModel" and "test": the model (as above) and the level ("low|medium|high|xhigh|max|none") the person names for testing or reviewing the work once it is built')
    expect(MODEL_LINE).toEndWith('none otherwise, with the same exceptions.')
  })
  test('a three-stage pick is parsed whole', () => {
    expect(parse(THREE)).toEqual(expect.objectContaining({ phase: 'plan', model: 'fable', asked: 'high', buildModel: 'opus', build: 'medium', testModel: 'haiku', test: 'low' }))
    expect(parse(reply({ phase: 'implement', testModel: 'fable 5.1' }))?.testModel).toBe('claude-fable-5-1')
  })
  test('two reads keep the lower test level and a test model both name; one read alone is decided by a third', () => {
    const a = parse(reply({ phase: 'implement', testModel: 'haiku', test: 'medium' }))!
    const b = parse(reply({ phase: 'implement', testModel: 'haiku', test: 'low' }))!
    expect(agreed(a, b)).toEqual(expect.objectContaining({ testModel: 'haiku', test: 'low' }))
    const none = parse(reply({ phase: 'implement' }))!
    expect(agreed(a, none).test).toBe(undefined)
    expect(modelsSplit(a, none)).toBe(true)
    expect(agreed(a, none, undefined, none).testModel).toBe(undefined)
    expect(agreed(a, none, undefined, a).testModel).toBe('haiku')
  })
  test('a subagent\'s brief names no test stage', () => {
    const r = fromBrief(parse(reply({ phase: 'implement', testModel: 'haiku', test: 'low' }))!)
    expect(r.testModel).toBe(undefined)
    expect(r.test).toBe(undefined)
  })
})

describe('the test stage on the work under way', () => {
  const plan = () => carry(null, parse(THREE)!, 'Plan slugify.')
  test('a plan keeps the test stage, and building it keeps it on the build', () => {
    const p = plan()
    expect(p.task).toEqual(expect.objectContaining({ testModel: 'haiku', test: 'low', buildModel: 'opus' }))
    const go = carry(p.task, parse(GO)!, 'go')
    expect(go.task).toEqual(expect.objectContaining({ phase: 'implement', testModel: 'haiku', test: 'low' }))
    expect(go.task.buildModel).toBe(undefined)
  })
  test('an approved plan keeps the test stage on the build', () => {
    const r = afterPlan('Add slugify.', plan().task)
    expect(r.task).toEqual(expect.objectContaining({ phase: 'implement', testModel: 'haiku', test: 'low' }))
  })
  test('a side question keeps it; a new task drops it', () => {
    const go = carry(plan().task, parse(GO)!, 'go')
    expect(carry(go.task, parse(ASIDE)!, 'what port is it on?').task.testModel).toBe('haiku')
    const fresh = carry(go.task, parse(BUILD)!, 'Add a print button to the reports page.')
    expect(fresh.task.testModel).toBe(undefined)
    expect(fresh.task.test).toBe(undefined)
  })
  test('a follow-up that only names a test stage adds it to the work under way, at the prompt and mid-turn', () => {
    const build = carry(null, parse(BUILD)!, 'Add slugify.').task
    const later = carry(build, parse(reply({ phase: 'trivial', continues: true, testModel: 'sonnet' }))!, 'and test it on sonnet')
    expect(later.task).toEqual(expect.objectContaining({ phase: 'implement', testModel: 'sonnet' }))
    const mid = midTurn(build, null, parse(reply({ phase: 'chat', continues: true, test: 'high' }))!, 'review it at high')
    expect(mid?.route).toBe(null)
    expect(mid?.task).toEqual(expect.objectContaining({ phase: 'implement', test: 'high' }))
  })
})

test('a three-stage message: plan on fable at high, build on the session\'s opus at medium, then the test line once building starts', async ($, on) => {
  const seen = engine(on, { 'Plan on fable': THREE, 'go': GO, 'what port': ASIDE })
  await said($, 'Plan on fable at high, build on opus at medium, test on haiku at low: add slugify')
  expect(seen.context.some(c => c.includes('Testing and review of the built work will run in a subagent on haiku at low, as you asked.'))).toBe(true)
  expect(seen.context.some(c => c.includes('Do not switch yourself'))).toBe(false)
  seen.context.length = 0
  await said($, 'go')
  expect(seen.models).toEqual(['fable', SESSION])
  expect(seen.sent).toEqual(['high', 'medium'])
  expect(seen.context.at(-1)).toBe(FULL)
  expect(seen.notices.at(-1)).toBe(NOTICE)
  expect(seen.status.at(-1)).toContain('test: haiku·low')
  expect(await run($)).toContain('testing in a subagent on haiku at low, as you asked')
  seen.context.length = 0
  await said($, 'what port is it on?')
  expect(seen.context).toEqual([REMINDER])
  expect(seen.notices.filter(x => x === NOTICE)).toHaveLength(1)
})

test('a plan approved mid-turn tells the model of the test stage with the approval', async ($, on) => {
  const seen = engine(on, { 'Plan on fable': THREE })
  const id = await turn($, 'Plan on fable at high, build on opus at medium, test on haiku at low: add slugify')
  await exit($)
  await step($, id, 1)
  expect(seen.models).toEqual(['fable', SESSION])
  expect(seen.sent).toEqual(['high', 'medium'])
  expect(seen.added).toHaveLength(1)
  expect(seen.added[0]).toEndWith(FULL)
  expect(seen.notices.at(-1)).toBe(NOTICE)
})

test('a build with a test stage from the start gets the line on its first turn; a new task drops it', async ($, on) => {
  const seen = engine(on, { 'Add slugify': BUILD_TESTED })
  await said($, 'Add slugify, then test it on haiku at low')
  expect(seen.context).toEqual([FULL])
  seen.context.length = 0
  await said($, 'Add a print button to the reports page.')
  expect(seen.context).toEqual([])
  expect(seen.status.at(-1)).not.toContain('test:')
})

test('only a model named for the test stage: the line names no effort', async ($, on) => {
  const seen = engine(on, { 'Add slugify': reply({ phase: 'implement', testModel: 'sonnet' }) })
  await said($, 'Add slugify, then have sonnet review it')
  expect(seen.context).toEqual(['From the Effort Pilot plugin: the person asked that testing and review of this work run on sonnet. When you reach that stage, run it in a subagent (Agent tool) with model "sonnet", giving it what it needs to check. Do not switch yourself.'])
  expect(seen.status.at(-1)).toContain('test: sonnet')
})

test('a test stage typed mid-turn goes with the next tool result', async ($, on) => {
  const seen = engine(on, { 'and test it': reply({ phase: 'chat', continues: true, testModel: 'haiku', test: 'low' }) })
  const id = await turn($, 'Add slugify to the utils module.')
  await $.prompt.submit({ text: 'and test it on haiku at low', turnId: id, origin: { kind: 'composer' } } as never)
  await step($, id, 1)
  const r = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu9' } as never) as { context?: string[] }
  expect(r.context).toEqual([FULL])
  expect(seen.notices).toEqual([NOTICE])
})

describe('a subagent on the test model', () => {
  test('goes at the test effort when the call names none, on a model the pilot does not manage, and shows it', async ($, on) => {
    const seen = engine(on, { 'Add slugify': BUILD_TESTED })
    await turn($, 'Add slugify, then test it on haiku at low')
    await spawn($, { model: 'haiku', on: 'claude-haiku-5' })
    expect(seen.agents).toEqual([{ model: 'claude-haiku-5', effort: 'low' }])
    expect(seen.spawned).toEqual(['check slugify · effort low'])
  })
  test('a call that names an effort keeps it', async ($, on) => {
    const seen = engine(on, { 'Add slugify': BUILD_TESTED })
    await turn($, 'Add slugify, then test it on haiku at low')
    await spawn($, { model: 'haiku', effort: 'medium', stepEffort: 'medium' })
    expect(seen.agents).toEqual([{ model: 'haiku', effort: 'medium' }])
  })
  test('a subagent on another model is not the test stage', async ($, on) => {
    const seen = engine(on, { 'Add slugify': BUILD_TESTED })
    await turn($, 'Add slugify, then test it on haiku at low')
    await spawn($, { model: 'sonnet', on: 'claude-sonnet-5' })
    expect(seen.agents).toEqual([{ model: 'claude-sonnet-5', effort: 'high' }])
  })
  test('on a managed test model the test effort wins over the pilot\'s pick', async ($, on) => {
    const seen = engine(on, { 'Add slugify': reply({ phase: 'implement', testModel: 'fable', test: 'xhigh' }) })
    await turn($, 'Add slugify, then review it on fable at xhigh')
    await spawn($, { model: 'fable', on: 'claude-fable-5-2' })
    expect(seen.agents).toEqual([{ model: 'claude-fable-5-2', effort: 'xhigh' }])
  })
  test('a model that takes no effort gets none', async ($, on) => {
    const seen = engine(on, { 'Add slugify': BUILD_TESTED })
    await turn($, 'Add slugify, then test it on haiku at low')
    await spawn($, { model: 'haiku', on: 'claude-haiku-5', stepEffort: null })
    expect(seen.agents).toEqual([{ model: 'claude-haiku-5', effort: undefined }])
  })
  test('while the work is still a plan, a subagent on that model is left alone', async ($, on) => {
    const seen = engine(on, { 'Plan on fable': THREE })
    await turn($, 'Plan on fable at high, build on opus at medium, test on haiku at low: add slugify')
    await spawn($, { model: 'haiku', on: 'claude-haiku-5' })
    expect(seen.agents).toEqual([{ model: 'claude-haiku-5', effort: 'high' }])
  })
})

describe('Haiku and Sonnet as stage models', () => {
  test('a plan on haiku goes at the effort named for it, and the build on sonnet at its own', async ($, on) => {
    const seen = engine(on, { 'Plan on haiku': reply({ phase: 'plan', model: 'haiku', asked: 'xhigh', buildModel: 'sonnet', build: 'low' }), 'go': GO })
    await said($, 'Plan on haiku at xhigh, build on sonnet at low')
    await said($, 'go')
    expect(seen.models).toEqual(['haiku', 'sonnet'])
    expect(seen.sent).toEqual(['xhigh', 'low'])
  })
  test('a plan on sonnet in plan mode goes at the effort named for it', async ($, on) => {
    const seen = engine(on, { 'plan this on sonnet': reply({ phase: 'plan', model: 'sonnet', asked: 'max' }) })
    await said($, 'plan this on sonnet at max', 'plan')
    expect(seen.models).toEqual(['sonnet'])
    expect(seen.sent).toEqual(['max'])
  })
  test('an approved plan built on haiku goes at the build effort named for it', async ($, on) => {
    const seen = engine(on, { 'Plan on fable': reply({ phase: 'plan', model: 'fable', asked: 'high', buildModel: 'haiku', build: 'medium' }) })
    const id = await turn($, 'Plan on fable at high, then build on haiku at medium')
    await exit($)
    await step($, id, 1)
    await complete($, id)
    await said($, 'Add a print button to the reports page.')
    expect(seen.models).toEqual(['fable', 'haiku', 'haiku'])
    expect(seen.sent).toEqual(['high', 'medium', 'medium'])
  })
  test('with no effort named, haiku and sonnet go at the person\'s own effort, never an automatic one', async ($, on) => {
    const seen = engine(on, { 'Plan on haiku': reply({ phase: 'plan', model: 'haiku', buildModel: 'sonnet' }), 'go': GO, 'quick question': ASIDE })
    await said($, 'Plan on haiku, then build on sonnet')
    await said($, 'go')
    await said($, 'quick question: which port?')
    expect(seen.models).toEqual(['haiku', 'sonnet', 'sonnet'])
    expect(seen.sent).toEqual(['high', 'high', 'high'])
  })
})

test('headless: a three-stage pipeline runs the same in a run with no one at the prompt', { options: { headless: true } }, async ($, on) => {
  const seen = engine(on, { 'Plan on fable': THREE, 'go': GO })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await said($, 'Plan on fable at high, build on opus at medium, test on haiku at low: add slugify', 'default', 'sdk')
  await said($, 'go', 'default', 'sdk')
  expect(seen.models).toEqual(['fable', SESSION])
  expect(seen.sent).toEqual(['high', 'medium'])
  expect(seen.context.at(-1)).toBe(FULL)
  const id = await turn($, 'go on', 'default', 'sdk')
  await spawn($, { model: 'haiku', on: 'claude-haiku-5' })
  await complete($, id)
  expect(seen.agents).toEqual([{ model: 'claude-haiku-5', effort: 'low' }])
})
