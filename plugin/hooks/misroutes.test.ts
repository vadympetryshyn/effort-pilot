import type { On } from 'claude-code'
import { describe, expect } from 'claude-code/testing'
import { test } from './testkit'
import type { Engine } from 'claude-code/testing'

import type { Route, Task } from '../types'
import { forSkill, skillPrompt } from './route'

// Two turns that ran at the wrong effort. A defect reported only as questions ("what is this? did you even test it?")
// on a first turn reads as chat. A plan and its build in one message ("plan it all, then implement"): no new message
// comes when the agent moves on from planning to carrying the plan out, so a skill the main loop loads during a plan is
// read.

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const usage = (): Usage => ({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
const reply = (phase: string, continues: boolean, why: string) => `{"phase":"${phase}","hard":false,"continues":${continues},"asked":"none","build":"none","faulted":false,"why":"${why}"}`
const PLAN = reply('plan', false, 'plan the export, then build it')
const BUILD = reply('implement', false, 'add the export button')
const CARRY = reply('implement', true, 'the skill carries out the plan')
const REVIEW = reply('plan', true, 'the skill reviews the plan')
const RESEARCH = reply('analyze', true, 'the skill researches a library')
/** A classifier call that fails (a timeout, an outage). */
const FAIL = 'FAIL'
const SESSION = 'claude-opus-5-5'
const FABLE = 'claude-fable-5-2'
const ON = { planModeModel: FABLE, planModelForPlans: true }
const PLANNING = `Effort Pilot: planning on ${FABLE} at high (the plan-mode model, set for plans too); back on the session's model (${SESSION}) when building starts.`
const BACK = `Effort Pilot: back on the session's model (${SESSION}) at medium for the build.`

function engine(on: On, reply: string[]) {
  const seen = { models: [] as string[], sent: [] as unknown[], added: [] as string[], status: [] as string[], toasts: [] as string[], prompts: [] as string[] }
  const replies = [...reply]
  const answer = () => (replies.length > 1 ? replies.shift()! : replies[0]!)
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: SESSION }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', (_$, e) => {
    seen.prompts.push(e.prompt)
    const text = answer()
    if (text === FAIL) throw new Error('timed out')
    return { value: { isAnswered: true, text, usage: usage() } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.status', (_$, e) => {
    seen.status.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))
  on('command.run', () => ({ text: '' }))
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('session.append', (_$, e, next) => {
    seen.added.push(e.message.content.map(b => (b.type === 'text' ? b.text : '')).join(''))
    return next(e)
  })
  on('tool.call', () => ({ result: {}, text: 'Launching skill' }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    if (e.agentId === undefined) {
      seen.models.push(e.model)
      seen.sent.push(e.effort)
    }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage: usage() } as never
  })
  return seen
}

let n = 0
let messages = 0
async function step($: Engine, turnId: string, index: number) {
  for await (const _ of $.turn.step({ turnId, index, model: SESSION, effort: 'high', messageCount: ++messages })) { /* drain */ }
}
async function turn($: Engine, text: string, permission: 'plan' | 'default' = 'default') {
  const id = `t${++n}`
  await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  await $.classic.UserPromptSubmit({ prompt: text, permission_mode: permission } as never)
  await $.turn.start({ text, turnId: id })
  await step($, id, 0)
  return id
}
const skill = ($: Engine, name: string, args = '', agentId?: string) =>
  $.tool.call({ tool: 'Skill', skill: name, args, tool_use_id: `s${++n}`, ...(agentId ? { agentId } : {}) } as never)
const PLAN_IT = 'Plan the CSV export for the reports page, then implement it.'

describe('a skill the agent loads during a plan', () => {
  test('one that carries the plan out goes back on the session\'s model at the build effort from the next request, and says so', { options: ON }, async ($, on) => {
    const seen = engine(on, [PLAN, CARRY])
    const id = await turn($, PLAN_IT)
    await skill($, 'tools:implement-plan', 'docs/plans/csv-export.md')
    await step($, id, 1)
    expect(seen.models).toEqual([FABLE, SESSION])
    expect(seen.sent).toEqual(['high', 'medium'])
    expect(seen.added).toEqual([PLANNING, BACK])
    expect(seen.toasts.at(-1)).toBe(`Effort Pilot: back on ${SESSION} at medium for the build`)
    expect(seen.status.at(-1)).toBe('effort: med implement')
    // The classifier read the skill's name and arguments, with the person's message that began the plan.
    expect(seen.prompts).toHaveLength(2)
    expect(seen.prompts[1]).toContain('The skill the agent loads: tools:implement-plan')
    expect(seen.prompts[1]).toContain('docs/plans/csv-export.md')
    expect(seen.prompts[1]).toContain(PLAN_IT)
  })

  test('with the plan model off, the effort alone goes to the build\'s', async ($, on) => {
    const seen = engine(on, [PLAN, CARRY])
    const id = await turn($, PLAN_IT)
    await skill($, 'executing-plans')
    await step($, id, 1)
    expect(seen.models).toEqual([SESSION, SESSION])
    expect(seen.sent).toEqual(['high', 'medium'])
    expect(seen.added).toEqual(['Effort Pilot: reasoning effort is now medium, for carrying out the plan.'])
    expect(seen.toasts.at(-1)).toBe('effort: high → med implement')
  })

  test('a build effort the person named for the plan is the one the build goes at', async ($, on) => {
    const named = '{"phase":"plan","hard":false,"continues":false,"asked":"none","build":"high","faulted":false,"why":"plan, then build on high"}'
    // A level named is read twice.
    const seen = engine(on, [named, named, CARRY])
    const id = await turn($, 'Plan the CSV export, then implement it on high.')
    await skill($, 'implement-plan')
    await step($, id, 1)
    expect(seen.sent).toEqual(['high', 'high'])
    expect(seen.status.at(-1)).toBe('effort: high · you asked')
  })

  for (const [what, read] of [['writes or reviews the plan', REVIEW], ['researches something the plan needs', RESEARCH]] as const) {
    test(`one that ${what} changes nothing`, { options: ON }, async ($, on) => {
      const seen = engine(on, [PLAN, read])
      const id = await turn($, PLAN_IT)
      await skill($, 'review-plan')
      await step($, id, 1)
      expect(seen.models).toEqual([FABLE, FABLE])
      expect(seen.sent).toEqual(['high', 'high'])
      expect(seen.added).toEqual([PLANNING])
      expect(seen.prompts).toHaveLength(2)
    })
  }

  test('a read that fails changes nothing', { options: ON }, async ($, on) => {
    const seen = engine(on, [PLAN, FAIL])
    const id = await turn($, PLAN_IT)
    await skill($, 'implement-plan')
    await step($, id, 1)
    expect(seen.models).toEqual([FABLE, FABLE])
    expect(seen.sent).toEqual(['high', 'high'])
    expect(seen.added).toEqual([PLANNING])
  })

  test('with a build under way, no plan, the skill is not read', { options: ON }, async ($, on) => {
    const seen = engine(on, [BUILD])
    const id = await turn($, 'Add an export button to the reports page.')
    await skill($, 'test-driven-development')
    await step($, id, 1)
    expect(seen.prompts).toHaveLength(1)
    expect(seen.sent).toEqual(['medium', 'medium'])
  })

  test('in plan mode the skill is not read: leaving plan mode sets the build', { options: ON }, async ($, on) => {
    const seen = engine(on, [PLAN])
    const id = await turn($, 'Plan the CSV export for the reports page.', 'plan')
    const before = seen.prompts.length
    await skill($, 'implement-plan')
    await step($, id, 1)
    expect(seen.prompts).toHaveLength(before)
    expect(seen.sent).toEqual(['high', 'high'])
  })

  test('a subagent\'s skill is not read', { options: ON }, async ($, on) => {
    const seen = engine(on, [PLAN, CARRY])
    const id = await turn($, PLAN_IT)
    await skill($, 'implement-plan', '', 'a1')
    await step($, id, 1)
    expect(seen.prompts).toHaveLength(1)
    expect(seen.models).toEqual([FABLE, FABLE])
  })

  test('with the effort set by hand, the skill is not read', { options: ON }, async ($, on) => {
    const seen = engine(on, [PLAN, CARRY])
    await $.command.run({ command: 'effort', args: 'max', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    const id = await turn($, PLAN_IT)
    await skill($, 'implement-plan')
    await step($, id, 1)
    expect(seen.prompts).toHaveLength(0)
  })
})

describe('a message that says the work fell short, read as chat', () => {
  const FAULTED = '{"phase":"chat","hard":false,"continues":false,"asked":"none","build":"none","faulted":true,"why":"asks why it posts five times"}'
  const ASIDE = reply('chat', false, 'a side question')
  test('on a first turn goes as a fix at the hard-build effort', async ($, on) => {
    const seen = engine(on, [FAULTED])
    await turn($, 'What is this? It posts the same text five times. Did you even test it?')
    expect(seen.sent).toEqual(['high'])
    expect(seen.status.at(-1)).toBe('effort: high fix')
  })
  test('after a side question goes as a fix too; a question that does not say so stays at the talk effort, and one during that fix keeps it', async ($, on) => {
    const seen = engine(on, [ASIDE, ASIDE, FAULTED, ASIDE])
    for (const text of ['What time zone are the logs in?', 'And which file holds the rules?', 'Why did it pick the wrong country again? Don\'t you read the rules?', 'Which file holds the rules?']) {
      await $.turn.complete({ turnId: await turn($, text), answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
    }
    expect(seen.sent).toEqual(['low', 'low', 'high', 'high'])
  })
})

describe('forSkill', () => {
  const plan: Task = { phase: 'plan', hard: false, effort: 'high', text: 'plan it, then build it' }
  const pick = (phase: Route['phase']): Route => ({ phase, hard: phase === 'fix', effort: 'high', continues: true, why: 'the skill' })
  test('carrying the plan out, or fixing in it, is the build at the build effort, never the hard one', () => {
    for (const phase of ['implement', 'fix'] as const) {
      const r = forSkill(plan, pick(phase))!
      expect(r.route).toEqual(expect.objectContaining({ phase: 'implement', hard: false, effort: 'medium' }))
      expect(r.task).toEqual(expect.objectContaining({ phase: 'implement', effort: 'medium' }))
    }
  })
  test('a build model and a test stage the plan holds go with the build', () => {
    const r = forSkill({ ...plan, build: 'high', buildModel: 'sonnet', testModel: 'haiku', test: 'low' }, pick('implement'))!
    expect(r.route).toEqual(expect.objectContaining({ effort: 'high', model: 'sonnet', asked: 'high' }))
    expect(r.task).toEqual(expect.objectContaining({ testModel: 'haiku', test: 'low' }))
  })
  test('any other read, none, or no plan under way changes nothing', () => {
    for (const phase of ['plan', 'analyze', 'chat', 'trivial'] as const) expect(forSkill(plan, pick(phase))).toBeNull()
    expect(forSkill(plan, null)).toBeNull()
    expect(forSkill(null, pick('implement'))).toBeNull()
    expect(forSkill({ ...plan, phase: 'analyze' }, pick('implement'))).toBeNull()
  })
  test('the prompt names the skill, its arguments and the plan\'s message', () => {
    const p = skillPrompt('execute-plan', 'step 2', plan)
    expect(p).toContain('The skill the agent loads: execute-plan')
    expect(p).toContain('step 2')
    expect(p).toContain('plan it, then build it')
    expect(skillPrompt('brainstorming', '', plan)).toContain('brainstorming (no arguments)')
  })
})
