import type { On } from 'claude-code'
import { describe, expect } from 'claude-code/testing'
import { test } from './testkit'
import type { Engine } from 'claude-code/testing'

// An effort the person sets by hand (/effort typed, or a picker plugin that runs it) means what naming it in words
// means: the work under way takes it now, the next message holds it, its follow-ups keep it, and a new task goes back to
// the pilot's pick. Setting the model or the effort by hand never turns the pilot off.

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const usage: Usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SESSION = 'claude-opus-5-5'
const FABLE = 'claude-fable-5-2'
type Fields = { phase: string; asked?: string; model?: string; continues?: boolean }
const reply = (f: Fields) => JSON.stringify({
  phase: f.phase, hard: false, continues: f.continues ?? false, asked: f.asked ?? 'none', build: 'none',
  model: f.model ?? 'none', buildModel: 'none', faulted: false, why: 'test',
})
const REPLIES: Record<string, string> = {
  'Add an export button': reply({ phase: 'implement' }),
  'Also cover it with a test': reply({ phase: 'implement', continues: true }),
  'Fix the typo in the README title': reply({ phase: 'trivial' }),
  'Plan a CSV export': reply({ phase: 'plan' }),
  'do it on medium': reply({ phase: 'implement', asked: 'medium' }),
  'switch me to sonnet': reply({ phase: 'chat', model: 'sonnet' }),
}

/** A session on Opus 5.5 whose plugin state is kept, as Claude Code keeps it: what each request went at and on, and what was shown. */
async function host($: Engine, on: On) {
  const seen = { session: SESSION, models: [] as string[], sent: [] as unknown[], status: [] as string[], toasts: [] as string[], calls: 0 }
  const state = new Map<string, unknown>()
  const value = (key: string) => (state.get(`effort-pilot/${key}`) as { value: unknown } | undefined)?.value ?? null
  on('state.get', (_$, e) => ({ value: { value: state.get(`${e.plugin}/${e.key}`), version: 0 } }) as never)
  on('state.set', (_$, e) => {
    state.set(`${e.plugin}/${e.key}`, (e as { value: unknown }).value)
    return { value: { isSet: true, version: 1 } } as never
  })
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: seen.session }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('session.start', () => ({ cwd: '/' }))
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', (_$, e) => {
    seen.calls++
    const message = e.prompt.slice(e.prompt.lastIndexOf('new message:'))
    const key = Object.keys(REPLIES).find(k => message.includes(k))
    return { value: { isAnswered: true, text: key === undefined ? REPLIES['Add an export button']! : REPLIES[key]!, usage } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('env.get', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: 'done' }))
  on('ui.status', (_$, e) => {
    seen.status.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('session.append', (_$, e, next) => next(e))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    if (e.agentId === undefined) {
      seen.models.push(e.model)
      seen.sent.push(e.effort)
    }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  return { seen, effort: () => value('effective') }
}

let n = 0
let messages = 0
async function step($: Engine, turnId: string, index: number) {
  for await (const _ of $.turn.step({ turnId, index, model: SESSION, effort: 'high', messageCount: ++messages })) { /* drain */ }
}
/** A prompt typed in a permission mode and its turn's first request; the turn left open. */
async function turn($: Engine, text: string, permission: 'plan' | 'default' = 'default') {
  const id = `t${++n}`
  await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  await $.classic.UserPromptSubmit({ prompt: text, permission_mode: permission } as never)
  await $.turn.start({ text, turnId: id })
  await step($, id, 0)
  return id
}
const complete = ($: Engine, turnId: string) => $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
async function said($: Engine, text: string, permission: 'plan' | 'default' = 'default') {
  const id = await turn($, text, permission)
  await complete($, id)
  return id
}
const presentation = { isFullscreen: false, columns: 80 }
/** A picker plugin's pill: it runs the command, as the person's own typing would. */
const picked = ($: Engine, command: string, args: string) => $.command.run({ command, args, origin: { kind: 'plugin', name: 'picker' }, presentation } as never)
const typed = ($: Engine, command: string, args: string) => $.command.run({ command, args, origin: { kind: 'composer' }, presentation })
const pilot = async ($: Engine) => (await typed($, 'effort-pilot', '')).text

describe('an effort set by hand', () => {
  test('from a picker mid-work takes the work now: the next request goes at it, shown, and the pilot stays on', async ($, on) => {
    const { seen, effort } = await host($, on)
    const id = await turn($, 'Add an export button to the reports page.')
    await picked($, 'effort', 'high')
    await step($, id, 1)
    expect(seen.sent).toEqual(['medium', 'high'])
    expect(effort()).toEqual({ effort: 'high', source: 'auto' })
    expect(seen.status.at(-1)).toBe('effort: high · you asked')
    expect(seen.toasts).toContain('Effort Pilot: high for this work, as you set it; a new task goes back to the pilot\'s pick')
    expect(seen.toasts.join(' ')).not.toContain('paused')
    expect(await pilot($)).toBe('Effort Pilot: auto')
  })

  test('holds for the next message and its follow-ups; a new task goes back to the pilot\'s pick', async ($, on) => {
    const { seen } = await host($, on)
    await said($, 'Add an export button to the reports page.')
    await picked($, 'effort', 'high')
    await said($, 'Also cover it with a test.')
    await said($, 'Also cover it with a test for the empty table.')
    await said($, 'Fix the typo in the README title.')
    expect(seen.sent).toEqual(['medium', 'high', 'high', 'low'])
  })

  test('before the first prompt goes on that prompt\'s work', async ($, on) => {
    const { seen, effort } = await host($, on)
    await picked($, 'effort', 'max')
    expect(effort()).toBe(null)
    await said($, 'Plan a CSV export for the reports page.')
    expect(seen.sent).toEqual(['max'])
    expect(effort()).toEqual({ effort: 'max', source: 'auto' })
    expect(seen.status.at(-1)).toBe('effort: max · you asked')
  })

  test('gives way to an effort the next message names itself', async ($, on) => {
    const { seen } = await host($, on)
    await typed($, 'effort', 'low')
    await said($, 'Rename the export column, do it on medium.')
    expect(seen.sent).toEqual(['medium'])
  })

  test('in plan mode is the planning\'s effort', async ($, on) => {
    const { seen } = await host($, on)
    const id = await turn($, 'Plan a CSV export for the reports page.', 'plan')
    await typed($, 'effort', 'xhigh')
    await step($, id, 1)
    expect(seen.sent).toEqual(['high', 'xhigh'])
  })

  test('is never a control turn', { options: { measure: true, controlShare: 100 } }, async ($, on) => {
    const { seen } = await host($, on)
    await said($, 'Add an export button to the reports page.')
    await picked($, 'effort', 'low')
    await said($, 'Add a print button to the reports page.')
    // The first turn is a control turn at the person's own effort; the one set by hand goes as set.
    expect(seen.sent).toEqual(['high', 'low'])
  })

  test('/effort auto drops it now and for the next message', async ($, on) => {
    const { seen } = await host($, on)
    await said($, 'Add an export button to the reports page.')
    await picked($, 'effort', 'max')
    await picked($, 'effort', 'auto')
    await said($, 'Add a print button to the reports page.')
    expect(seen.sent).toEqual(['medium', 'medium'])
  })

  test('with the pilot off sets nothing, and the pilot turned on again picks', async ($, on) => {
    const { seen } = await host($, on)
    await typed($, 'effort-pilot', 'off')
    await picked($, 'effort', 'max')
    await typed($, 'effort-pilot', 'on')
    await said($, 'Add an export button to the reports page.')
    expect(seen.sent).toEqual(['medium'])
  })
})

describe('a model set by hand', () => {
  test('from a picker keeps the pilot on: after /model opus then /model fable it still sets the effort', async ($, on) => {
    const { seen, effort } = await host($, on)
    await said($, 'Add an export button to the reports page.')
    await picked($, 'model', 'opus')
    seen.session = FABLE
    await picked($, 'model', 'fable')
    const calls = seen.calls
    const id = `t${++n}`
    await $.prompt.submit({ text: 'Fix the typo in the README title.', origin: { kind: 'composer' } } as never)
    await $.turn.start({ text: 'Fix the typo in the README title.', turnId: id })
    for await (const _ of $.turn.step({ turnId: id, index: 0, model: FABLE, effort: 'high', messageCount: ++messages })) { /* drain */ }
    expect(seen.calls).toBe(calls + 1)
    expect(seen.models).toEqual([SESSION, FABLE])
    expect(seen.sent).toEqual(['medium', 'low'])
    expect(effort()).toEqual({ effort: 'low', source: 'auto' })
    expect(await pilot($)).toBe('Effort Pilot: auto')
  })

  test('from a picker ends a model asked for in words, and the pilot goes on setting the effort', async ($, on) => {
    const { seen } = await host($, on)
    await said($, 'switch me to sonnet')
    await picked($, 'model', 'opus')
    await said($, 'Fix the typo in the README title.')
    expect(seen.models).toEqual(['sonnet', SESSION])
    expect(seen.sent.at(-1)).toBe('low')
    expect(await pilot($)).toBe('Effort Pilot: auto')
  })
})
