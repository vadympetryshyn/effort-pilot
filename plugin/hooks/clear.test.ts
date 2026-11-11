import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import { test } from './testkit'
import type { Engine } from 'claude-code/testing'

// After /clear the process goes on under a new session id: the plugin's state starts empty, and no session.start
// fires for it. A test session that never started is that session.

const reply = '{"phase":"plan","hard":false,"continues":false,"asked":"none","build":"none","faulted":false,"why":"design the feature"}'
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** The engine around a session on a managed model: counts the classifier calls and keeps the status lines shown. */
function engine(on: On, name = 'claude-opus-5-5', id = () => 'after-clear') {
  const seen = { calls: 0, status: [] as string[], sent: [] as unknown[] }
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: name }))
  on('session.id', () => ({ value: id() }))
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
  expect(seen.status).toEqual(['effort: high plan'])
})

test('its first request goes at the classified effort, not the session\'s own', async ($, on) => {
  const seen = engine(on)
  await $.prompt.submit({ text: 'Plan a CSV export for the reports page.', origin: { kind: 'composer' } } as never)
  await firstRequest($, 't1')
  expect(seen.sent).toEqual(['high'])
})

test('a model the pilot leaves alone stays alone after /clear too', async ($, on) => {
  const seen = engine(on, 'claude-haiku-5-5')
  await $.prompt.submit({ text: 'Plan a CSV export for the reports page.', origin: { kind: 'composer' } } as never)
  expect(seen.calls).toBe(0)
})

/**
 * A host whose plugin state is kept per session, as Claude Code keeps it: /clear ends the session, and the next
 * conversation runs under a new id with empty state and no session.start.
 */
async function host($: Engine, on: On) {
  let n = 1
  const id = () => `conversation-${n}`
  const seen = engine(on, 'claude-opus-5-5', id)
  const state = new Map<string, { value: unknown; version: number }>()
  const at = (e: { plugin: string; key: string }) => `${id()}/${e.plugin}/${e.key}`
  on('state.get', (_$, e) => ({ value: state.get(at(e)) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_$, e) => {
    const version = (state.get(at(e))?.version ?? 0) + 1
    state.set(at(e), { value: (e as { value: unknown }).value, version })
    return { value: { isSet: true, version } } as never
  })
  on('session.start', () => ({ cwd: '/' }))
  on('session.end', (_$, e) => {
    n++
    return { sessionId: e.sessionId }
  })
  on('command.run', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  return { seen, clear: () => $.session.end({ reason: 'clear', sessionId: id(), resume: { id: id() } } as never) }
}
const run = (command: string, args: string) => ({ command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })

test('the pilot turned off stays off after /clear', async ($, on) => {
  const { seen, clear } = await host($, on)
  await $.command.run(run('effort-pilot', 'off'))
  await clear()
  await $.prompt.submit({ text: 'Plan a CSV export for the reports page.', origin: { kind: 'composer' } } as never)
  expect(seen.calls).toBe(0)
  expect((await $.command.run(run('effort-pilot', ''))).text).toBe('Effort Pilot: off')
})

test('an effort set by hand stays the person\'s after /clear: nothing classified, the request at their effort', async ($, on) => {
  const { seen, clear } = await host($, on)
  await $.command.run(run('effort', 'high'))
  await clear()
  await $.prompt.submit({ text: 'Plan a CSV export for the reports page.', origin: { kind: 'composer' } } as never)
  await firstRequest($, 't1')
  expect(seen.calls).toBe(0)
  expect(seen.sent).toEqual(['high'])
})

test('after /clear, /effort-pilot on hands the effort back to the pilot', async ($, on) => {
  const { seen, clear } = await host($, on)
  await $.command.run(run('effort', 'high'))
  await clear()
  await $.command.run(run('effort-pilot', 'on'))
  await $.prompt.submit({ text: 'Plan a CSV export for the reports page.', origin: { kind: 'composer' } } as never)
  await firstRequest($, 't1')
  expect(seen.calls).toBe(1)
  expect(seen.sent).toEqual(['high'])
})

test('with the pilot on, the first prompt after /clear is routed', async ($, on) => {
  const { seen, clear } = await host($, on)
  await $.prompt.submit({ text: 'Say hello.', origin: { kind: 'composer' } } as never)
  await clear()
  await $.prompt.submit({ text: 'Plan a CSV export for the reports page.', origin: { kind: 'composer' } } as never)
  await firstRequest($, 't1')
  expect(seen.calls).toBe(2)
  expect(seen.sent).toEqual(['high'])
})

test('two /clear in a row keep the person\'s choice too', async ($, on) => {
  const { seen, clear } = await host($, on)
  await $.command.run(run('effort-pilot', 'off'))
  await clear()
  await clear()
  await $.prompt.submit({ text: 'Plan a CSV export for the reports page.', origin: { kind: 'composer' } } as never)
  expect(seen.calls).toBe(0)
  expect((await $.command.run(run('effort-pilot', ''))).text).toBe('Effort Pilot: off')
})
