import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { slotFile } from './store'

// A slash command the person types. A skill or prompt command is expanded for the model once its prompt.submit has
// run (skill.prompt, beneath it) and starts a turn of model work: it is routed like a typed prompt. A built-in that
// runs on its own (/clear, /model) raises no prompt.submit and is never expanded: it is left alone.

const NOW = 1_800_000_000_000
const HOME = '/home/someone'
const STORE = `${HOME}/.claude/plugins/data/effort-pilot-inline/turns`
const plan = '{"phase":"plan","hard":false,"continues":false,"asked":"none","build":"none","faulted":false,"why":"design the feature"}'
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/**
 * An interactive session on a managed model, as the engine runs a submission: a prompt.submit that carries a command
 * expands it beneath (skill.prompt) when `expands` says the command is a skill or prompt command.
 */
async function session($: Engine, on: On, expands: (name: string) => boolean) {
  const seen = { calls: 0, prompts: [] as string[], status: [] as string[], sent: [] as unknown[], files: new Map<string, string>() }
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: NOW }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', (_$, e) => ({ value: seen.files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: seen.files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    seen.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('model.complete', (_$, e) => {
    seen.calls++
    seen.prompts.push(e.prompt)
    return { value: { isAnswered: true, text: plan, usage } }
  })
  on('prompt.submit', async (_$, e) => {
    if (e.command && expands(e.command.name)) await $.skill.prompt({ skill: e.command.name, text: 'The command\'s own instructions.' })
    return { text: e.text }
  })
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('command.run', () => ({ text: '' }))
  on('ui.status', (_$, e) => {
    seen.status.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    seen.sent.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage } as never
  })
  on('turn.complete', () => ({ text: 'done' }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  return seen
}

/** Types a slash command line, as the engine hands it to prompt.submit. */
async function typeCommand($: Engine, name: string, args: string) {
  const text = args ? `/${name} ${args}` : `/${name}`
  await $.prompt.submit({ text, command: { name, args }, origin: { kind: 'composer' } } as never)
}

/** The turn that follows a submission: one request at the session's own effort (high), then the end. */
async function turn($: Engine, turnId: string, text: string) {
  await $.turn.start({ text, turnId })
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) { /* drain */ }
  await $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
}

describe('a skill or prompt command the person types', () => {
  test('is classified from its line as typed and routed', async ($, on) => {
    const seen = await session($, on, () => true)
    await typeCommand($, 'tools:create-plan', 'design an export of the reports page to CSV, then build it')
    expect(seen.calls).toBe(1)
    expect(seen.prompts[0]).toContain('/tools:create-plan design an export of the reports page to CSV, then build it')
    expect(seen.status).toEqual(['effort: xhigh plan'])
    await turn($, 't1', '/tools:create-plan')
    expect(seen.sent).toEqual(['xhigh'])
  })

  test('with no arguments is classified from the command line alone', async ($, on) => {
    const seen = await session($, on, () => true)
    await typeCommand($, 'review-notes', '')
    expect(seen.calls).toBe(1)
    expect(seen.prompts[0]).toContain('/review-notes')
  })

  test('is recorded as the person\'s turn, after a notification\'s', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, () => true)
    await $.prompt.submit({ text: 'A background task finished.', origin: { kind: 'task-notification' } } as never)
    await turn($, 't1', 'A background task finished.')
    await typeCommand($, 'tools:create-plan', 'design an export of the reports page')
    await turn($, 't2', '/tools:create-plan')
    const records = (seen.files.get(`${STORE}/${slotFile(NOW)}`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(records.map(r => r.who)).toEqual(['notification', 'person'])
  })
})

describe('a command that is not expanded for the model', () => {
  test('a submission whose command is never expanded is not classified', async ($, on) => {
    const seen = await session($, on, () => false)
    await typeCommand($, 'compact', '')
    expect(seen.calls).toBe(0)
    expect(seen.status).toEqual([])
  })

  test('a built-in run on its own is not classified', async ($, on) => {
    const seen = await session($, on, () => true)
    await $.command.run({ command: 'clear', args: '' } as never)
    await $.command.run({ command: 'model', args: 'opus' } as never)
    expect(seen.calls).toBe(0)
  })

  test('a skill the agent loads mid-turn is not classified as the person\'s command', async ($, on) => {
    const seen = await session($, on, () => true)
    await $.skill.prompt({ skill: 'tools:create-plan', text: 'The skill\'s own instructions.' })
    expect(seen.calls).toBe(0)
  })
})
