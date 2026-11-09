import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// A level the classifier reads as asked holds for every follow-up of the work, so a misread is costly: a prompt whose
// first read names a level is read again, and only what both reads name (the lower level) is taken. A prompt that
// names no level is read once.

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const read = (asked: string, continues = false) => JSON.stringify({ phase: 'implement', hard: false, continues, asked, build: 'none', faulted: false, why: 'add the button' })

/** An interactive session on a managed model; the classifier answers each call from `replies`, in turn (null: no answer). */
async function session($: Engine, on: On, replies: (string | null)[]) {
  const seen = { calls: 0, prompts: [] as string[], sent: [] as unknown[] }
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' as const } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('model.complete', (_$, e) => {
    seen.prompts.push(e.prompt)
    const reply = seen.calls < replies.length ? replies[seen.calls] : replies.at(-1)
    seen.calls++
    return { value: reply === null ? { isAnswered: false as const, reason: 'aborted' as const, usage } : { isAnswered: true, text: reply!, usage } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
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

/** One turn the person typed: submitted, one request at high, completed. */
async function turn($: Engine, turnId: string, text: string) {
  await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text, turnId })
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) { /* drain */ }
  await $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
}

describe('a level read as asked', () => {
  test('is read twice with the same prompt and kept when both reads name it', async ($, on) => {
    const seen = await session($, on, [read('max'), read('max')])
    await turn($, 't1', 'Add the export button, and think at max.')
    expect(seen.calls).toBe(2)
    expect(seen.prompts[1]).toBe(seen.prompts[0])
    expect(seen.sent).toEqual(['max'])
  })

  test('is dropped when the second read names none: the turn goes at its phase\'s effort', async ($, on) => {
    const seen = await session($, on, [read('max'), read('none')])
    await turn($, 't1', 'Add the export button and think the whole thing through well.')
    expect(seen.calls).toBe(2)
    expect(seen.sent).toEqual(['medium'])
  })

  test('is lowered to the lower of the two reads', async ($, on) => {
    const seen = await session($, on, [read('max'), read('xhigh')])
    await turn($, 't1', 'ultrathink: add the export button.')
    expect(seen.calls).toBe(2)
    expect(seen.sent).toEqual(['xhigh'])
  })

  test('stands when the second read gets no answer', async ($, on) => {
    const seen = await session($, on, [read('max'), null])
    await turn($, 't1', 'Add the export button, and think at max.')
    expect(seen.calls).toBe(2)
    expect(seen.sent).toEqual(['max'])
  })

  test('that both reads dropped does not hold for the follow-ups', async ($, on) => {
    const seen = await session($, on, [read('max'), read('none'), read('none', true)])
    await turn($, 't1', 'Add the export button and think the whole thing through well.')
    await turn($, 't2', 'Put it next to the print button.')
    expect(seen.calls).toBe(3)
    expect(seen.sent).toEqual(['medium', 'medium'])
  })
})

describe('a prompt that names no level', () => {
  test('is read once', async ($, on) => {
    const seen = await session($, on, [read('none')])
    await turn($, 't1', 'Add the export button.')
    expect(seen.calls).toBe(1)
    expect(seen.sent).toEqual(['medium'])
  })
})
