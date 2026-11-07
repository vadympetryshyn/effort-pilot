import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { configFrom, listedAgent, reportData } from './route'
import type { TurnRecord } from '../types'
import { DAY } from './store'

// Agents another plugin provides keep their own effort unless the person lists them (the agents setting): a listed
// agent is set by its brief like a built-in, over the effort its definition declares. A headless session run as an
// agent (the sessionAgent setting) reads its first prompt as that agent's brief.

const NOW = 20_400 * DAY + 3_600_000
const HOME = '/home/someone'
const SESSION = 'claude-opus-5-5'
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const pick = (phase: string, hard = false) => JSON.stringify({ phase, hard, continues: false, asked: 'none', build: 'none', faulted: false, why: `reads as ${phase}` })
const BRIEF = 'Add a short usage note to the README under the install section. Commit your own paths.'

/** A session on SESSION; the classifier answers each call from `replies`, in turn. Records go to an in-memory disk. */
async function session($: Engine, on: On, replies: string[], interactive = true, env: Record<string, string> = {}, said: { role: string; text: string }[] = []) {
  const seen = { prompts: [] as string[], sent: [] as unknown[], main: [] as unknown[], files: new Map<string, string>() }
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: SESSION }))
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' as const } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: said as never }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : env[e.name] }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.exists', (_$, e) => ({ value: seen.files.has(e.path) }))
  on('fs.read', (_$, e) => ({ value: seen.files.get(e.path) ?? '' }))
  on('fs.write', (_$, e) => {
    seen.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('model.complete', (_$, e) => {
    seen.prompts.push(e.prompt)
    return { value: { isAnswered: true, text: replies[seen.prompts.length - 1] ?? replies.at(-1)!, usage } }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'started', text: 'started' }) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/' }))
  on('agent.spawn', (_$, e) => ({ model: e.model ?? SESSION, agentId: 'a1' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    ;(e.agentId !== undefined ? seen.sent : seen.main).push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage } as never
  })
  on('turn.complete', () => ({ text: 'done' }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: interactive })
  return { ...seen, records: () => [...seen.files.values()].join('').split('\n').filter(Boolean).map(l => JSON.parse(l)) }
}

/** The main loop's first request at xhigh, then an agent of `type` spawned from another plugin, its first request at `effort`. */
async function spawn($: Engine, type: string, effort = 'high', call: { effort?: string } = {}) {
  await $.turn.start({ text: 'Have the developer add the note.', turnId: 'm1' })
  for await (const _ of $.turn.step({ turnId: 'm1', index: 0, model: SESSION, effort: 'xhigh', messageCount: 1 })) { /* drain */ }
  await $.tool.call({ tool: 'Agent', prompt: BRIEF, description: 'add the note', subagent_type: type, tool_use_id: 'tu1', ...call } as never)
  await $.agent.spawn({ prompt: BRIEF, description: 'add the note', subagentType: type, parentModel: SESSION, provider: { plugin: type.split(':')[0]!, tier: 'user' }, tool_use_id: 'tu1' } as never)
  await $.turn.start({ text: BRIEF, turnId: 's1', agentId: 'a1' } as never)
  for await (const _ of $.turn.step({ turnId: 's1', index: 0, model: SESSION, effort: effort as never, messageCount: 1, agentId: 'a1' } as never)) { /* drain */ }
  await $.turn.complete({ turnId: 's1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer', agentId: 'a1' } as never)
}

describe('the agents setting', () => {
  test('matches a type exactly, or every agent of a plugin with plugin:*, case aside', () => {
    const c = configFrom({ agents: ' agentos:developer , Other:* ,' })
    expect(c.agents).toEqual(['agentos:developer', 'other:*'])
    expect(listedAgent('agentos:developer', c)).toBe(true)
    expect(listedAgent('agentos:qa', c)).toBe(false)
    expect(listedAgent('other:anything', c)).toBe(true)
    expect(listedAgent('otherwise:anything', c)).toBe(false)
    expect(listedAgent('agentos:qa', configFrom({ agents: 'agentos:*' }))).toBe(true)
    expect(listedAgent('agentos:qa', configFrom({}))).toBe(false)
  })

  test('a listed agent that declares high is set by its plain brief to the build effort', { options: { agents: 'agentos:developer', measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'agentos:developer')
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).toContain('subagent of type "agentos:developer"')
    expect(seen.sent).toEqual(['medium'])
    const [record] = seen.records()
    expect(record).toMatchObject({ who: 'agent', agent: 'agentos:developer', via: 'agents', base: 'high', sent: 'medium', chosen: 'medium', arm: 'auto' })
  })

  test('a listed agent\'s control run goes at its own high', { options: { agents: 'agentos:developer', measure: true, controlShare: 100 } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'agentos:developer')
    expect(seen.sent).toEqual(['high'])
    expect(seen.records()[0]).toMatchObject({ arm: 'control', base: 'high', sent: 'high', chosen: 'medium', via: 'agents' })
  })

  test('an unlisted plugin agent keeps its own effort, with no classifier call', { options: { agents: 'agentos:developer' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'agentos:qa')
    expect(seen.prompts.length).toBe(0)
    expect(seen.sent).toEqual(['high'])
  })

  test('agentos:* lists every agent of the plugin', { options: { agents: 'agentos:*' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'agentos:qa')
    expect(seen.prompts.length).toBe(1)
    expect(seen.sent).toEqual(['medium'])
  })

  test('an effort the Agent call names wins over the listing', { options: { agents: 'agentos:*' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'agentos:developer', 'xhigh', { effort: 'xhigh' })
    expect(seen.prompts.length).toBe(0)
    expect(seen.sent).toEqual(['xhigh'])
  })

  test('CLAUDE_CODE_SUBAGENT_EFFORT wins over the listing', { options: { agents: 'agentos:*' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')], true, { CLAUDE_CODE_SUBAGENT_EFFORT: 'high' })
    await spawn($, 'agentos:developer')
    expect(seen.prompts.length).toBe(0)
    expect(seen.sent).toEqual(['high'])
  })

  test('a listed agent whose brief is hard work goes at the hard-build effort', { options: { agents: 'agentos:developer' } }, async ($, on) => {
    const seen = await session($, on, [pick('fix', true)])
    await spawn($, 'agentos:developer')
    expect(seen.sent).toEqual(['high'])
  })
})

/** A headless session's turn started by `text` from `kind`: one request at high, completed. */
async function headlessTurn($: Engine, turnId: string, text: string, kind: string) {
  await $.prompt.submit({ text, origin: { kind } } as never)
  await $.turn.start({ text, turnId })
  for await (const _ of $.turn.step({ turnId, index: 0, model: SESSION, effort: 'high', messageCount: 1 })) { /* drain */ }
  await $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
}

const NOTICE = '<task-notification><task-id>b1</task-id><status>completed</status><summary>Background command "npm test" completed</summary></task-notification>'

describe('a headless session run as an agent (sessionAgent)', () => {
  test('classifies its first prompt as the agent\'s brief and records the turn as that agent\'s', { options: { sessionAgent: 'agentos:developer', measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('implement'), pick('chat')], false)
    await headlessTurn($, 't1', BRIEF, 'sdk')
    expect(seen.prompts[0]).toContain('subagent of type "agentos:developer"')
    expect(seen.prompts[0]).toContain('This is its first brief')
    expect(seen.main).toEqual(['medium'])
    const [first] = seen.records()
    expect(first).toMatchObject({ who: 'agent', agent: 'agentos:developer', via: 'sessionAgent', phase: 'implement', chosen: 'medium', sent: 'medium', base: 'high', pick: { phase: 'implement', hard: false } })
  })

  test('holds a light brief at the build effort, as a subagent\'s', { options: { sessionAgent: 'agentos:developer' } }, async ($, on) => {
    const seen = await session($, on, [pick('chat')], false)
    await headlessTurn($, 't1', BRIEF, 'sdk')
    expect(seen.main).toEqual(['medium'])
  })

  test('routes a later notification as one, still recorded as the agent\'s session', { options: { sessionAgent: 'agentos:developer', measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('implement'), pick('chat')], false)
    await headlessTurn($, 't1', BRIEF, 'sdk')
    await headlessTurn($, 't2', NOTICE, 'task-notification')
    expect(seen.prompts[1]).not.toContain('subagent of type')
    expect(seen.prompts[1]).toContain('automatic notification')
    const [, second] = seen.records()
    expect(second).toMatchObject({ who: 'notification', agent: 'agentos:developer', via: 'sessionAgent' })
  })

  test('reads a resumed session\'s first prompt as a message, not a brief', { options: { sessionAgent: 'agentos:developer', measure: true, controlShare: 0 } }, async ($, on) => {
    const said = [{ role: 'user', text: BRIEF }, { role: 'assistant', text: 'Done: the note is in.' }]
    const seen = await session($, on, [pick('implement'), pick('fix')], false, {}, said)
    await headlessTurn($, 't1', 'The note is in the wrong section: move it.', 'sdk')
    expect(seen.prompts.some(p => p.includes('subagent of type'))).toBe(false)
    expect(seen.records()[0]).toMatchObject({ who: 'person', agent: 'agentos:developer', via: 'sessionAgent' })
  })

  test('an interactive session is not one, whatever the setting says', { options: { sessionAgent: 'agentos:developer', measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')], true)
    await headlessTurn($, 't1', BRIEF, 'composer')
    expect(seen.prompts[0]).not.toContain('subagent of type')
    expect(seen.records()[0].via).toBe(undefined)
  })
})

describe('the report', () => {
  let n = 0
  const run = (fields: Partial<TurnRecord>): TurnRecord => ({
    t: NOW - 60_000 + n++, s: `s${n}`, arm: 'auto', phase: 'implement', hard: false, chosen: 'medium', base: 'high', sent: 'medium',
    model: SESSION, steps: 2, out: 1000, input: 500, cacheRead: 20_000, cacheWrite: 2000, ms: 9000, gen: 6000, reason: 'answer', ...fields,
  })
  test('gives each listed agent type a group of its own, apart from the subagents and your prompts', () => {
    const d = reportData([
      run({ who: 'agent', agent: 'Explore' }),
      run({ who: 'agent', agent: 'agentos:developer', via: 'agents' }),
      run({ who: 'agent', agent: 'agentos:developer', via: 'sessionAgent', arm: 'control', sent: 'high' }),
      run({ who: 'agent', agent: 'agentos:qa', via: 'agents' }),
      run({ who: 'person' }),
    ])
    const groups = d.phases.map(p => `${p.who}${p.agent ? `:${p.agent}` : ''}`)
    expect(groups).toEqual(['person', 'agent', 'agent:agentos:developer', 'agent:agentos:qa'])
    const dev = d.phases.find(p => p.agent === 'agentos:developer')!
    expect(dev.pilot?.turns).toBe(1)
    expect(dev.control?.turns).toBe(1)
  })
})
