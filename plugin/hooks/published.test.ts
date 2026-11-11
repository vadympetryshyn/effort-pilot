import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// What the pilot publishes for other plugins to show (a toolbar, a status line): the effort the next main-loop request
// goes at (effective) and the model it goes on where not the session's own (effectiveModel). Both follow every change
// of where the requests go, and match what each request actually carries.

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const usage: Usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SESSION = 'claude-opus-5-5'
const FABLE = 'claude-fable-5-2'
const APPROVED = 'User has approved your plan. You can now start coding.'
type Fields = { phase: string; asked?: string; build?: string; model?: string; buildModel?: string; continues?: boolean }
const reply = (f: Fields) => JSON.stringify({
  phase: f.phase, hard: false, continues: f.continues ?? false, asked: f.asked ?? 'none', build: f.build ?? 'none',
  model: f.model ?? 'none', buildModel: f.buildModel ?? 'none', faulted: false, why: 'test',
})
const BUILD = reply({ phase: 'implement' })
const REPLIES: Record<string, string> = {
  'switch me to sonnet at medium': reply({ phase: 'chat', model: 'sonnet', asked: 'medium' }),
  'switch me to sonnet': reply({ phase: 'chat', model: 'sonnet' }),
  'switch to fable 5.2': reply({ phase: 'chat', model: 'fable 5.2' }),
  'back to opus': reply({ phase: 'chat', model: 'opus' }),
  'sonnet 9.9': reply({ phase: 'chat', model: 'sonnet 9.9' }),
  'plan adding hello.txt': reply({ phase: 'plan', model: 'fable', asked: 'high', buildModel: 'sonnet', build: 'medium' }),
  'Plan a CSV export': reply({ phase: 'plan' }),
}

/**
 * A session on Opus 5.5 whose plugin state is kept per conversation, as Claude Code keeps it (a /clear starts the next
 * one empty, with no session.start). Records, for each main-loop request, the model it went on and what was published
 * when it went.
 */
async function host($: Engine, on: On, opts: { refuse?: string } = {}) {
  let n = 1
  const id = () => `conversation-${n}`
  const seen = { session: SESSION, models: [] as string[], atRequest: [] as unknown[] }
  const state = new Map<string, unknown>()
  const at = (key: string) => `${id()}/effort-pilot/${key}`
  const value = (key: string) => (state.get(at(key)) as { value: unknown } | undefined)?.value ?? null
  on('state.get', (_$, e) => ({ value: { value: state.get(`${id()}/${e.plugin}/${e.key}`), version: 0 } }) as never)
  on('state.set', (_$, e) => {
    state.set(`${id()}/${e.plugin}/${e.key}`, (e as { value: unknown }).value)
    return { value: { isSet: true, version: 1 } } as never
  })
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: seen.session }))
  on('session.id', () => ({ value: id() }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', () => ({ cwd: '/' }))
  on('session.end', (_$, e) => {
    n++
    return { sessionId: e.sessionId }
  })
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', (_$, e) => {
    const message = e.prompt.slice(e.prompt.lastIndexOf('new message:'))
    const key = Object.keys(REPLIES).find(k => message.includes(k))
    return { value: { isAnswered: true, text: key === undefined ? BUILD : REPLIES[key]!, usage } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('env.get', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('classic.SessionStart', () => ({}) as never)
  on('session.append', (_$, e, next) => next(e))
  on('tool.call', () => ({ result: { plan: 'Add hello.txt.' }, text: APPROVED }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    if (e.agentId === undefined) {
      seen.models.push(e.model)
      seen.atRequest.push(value('effectiveModel'))
    }
    const none = e.agentId === undefined && e.model === opts.refuse
    return { turnId: e.turnId, index: e.index, answer: none ? '' : 'ok', toolUses: [], stopReason: none ? null : 'end_turn', usage: none ? null : usage } as never
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  return {
    seen,
    model: () => value('effectiveModel'),
    effort: () => value('effective'),
    clear: () => $.session.end({ reason: 'clear', sessionId: id(), resume: { id: id() } } as never),
  }
}

let turns = 0
let messages = 0
async function step($: Engine, turnId: string, index: number, model = SESSION) {
  for await (const _ of $.turn.step({ turnId, index, model, effort: 'high', messageCount: ++messages })) { /* drain */ }
}
/** A prompt typed in a permission mode and its turn's first request; the turn left open. */
async function turn($: Engine, text: string, permission: 'plan' | 'default' = 'default') {
  const id = `t${++turns}`
  await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  await $.classic.UserPromptSubmit({ prompt: text, permission_mode: permission } as never)
  await $.turn.start({ text, turnId: id })
  await step($, id, 0)
  return id
}
const complete = ($: Engine, turnId: string, reason = 'answer') => $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason } as never)
async function said($: Engine, text: string, permission: 'plan' | 'default' = 'default') {
  await complete($, await turn($, text, permission))
}
const run = ($: Engine, command: string, args = '') => $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const exit = ($: Engine) => $.tool.call({ tool: 'ExitPlanMode', plan: 'Add hello.txt.', tool_use_id: 'tu1' } as never)

describe('the model the requests go on', () => {
  test('is none while they go on the session\'s own model', async ($, on) => {
    const h = await host($, on)
    await said($, 'Add an export button to the reports page.')
    expect(h.model()).toBe(null)
    expect(h.effort()).toEqual({ effort: 'medium', source: 'auto' })
  })

  test('is the model asked for in words, from the request it was asked in, and the effort the one named with it', async ($, on) => {
    const h = await host($, on)
    await said($, 'switch me to sonnet at medium')
    expect(h.seen.models).toEqual(['sonnet'])
    expect(h.seen.atRequest).toEqual([{ model: 'sonnet', source: 'asked' }])
    expect(h.model()).toEqual({ model: 'sonnet', source: 'asked' })
    expect(h.effort()).toEqual({ effort: 'medium', source: 'auto' })
  })

  test('on a model the pilot does not manage, with no effort named, no effort is published: the person\'s own goes', async ($, on) => {
    const h = await host($, on)
    await said($, 'switch me to sonnet')
    expect(h.model()).toEqual({ model: 'sonnet', source: 'asked' })
    expect(h.effort()).toBe(null)
  })

  test('on a model the pilot manages, the effort is routed and published turn by turn', async ($, on) => {
    const h = await host($, on)
    await said($, 'switch to fable 5.2')
    expect(h.model()).toEqual({ model: FABLE, source: 'asked' })
    expect(h.effort()).toEqual({ effort: 'low', source: 'auto' })
    await said($, 'Add an export button to the reports page.')
    expect(h.effort()).toEqual({ effort: 'medium', source: 'auto' })
  })

  test('goes back to none when the person asks for the session\'s model', async ($, on) => {
    const h = await host($, on)
    await said($, 'switch me to sonnet at medium')
    await said($, 'back to opus')
    expect(h.model()).toBe(null)
    expect(h.effort()).toEqual({ effort: 'low', source: 'auto' })
  })

  test('goes back to none on /effort-pilot off and shadow, and returns on /effort-pilot on', async ($, on) => {
    const h = await host($, on)
    await said($, 'switch me to sonnet at medium')
    await run($, 'effort-pilot', 'shadow')
    expect(h.model()).toBe(null)
    expect(h.effort()).toBe(null)
    await run($, 'effort-pilot', 'on')
    expect(h.model()).toEqual({ model: 'sonnet', source: 'asked' })
    await run($, 'effort-pilot', 'off')
    expect(h.model()).toBe(null)
    await run($, 'effort-pilot', 'on')
    expect(h.model()).toBe(null)
  })

  test('goes back to none when the person picks a model with /model', async ($, on) => {
    const h = await host($, on)
    await said($, 'switch me to sonnet at medium')
    h.seen.session = FABLE
    await run($, 'model', FABLE)
    expect(h.model()).toBe(null)
  })

  test('goes back to none when the person names the session\'s own model with /model', async ($, on) => {
    const h = await host($, on)
    await said($, 'switch me to sonnet at medium')
    await run($, 'model', 'opus')
    expect(h.model()).toBe(null)
    await said($, 'Add an export button to the reports page.')
    expect(h.seen.models.at(-1)).toBe(SESSION)
  })

  test('goes back to none when the API refuses the asked model', async ($, on) => {
    const h = await host($, on, { refuse: 'claude-sonnet-9-9' })
    const id = await turn($, 'switch to sonnet 9.9')
    expect(h.model()).toEqual({ model: 'claude-sonnet-9-9', source: 'asked' })
    await complete($, id, 'error')
    expect(h.model()).toBe(null)
  })

  test('is published from the new conversation\'s start after a /clear, before any prompt', async ($, on) => {
    const h = await host($, on)
    await said($, 'switch me to sonnet at medium')
    await h.clear()
    await $.classic.SessionStart({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'conversation-2' } as never)
    expect(h.model()).toEqual({ model: 'sonnet', source: 'asked' })
    expect(h.effort()).toEqual({ effort: 'medium', source: 'auto' })
  })

  test('is carried over a /clear with the ask', async ($, on) => {
    const h = await host($, on)
    await said($, 'switch me to sonnet at medium')
    await h.clear()
    expect(h.model()).toBe(null)
    await said($, 'Add an export button to the reports page.')
    expect(h.seen.models.at(-1)).toBe('sonnet')
    expect(h.model()).toEqual({ model: 'sonnet', source: 'asked' })
    expect(h.effort()).toEqual({ effort: 'medium', source: 'auto' })
  })

  test('is the plan model while planning, and the build model once the plan is approved', async ($, on) => {
    const h = await host($, on)
    const id = await turn($, 'plan adding hello.txt on fable at high, then implement on sonnet at medium')
    expect(h.seen.atRequest).toEqual([{ model: 'fable', source: 'plan' }])
    await exit($)
    expect(h.model()).toEqual({ model: 'sonnet', source: 'asked' })
    expect(h.effort()).toEqual({ effort: 'medium', source: 'auto' })
    await step($, id, 1)
    expect(h.seen.atRequest.at(-1)).toEqual({ model: 'sonnet', source: 'asked' })
  })
})

describe('the plan-mode model setting', () => {
  test('is published while plan mode lasts, and none once it is left', { options: { planModeModel: FABLE } }, async ($, on) => {
    const h = await host($, on)
    await said($, 'Plan a CSV export for the reports page.', 'plan')
    expect(h.seen.atRequest).toEqual([{ model: FABLE, source: 'setting' }])
    expect(h.model()).toEqual({ model: FABLE, source: 'setting' })
    await said($, 'Add an export button to the reports page.')
    expect(h.seen.atRequest.at(-1)).toBe(null)
    expect(h.model()).toBe(null)
  })

  test('is published as soon as the engine reports plan mode entered or left, before the turn\'s first request', { options: { planModeModel: FABLE } }, async ($, on) => {
    const h = await host($, on)
    // The engine reports a Shift+Tab into or out of plan mode first with the next prompt's classic hook.
    await $.prompt.submit({ text: 'Plan a CSV export for the reports page.', origin: { kind: 'composer' } } as never)
    await $.classic.UserPromptSubmit({ prompt: 'Plan a CSV export for the reports page.', permission_mode: 'plan' } as never)
    expect(h.model()).toEqual({ model: FABLE, source: 'setting' })
    expect(h.seen.models).toEqual([])
    await $.prompt.submit({ text: 'Add an export button to the reports page.', origin: { kind: 'composer' } } as never)
    await $.classic.UserPromptSubmit({ prompt: 'Add an export button to the reports page.', permission_mode: 'default' } as never)
    expect(h.model()).toBe(null)
  })

  test('gives way to a model asked earlier once an approved plan leaves plan mode', { options: { planModeModel: FABLE } }, async ($, on) => {
    const h = await host($, on)
    await said($, 'switch me to sonnet at medium')
    const id = await turn($, 'Plan a CSV export for the reports page.', 'plan')
    expect(h.model()).toEqual({ model: FABLE, source: 'setting' })
    await exit($)
    expect(h.model()).toEqual({ model: 'sonnet', source: 'asked' })
    await step($, id, 1)
    expect(h.seen.models).toEqual(['sonnet', FABLE, 'sonnet'])
  })

  test('is none for a request of a turn the pilot does not route, which goes on the session\'s model', { options: { planModeModel: FABLE } }, async ($, on) => {
    const h = await host($, on)
    await said($, 'Plan a CSV export for the reports page.', 'plan')
    // A typed command the engine never expands for the model: its turn is no one's the pilot read.
    await $.prompt.submit({ text: '/compact', command: { name: 'compact', args: '' }, origin: { kind: 'composer' } } as never)
    await $.turn.start({ text: '/compact', turnId: 'c1' })
    await step($, 'c1', 0)
    expect(h.seen.models.at(-1)).toBe(SESSION)
    expect(h.seen.atRequest.at(-1)).toBe(null)
    expect(h.effort()).toBe(null)
  })
})
