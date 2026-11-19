import type { On } from 'claude-code'
import { describe, expect } from 'claude-code/testing'
import { test } from './testkit'
import type { Engine } from 'claude-code/testing'

// A build on the session's own model (a /model choice) of another family than the default build model (the first model
// the pilot steers): the model is never switched, and a toast and a line say so once a conversation.

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const usage = (): Usage => ({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
const reply = (phase: string, more = '') => `{"phase":"${phase}","hard":false,"continues":false,"asked":"none","build":"none","faulted":false,${more}"why":"synthetic"}`
const BUILD = reply('implement')
const FIX = reply('fix')
const CHAT = reply('chat')
const PLAN = reply('plan')
const BUILD_SONNET = reply('implement', '"model":"sonnet",')
const OPUS = 'claude-opus-5-5'
const FABLE = 'claude-fable-5-2'
const APPROVED = 'User has approved your plan. You can now start coding.'
const LINE = (name: string, level: string, usual = 'opus') => `Effort Pilot: building on the session's model (${name}) at ${level}, your /model choice, which the pilot never switches; /model ${usual} builds on ${usual}, or name a model for the build in your message.`
const TOAST = (name: string) => `Effort Pilot: building on ${name}, your /model choice`

/** A session on this model: the model and effort each request went on, the lines added, the toasts, the context given. */
function engine(on: On, name: string, reply: string | string[]) {
  const seen = { name, models: [] as string[], sent: [] as unknown[], added: [] as string[], toasts: [] as string[], context: [] as string[] }
  const replies = typeof reply === 'string' ? [reply] : [...reply]
  const answer = () => (replies.length > 1 ? replies.shift()! : replies[0]!)
  const files = new Map<string, string>()
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: name }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', () => ({ value: { isAnswered: true, text: answer(), usage: usage() } }))
  on('prompt.submit', (_$, e) => {
    seen.context.push(...(e.context ?? []))
    return { text: e.text }
  })
  on('ui.status', () => ({ value: undefined }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/someone' : undefined }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    files.set(e.path, e.text)
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
async function step($: Engine, seen: { name: string }, turnId: string, index: number) {
  for await (const _ of $.turn.step({ turnId, index, model: seen.name, effort: 'high', messageCount: ++messages })) { /* drain */ }
}
/** A message typed in a permission mode (default: none), its turn's first request, and the turn's end. */
async function say($: Engine, seen: { name: string }, text: string, permission: 'plan' | 'default' = 'default', kind = 'composer') {
  const id = `t${++n}`
  await $.prompt.submit({ text, origin: { kind } } as never)
  await $.classic.UserPromptSubmit({ prompt: text, permission_mode: permission } as never)
  await $.turn.start({ text, turnId: id })
  await step($, seen, id, 0)
  return id
}
const complete = ($: Engine, turnId: string) => $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
const run = ($: Engine, command: string, args: string) => $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const said = (seen: { toasts: string[] }) => seen.toasts.filter(t => t.includes('your /model choice'))
const lines = (seen: { added: string[] }) => seen.added.filter(t => t.includes('your /model choice'))

describe('a build on a /model choice other than the default build model', () => {
  test('the first build turn, with no plan before it, stays on the session\'s model and says so once', async ($, on) => {
    const seen = engine(on, FABLE, BUILD)
    await say($, seen, 'Add an export button to the reports page.')
    expect(seen.models).toEqual([FABLE])
    expect(seen.sent).toEqual(['medium'])
    expect(said(seen)).toEqual([TOAST(FABLE)])
    expect(seen.added).toEqual([LINE(FABLE, 'medium')])
    expect(seen.context.join('\n')).toContain(`A note from the Effort Pilot plugin; nothing to do for it now. ${LINE(FABLE, 'medium')}`)
  })

  test('a second build turn in the same conversation says nothing again', async ($, on) => {
    const seen = engine(on, FABLE, [BUILD, FIX])
    await complete($, await say($, seen, 'Add an export button to the reports page.'))
    await say($, seen, 'The button does nothing on click, fix it.')
    expect(seen.models).toEqual([FABLE, FABLE])
    expect(said(seen)).toEqual([TOAST(FABLE)])
    expect(lines(seen)).toEqual([LINE(FABLE, 'medium')])
  })

  test('a question first says nothing; the build after it does', async ($, on) => {
    const seen = engine(on, FABLE, [CHAT, FIX])
    await complete($, await say($, seen, 'What does the export button do?'))
    expect(said(seen)).toEqual([])
    await say($, seen, 'The export drops the last row, fix it.')
    expect(said(seen)).toEqual([TOAST(FABLE)])
    expect(lines(seen)).toEqual([LINE(FABLE, 'medium')])
  })

  test('an approved plan built on it, with no plan-mode model set, says so once', async ($, on) => {
    const seen = engine(on, FABLE, PLAN)
    const id = await say($, seen, 'Plan a CSV export for the reports page.', 'plan')
    await $.tool.call({ tool: 'ExitPlanMode', plan: 'Add the button.', tool_use_id: 'tu1' } as never)
    await step($, seen, id, 1)
    expect(seen.models).toEqual([FABLE, FABLE])
    expect(seen.sent).toEqual(['high', 'medium'])
    expect(said(seen)).toEqual([TOAST(FABLE)])
    expect(lines(seen)).toEqual([LINE(FABLE, 'medium')])
  })

  test('a new build task typed while a turn runs says so with the next tool result', async ($, on) => {
    const seen = engine(on, FABLE, [CHAT, BUILD])
    const id = await say($, seen, 'What does the export button do?')
    await $.prompt.submit({ text: 'Rename the save button to Store.', origin: { kind: 'composer' }, turnId: id } as never)
    await step($, seen, id, 1)
    expect(seen.models).toEqual([FABLE, FABLE])
    expect(said(seen)).toEqual([TOAST(FABLE)])
    expect(lines(seen)).toHaveLength(1)
  })

  test('with the session\'s model first among the steered models, nothing is said', { options: { managedModels: 'fable,opus' } }, async ($, on) => {
    const seen = engine(on, FABLE, BUILD)
    await say($, seen, 'Add an export button to the reports page.')
    expect(said(seen)).toEqual([])
    expect(seen.added).toEqual([])
  })

  test('the line names the default build model as /model takes it', { options: { managedModels: 'opus-5-5,fable' } }, async ($, on) => {
    const seen = engine(on, FABLE, BUILD)
    await say($, seen, 'Add an export button to the reports page.')
    expect(lines(seen)).toEqual([LINE(FABLE, 'medium', 'claude-opus-5-5')])
  })
})

describe('no word on a build', () => {
  test('in a session on the default build model', async ($, on) => {
    const seen = engine(on, OPUS, BUILD)
    await say($, seen, 'Add an export button to the reports page.')
    expect(seen.models).toEqual([OPUS])
    expect(said(seen)).toEqual([])
    expect(seen.added).toEqual([])
  })

  test('where a model asked for the build in words takes over', async ($, on) => {
    // A model named is read twice.
    const seen = engine(on, FABLE, [BUILD_SONNET, BUILD_SONNET])
    await say($, seen, 'Add an export button to the reports page, on Sonnet.')
    expect(seen.models).toEqual(['sonnet'])
    expect(said(seen)).toEqual([])
    expect(lines(seen)).toEqual([])
  })

  test('with the pilot off, in shadow mode or paused by /effort', async ($, on) => {
    const seen = engine(on, FABLE, BUILD)
    for (const how of [() => run($, 'effort-pilot', 'off'), () => run($, 'effort-pilot', 'shadow'), () => run($, 'effort', 'max')]) {
      await run($, 'effort-pilot', 'on')
      await how()
      await complete($, await say($, seen, 'Add an export button to the reports page.'))
    }
    expect(said(seen)).toEqual([])
    expect(lines(seen)).toEqual([])
  })

  test('for a notification', async ($, on) => {
    const seen = engine(on, FABLE, BUILD)
    const done = '<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>Agent "Add the export button" finished</summary> <result>The export button is in.</result> </task-notification>'
    await say($, seen, done, 'default', 'task-notification')
    expect(said(seen)).toEqual([])
    expect(lines(seen)).toEqual([])
  })

  test('in a headless session run as an agent', { options: { headless: true, sessionAgent: 'reviewer' } }, async ($, on) => {
    const seen = engine(on, FABLE, BUILD)
    on('session.start', () => ({ cwd: '/' }))
    await $.session.start({ cwd: '/', surface: null, isInteractive: false })
    await $.prompt.submit({ text: 'Add an export button to the reports page.', origin: { kind: 'sdk' } } as never)
    await $.turn.start({ text: 'brief', turnId: 'h1' })
    await step($, seen, 'h1', 0)
    await $.prompt.submit({ text: 'Now fix the failing test as well.', origin: { kind: 'sdk' } } as never)
    await $.turn.start({ text: 'more', turnId: 'h2' })
    await step($, seen, 'h2', 0)
    expect(said(seen)).toEqual([])
    expect(lines(seen)).toEqual([])
  })
})
