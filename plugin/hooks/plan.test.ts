import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import { test } from './testkit'
import type { Engine } from 'claude-code/testing'

// Claude Code takes a new effort only on a request with new input: a step whose only new input is tool results keeps
// the one in effect. A plan approved or plan mode entered mid-turn adds one user-side line after the tool's result,
// so the very next request goes at the new effort.

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PLAN = '{"phase":"plan","hard":false,"continues":false,"asked":"none","build":"none","faulted":false,"why":"design the feature"}'
const PLAN_MAX = '{"phase":"plan","hard":false,"continues":false,"asked":"max","build":"none","faulted":false,"why":"design the feature"}'
const BUILD = '{"phase":"implement","hard":false,"continues":false,"asked":"none","build":"none","faulted":false,"why":"add the button"}'
const APPROVED = 'User has approved your plan. You can now start coding.'

type Answer = { deny: string } | { isError: true } | { approved: true }

/**
 * A session on a managed model: what the classifier answers, what each request carried, the lines the plugin added, the
 * status lines shown and the turn records kept (in a file system in memory).
 */
function engine(on: On, reply: string, answer: Answer = { approved: true }) {
  const seen = { sent: [] as unknown[], added: [] as string[], status: [] as string[], files: new Map<string, string>() }
  const records = () => [...seen.files.values()].flatMap(t => t.split('\n').filter(Boolean)).map(l => JSON.parse(l) as Record<string, unknown>)
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', () => ({ value: { isAnswered: true, text: reply, usage } }))
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
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('session.append', (_$, e, next) => {
    seen.added.push(e.message.content.map(b => (b.type === 'text' ? b.text : '')).join(''))
    return next(e)
  })
  on('tool.call', () => ('deny' in answer ? answer : 'isError' in answer
    ? { isError: true, result: 'it failed', text: 'it failed' }
    : { result: { plan: 'Add the button.' }, text: APPROVED }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    seen.sent.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage } as never
  })
  return { ...seen, records }
}

const complete = ($: Engine) => $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)

async function step($: Engine, index: number) {
  for await (const _ of $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', effort: 'high', messageCount: index + 1 })) { /* drain */ }
}

/** A prompt typed in plan mode, its turn's first request. */
async function planning($: Engine) {
  await $.prompt.submit({ text: 'Plan a CSV export for the reports page.', origin: { kind: 'composer' } } as never)
  await $.classic.UserPromptSubmit({ prompt: 'Plan a CSV export for the reports page.', permission_mode: 'plan' } as never)
  await $.turn.start({ text: 'Plan a CSV export for the reports page.', turnId: 't1' })
  await step($, 0)
}

/** A build prompt typed outside plan mode, its turn's first request. */
async function building($: Engine) {
  await $.prompt.submit({ text: 'Add an export button to the reports page.', origin: { kind: 'composer' } } as never)
  await $.classic.UserPromptSubmit({ prompt: 'Add an export button to the reports page.', permission_mode: 'default' } as never)
  await $.turn.start({ text: 'Add an export button to the reports page.', turnId: 't1' })
  await step($, 0)
}

const exit = ($: Engine, agentId?: string) => $.tool.call({ tool: 'ExitPlanMode', plan: 'Add the button.', tool_use_id: 'tu1', ...(agentId ? { agentId } : {}) } as never)
const enter = ($: Engine, agentId?: string) => $.tool.call({ tool: 'EnterPlanMode', tool_use_id: 'tu2', ...(agentId ? { agentId } : {}) } as never)
const stats = async ($: Engine) => (await $.command.run({ command: 'effort-pilot', args: 'stats', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text

test('an approved plan adds one line naming the build effort, and the next request goes at it', async ($, on) => {
  const seen = engine(on, PLAN)
  await planning($)
  await exit($)
  await step($, 1)
  expect(seen.added).toEqual(['Effort Pilot: reasoning effort is now medium, for carrying out the approved plan.'])
  expect(seen.sent).toEqual(['high', 'medium'])
})

test('the request after an approved plan counts as gone at the build effort, not the planning one', async ($, on) => {
  engine(on, PLAN)
  await planning($)
  await exit($)
  await step($, 1)
  await step($, 2)
  expect(await stats($)).toContain('high: 1 requests')
  expect(await stats($)).toContain('medium: 2 requests')
})

test('a plan refused adds nothing', async ($, on) => {
  const seen = engine(on, PLAN, { deny: 'keep planning' })
  await planning($)
  await exit($)
  expect(seen.added).toEqual([])
})

test('a plan whose tool failed adds nothing', async ($, on) => {
  const seen = engine(on, PLAN, { isError: true })
  await planning($)
  await exit($)
  expect(seen.added).toEqual([])
})

test('a subagent\'s plan adds nothing to the main conversation', async ($, on) => {
  const seen = engine(on, PLAN)
  await planning($)
  await exit($, 'agent-1')
  expect(seen.added).toEqual([])
})

test('an approved plan whose build effort is the one in effect adds nothing', { options: { planEffort: 'medium' } }, async ($, on) => {
  const seen = engine(on, PLAN)
  await planning($)
  await exit($)
  await step($, 1)
  expect(seen.added).toEqual([])
  expect(seen.sent).toEqual(['medium', 'medium'])
})

test('an approved plan adds nothing while the pilot is off', async ($, on) => {
  const seen = engine(on, PLAN)
  await planning($)
  await $.command.run({ command: 'effort-pilot', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await exit($)
  expect(seen.added).toEqual([])
})

test('plan mode entered mid-turn adds one line naming the plan effort, and the next request goes at it', async ($, on) => {
  const seen = engine(on, BUILD)
  await building($)
  await enter($)
  await step($, 1)
  expect(seen.added).toEqual(['Effort Pilot: reasoning effort is now high, for planning.'])
  expect(seen.sent).toEqual(['medium', 'high'])
})

test('plan mode entered by a subagent adds nothing', async ($, on) => {
  const seen = engine(on, BUILD)
  await building($)
  await enter($, 'agent-1')
  expect(seen.added).toEqual([])
})

// An effort asked for in the prompt that plan mode was on for is the person's, not the pilot's plan effort: the band says
// so and the record is marked asked, so the report keeps it out of its comparisons.

test('a planning effort asked for in a prompt typed in plan mode shows as asked and is recorded as asked', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
  const seen = engine(on, PLAN_MAX)
  await planning($)
  await complete($)
  expect(seen.status.at(-1)).toBe('effort: max · you asked')
  expect(seen.sent).toEqual(['max'])
  expect(seen.records()).toEqual([expect.objectContaining({ phase: 'plan', chosen: 'max', sent: 'max', asked: true })])
})

test('a prompt typed in plan mode with no effort asked records the plan effort as chosen, not asked', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
  const seen = engine(on, PLAN)
  await planning($)
  await complete($)
  expect(seen.status.at(-1)).toBe('effort: high plan')
  const [r] = seen.records()
  expect(r).toEqual(expect.objectContaining({ phase: 'plan', chosen: 'high', sent: 'high' }))
  expect(r?.asked).toBe(undefined)
})

test('a turn that plans at an asked effort and has its plan approved records the effort it planned at, as asked', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
  const seen = engine(on, PLAN_MAX)
  await planning($)
  await exit($)
  await step($, 1)
  await complete($)
  expect(seen.sent).toEqual(['max', 'medium'])
  expect(seen.records()).toEqual([expect.objectContaining({ phase: 'plan', chosen: 'max', sent: 'max', asked: true })])
})

test('a turn that plans and has its plan approved records the plan effort as chosen', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
  const seen = engine(on, PLAN)
  await planning($)
  await exit($)
  await step($, 1)
  await complete($)
  const [r] = seen.records()
  expect(r).toEqual(expect.objectContaining({ phase: 'plan', chosen: 'high', sent: 'high' }))
  expect(r?.asked).toBe(undefined)
})

test('a turn in plan mode is marked as one, so the report keeps it out of its comparison', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
  const seen = engine(on, PLAN)
  await planning($)
  await complete($)
  expect(seen.records()).toEqual([expect.objectContaining({ phase: 'plan', planMode: true })])
})

test('a plan asked for outside plan mode is not marked as plan mode', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
  const seen = engine(on, PLAN)
  await $.prompt.submit({ text: 'Plan a CSV export for the reports page.', origin: { kind: 'composer' } } as never)
  await $.classic.UserPromptSubmit({ prompt: 'Plan a CSV export for the reports page.', permission_mode: 'default' } as never)
  await $.turn.start({ text: 'Plan a CSV export for the reports page.', turnId: 't1' })
  await step($, 0)
  await complete($)
  const [r] = seen.records()
  expect(r).toEqual(expect.objectContaining({ phase: 'plan', sent: 'high' }))
  expect(r?.planMode).toBe(undefined)
})

// Plan mode left by Shift+Tab is known only from the prompt's own classic UserPromptSubmit, after prompt.submit routed
// the prompt as plan mode's: that prompt is routed again, out of plan mode, before its first request.

test('the first prompt after leaving plan mode by Shift+Tab is classified like any other', async ($, on) => {
  const seen = engine(on, BUILD)
  await planning($)
  await complete($)
  expect(seen.status.at(-1)).toBe('effort: high plan')
  await building($)
  expect(seen.sent).toEqual(['high', 'medium'])
  expect(seen.status.at(-1)).toBe('effort: med implement')
})

test('a prompt that stays in plan mode is not routed again', async ($, on) => {
  const seen = engine(on, BUILD)
  await planning($)
  await complete($)
  await planning($)
  expect(seen.sent).toEqual(['high', 'high'])
  expect(seen.status.at(-1)).toBe('effort: high plan')
})
