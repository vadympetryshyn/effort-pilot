import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// A subagent on the session's model inherits the session's effort, so another effort there was chosen for it. One on
// another model starts at that model's saved effort or its default, which no one chose for it: its brief sets it.

const reply = '{"phase":"analyze","hard":false,"continues":false,"asked":"none","build":"none","faulted":false,"why":"look into it"}'
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SESSION = 'claude-opus-5-5[1m]'

/** A session whose main loop went at xhigh on SESSION; env answers from `env`. Counts classifier calls. */
async function session($: Engine, on: On, env: Record<string, string> = {}) {
  const seen = { calls: 0, sent: [] as unknown[], spawned: [] as string[] }
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: SESSION }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' as const } }))
  on('session.id', () => ({ value: 's1' }))
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', () => {
    seen.calls++
    return { value: { isAnswered: true, text: reply, usage } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/' }))
  on('agent.spawn', (_$, e) => {
    seen.spawned.push(e.description)
    return { model: e.model ?? SESSION, agentId: 'a1' }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    if (e.agentId !== undefined) seen.sent.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage } as never
  })
  on('turn.complete', () => ({ text: 'done' }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  await $.turn.start({ text: 'Look into it.', turnId: 'm1' })
  for await (const _ of $.turn.step({ turnId: 'm1', index: 0, model: SESSION, effort: 'xhigh', messageCount: 1 })) { /* drain */ }
  seen.calls = 0
  return seen
}

/** A built-in subagent spawned on `model` (undefined: the session's), its first request at `effort`. */
async function subagent($: Engine, model: string | undefined, runsOn: string, effort: string | number) {
  const prompt = 'Find why the login test fails on CI.'
  await $.agent.spawn({ prompt, description: 'investigate', subagentType: 'general-purpose', model, parentModel: SESSION, provider: { plugin: 'engine', tier: 'core' }, tool_use_id: 'tu1' } as never)
  await $.turn.start({ text: prompt, turnId: 's1', agentId: 'a1' } as never)
  for await (const _ of $.turn.step({ turnId: 's1', index: 0, model: runsOn, effort: effort as never, messageCount: 1, agentId: 'a1' } as never)) { /* drain */ }
}

describe('a built-in subagent', () => {
  test('on another model is set by its brief, whatever effort that model starts at', async ($, on) => {
    const seen = await session($, on)
    await subagent($, 'claude-fable-5-1', 'claude-fable-5-1', 'medium')
    expect(seen.calls).toBe(1)
    expect(seen.sent).toEqual(['high'])
    expect(seen.spawned).toEqual(['investigate · effort high'])
  })

  test('on the session\'s model, under another spelling, keeps an effort it did not inherit', async ($, on) => {
    const seen = await session($, on)
    await subagent($, undefined, 'claude-opus-5-5', 'medium')
    expect(seen.sent).toEqual(['medium'])
  })

  test('on the session\'s model, at the session\'s effort, is set by its brief', async ($, on) => {
    const seen = await session($, on)
    await subagent($, undefined, 'claude-opus-5-5', 'xhigh')
    expect(seen.sent).toEqual(['high'])
  })

  test('on another model keeps a numeric effort', async ($, on) => {
    const seen = await session($, on)
    await subagent($, 'claude-fable-5-1', 'claude-fable-5-1', 20000)
    expect(seen.sent).toEqual([20000])
  })

  test('with CLAUDE_CODE_SUBAGENT_EFFORT set is left at it, with no classifier call', async ($, on) => {
    const seen = await session($, on, { CLAUDE_CODE_SUBAGENT_EFFORT: 'low' })
    await subagent($, 'claude-fable-5-1', 'claude-fable-5-1', 'low')
    expect(seen.calls).toBe(0)
    expect(seen.sent).toEqual(['low'])
    expect(seen.spawned).toEqual(['investigate'])
  })
})
