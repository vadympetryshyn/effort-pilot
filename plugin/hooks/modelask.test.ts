import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { afterPlan, agreed, briefPrompt, carry, fromBrief, isModel, MODEL_LINE, modelId, parse, prompt, SYSTEM } from './route'

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
function engine(on: On, replies: Record<string, string | string[]> = {}, opts: { refuse?: string } = {}) {
  const seen = {
    session: SESSION, models: [] as string[], sent: [] as unknown[], agents: [] as string[], notices: [] as string[],
    added: [] as string[], context: [] as string[], status: [] as string[], files: new Map<string, string>(),
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
  on('prompt.submit', (_$, e) => {
    seen.context.push(...(e.context ?? []))
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
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Box', children: [] }) as never)
  on('command.run', () => ({ text: '' }))
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
  return Object.assign(seen, { records })
}

let n = 0
let messages = 0
async function step($: Engine, turnId: string, index: number) {
  for await (const _ of $.turn.step({ turnId, index, model: SESSION, effort: 'high', messageCount: ++messages })) { /* drain */ }
}
/** A prompt typed in a permission mode, its turn's first request; the turn left open (end it with complete). */
async function turn($: Engine, text: string, permission: 'plan' | 'default' = 'default') {
  const id = `t${++n}`
  await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  await $.classic.UserPromptSubmit({ prompt: text, permission_mode: permission } as never)
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
const SWITCHED = 'Effort Pilot: now on sonnet at medium, for this session; say "back to opus" or use /model to change.'

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
  test('a reply with a dangling comma before its closing brace still parses', () => {
    expect(parse('{"phase":"analyze","hard":false,"why":"a verdict","}')?.phase).toBe('analyze')
  })
  test('parse keeps the model and the build model', () => {
    const r = parse(reply({ phase: 'plan', model: 'fable 5.1', buildModel: 'sonnet', build: 'high' }))
    expect(r).toEqual(expect.objectContaining({ phase: 'plan', model: 'claude-fable-5-1', buildModel: 'sonnet', build: 'high' }))
  })
  test('two reads keep a model either names, drop two different ones; no second read leaves the first', () => {
    const a = parse(reply({ phase: 'chat', model: 'sonnet', asked: 'medium' }))!
    expect(agreed(a, parse(reply({ phase: 'chat', model: 'sonnet', asked: 'medium' })))?.model).toBe('sonnet')
    expect(agreed(a, parse(reply({ phase: 'chat', asked: 'medium' })))?.model).toBe('sonnet')
    expect(agreed(a, parse(reply({ phase: 'chat', model: 'haiku', asked: 'medium' })))?.model).toBe(undefined)
    expect(agreed(a, null).model).toBe('sonnet')
    const p = parse(reply({ phase: 'plan', buildModel: 'sonnet' }))!
    expect(agreed(p, parse(reply({ phase: 'plan' })))?.buildModel).toBe('sonnet')
    expect(agreed(p, parse(reply({ phase: 'plan', model: 'fable', buildModel: 'sonnet' }))))
      .toEqual(expect.objectContaining({ model: 'fable', buildModel: 'sonnet' }))
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
  expect(seen.context).toEqual([`The Effort Pilot plugin switches the model as the person asked; nothing to do for it. ${SWITCHED}`])
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

test('a model one of the two reads misses is still taken; two different models are not', async ($, on) => {
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

test('a model asked with no effort is read twice, and a plan model one read misses is kept', async ($, on) => {
  const seen = engine(on, {
    'plan adding hello.txt': [reply({ phase: 'plan', buildModel: 'sonnet' }), reply({ phase: 'plan', model: 'fable', buildModel: 'sonnet' })],
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
