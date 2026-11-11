import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import { test } from './testkit'
import type { Engine } from 'claude-code/testing'

const reply = '{"phase":"analyze","hard":false,"continues":false,"asked":"none","build":"none","faulted":false,"why":"look into it"}'
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

/** A session starts, then a built-in subagent is spawned in it: counts the classifier calls the plugin makes. */
async function spawnIn(isInteractive: boolean, $: Engine, on: On) {
  let calls = 0
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', () => {
    calls++
    return { value: { isAnswered: true, text: reply, usage } }
  })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('session.start', () => ({ cwd: '/' }))
  await $.session.start({ cwd: '/', surface: null, isInteractive })
  await $.agent.spawn({ prompt: 'Find why the login test fails.', description: 'investigate', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' } } as never)
  return calls
}

test('an interactive session is steered', async ($, on) => {
  expect(await spawnIn(true, $, on)).toBe(1)
})

test('headless off: a headless run is left alone', async ($, on) => {
  expect(await spawnIn(false, $, on)).toBe(0)
})

test('headless on: a headless run is steered too', { options: { headless: true } }, async ($, on) => {
  expect(await spawnIn(false, $, on)).toBe(1)
})
