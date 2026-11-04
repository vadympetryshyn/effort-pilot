import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// After /clear the process goes on under a new session id: the plugin's state starts empty, and no session.start
// fires for it. A test session that never started is that session.

const reply = '{"phase":"plan","hard":false,"continues":false,"asked":"none","build":"none","faulted":false,"why":"design the feature"}'
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** The engine around a session on a managed model: counts the classifier calls and keeps the status lines shown. */
function engine(on: On, name = 'claude-opus-5-5') {
  const seen = { calls: 0, status: [] as string[], sent: [] as unknown[] }
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: name }))
  on('session.id', () => ({ value: 'after-clear' }))
  on('session.messages', () => ({ value: [] }))
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', () => {
    seen.calls++
    return { value: { isAnswered: true, text: reply, usage } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.status', (_$, e) => {
    seen.status.push(e.text ?? '')
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    seen.sent.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage } as never
  })
  return seen
}

/** The turn's first request, sent at the session's own effort (high). */
async function firstRequest($: Engine, turnId: string) {
  await $.turn.start({ text: 'Plan a CSV export for the reports page.', turnId })
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) { /* drain */ }
}

test('the first prompt of a session that began with no session.start (after /clear) is classified', async ($, on) => {
  const seen = engine(on)
  await $.prompt.submit({ text: 'Plan a CSV export for the reports page.', origin: { kind: 'composer' } } as never)
  expect(seen.calls).toBe(1)
  expect(seen.status).toEqual(['effort: xhigh plan'])
})

test('its first request goes at the classified effort, not the session\'s own', async ($, on) => {
  const seen = engine(on)
  await $.prompt.submit({ text: 'Plan a CSV export for the reports page.', origin: { kind: 'composer' } } as never)
  await firstRequest($, 't1')
  expect(seen.sent).toEqual(['xhigh'])
})

test('a model the pilot leaves alone stays alone after /clear too', async ($, on) => {
  const seen = engine(on, 'claude-haiku-5-5')
  await $.prompt.submit({ text: 'Plan a CSV export for the reports page.', origin: { kind: 'composer' } } as never)
  expect(seen.calls).toBe(0)
})
