import type { On } from 'claude-code'
import { describe, expect } from 'claude-code/testing'
import { test } from './testkit'
import type { Engine } from 'claude-code/testing'

import { DAY, slotFile } from './store'

// A turn the classifier gives no answer for (a timeout, an outage) runs at the person's own effort, not at the effort
// the turn before it picked: a hard request right after a light chat turn would otherwise go at low. It holds for that
// turn only, and the turn is not recorded as the pilot's.

const NOW = 20_400 * DAY + 3_600_000
const HOME = '/home/someone'
const STORE = `${HOME}/.claude/plugins/data/effort-pilot-inline/turns`
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const pick = (phase: string, continues = false) => JSON.stringify({ phase, hard: false, continues, asked: 'none', build: 'none', faulted: false, why: `reads as ${phase}` })

/** An interactive session on a managed model; the classifier answers each call from `replies`, in turn (null: no answer). */
async function session($: Engine, on: On, replies: (string | null)[]) {
  const seen = { calls: 0, sent: [] as unknown[], published: [] as unknown[], effective: undefined as unknown, status: [] as string[], files: new Map<string, string>() }
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' as const } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.exists', (_$, e) => ({ value: seen.files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: seen.files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    seen.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('model.complete', () => {
    const reply = seen.calls < replies.length ? replies[seen.calls] : replies.at(-1)
    seen.calls++
    return { value: reply === null ? { isAnswered: false as const, reason: 'aborted' as const, usage } : { isAnswered: true, text: reply!, usage } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
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
    // What the pilot last published for other plugins to show, as each request goes.
    seen.published.push(seen.effective)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage } as never
  })
  on('turn.complete', () => ({ text: 'done' }))
  on('state.set', (_$, e, next) => {
    if (e.plugin === 'effort-pilot' && e.key === 'effective') seen.effective = (e.value as { value: unknown }).value
    return next(e)
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  return seen
}

/** A turn's start: submitted, then its first request at the person's own high. */
async function start($: Engine, turnId: string, text: string, kind = 'composer') {
  await $.prompt.submit({ text, origin: { kind } } as never)
  await $.turn.start({ text, turnId })
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) { /* drain */ }
}
const complete = ($: Engine, turnId: string) => $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
async function turn($: Engine, turnId: string, text: string, kind = 'composer') {
  await start($, turnId, text, kind)
  await complete($, turnId)
}
const records = (seen: { files: Map<string, string> }) => (seen.files.get(`${STORE}/${slotFile(NOW)}`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
const agentDone = '<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>Agent "Count the files" finished</summary> <result>There are twelve.</result> </task-notification>'

describe('a turn the classifier gives no answer for', () => {
  test('runs at the person\'s own effort after a low turn, and says so', async ($, on) => {
    const seen = await session($, on, [pick('chat'), null])
    await turn($, 't1', 'What does the export button do?')
    await start($, 't2', 'Find why the export drops rows on large reports and fix it.')
    expect(seen.sent).toEqual(['low', 'high'])
    expect(seen.status.at(-1)).toBe('effort: your own · the classifier gave no answer')
    expect(seen.published).toEqual([{ effort: 'low', source: 'auto' }, null])
  })

  test('holds for that turn only: the next classified turn routes again', async ($, on) => {
    const seen = await session($, on, [pick('chat'), null, pick('implement')])
    await turn($, 't1', 'What does the export button do?')
    await turn($, 't2', 'Find why the export drops rows on large reports and fix it.')
    await start($, 't3', 'Add a CSV option to the export.')
    expect(seen.sent).toEqual(['low', 'high', 'medium'])
    expect(seen.published).toEqual([{ effort: 'low', source: 'auto' }, null, { effort: 'medium', source: 'auto' }])
  })

  test('is not recorded as a turn of the pilot', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('chat'), null, pick('implement')])
    await turn($, 't1', 'What does the export button do?')
    await turn($, 't2', 'Find why the export drops rows on large reports and fix it.')
    await turn($, 't3', 'Add a CSV option to the export.')
    expect(records(seen).map(r => [r.phase, r.sent])).toEqual([['chat', 'low'], ['implement', 'medium']])
  })

  test('a notification with no work under way runs at the person\'s own effort too', async ($, on) => {
    const seen = await session($, on, [null])
    await start($, 't1', agentDone, 'task-notification')
    expect(seen.sent).toEqual(['high'])
    expect(seen.published).toEqual([null])
  })
})
