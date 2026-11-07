import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { configFrom, listedAgent, reportData } from './route'
import type { TurnRecord } from '../types'
import { DAY } from './store'

// Agents that are not built-ins (a plugin's, or a person's or project's own) keep their own effort unless the person
// lists them (the agents setting): a listed agent is set by its brief like a built-in, over the effort its definition
// declares. A headless session run as an agent (claude -p --agent <type>) reads its first prompt as that agent's brief.

const NOW = 20_400 * DAY + 3_600_000
const HOME = '/home/someone'
const SESSION = 'claude-opus-5-5'
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const pick = (phase: string, hard = false, continues = false) => JSON.stringify({ phase, hard, continues, asked: 'none', build: 'none', faulted: false, why: `reads as ${phase}` })
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
  on('classic.SessionStart', () => ({}) as never)
  on('classic.UserPromptSubmit', () => ({}) as never)
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

/** Who provides an agent type: a plugin's (`plugin:name`), else the project's own. */
const provider = (type: string) => (type.includes(':') ? { plugin: type.split(':')[0]!, tier: 'user' } : { plugin: 'project', tier: 'user' })

type Spawn = { effort?: string | number; model?: string; call?: { effort?: string }; spawn?: Record<string, unknown>; text?: string; turn?: string }
/** The main loop's first request at xhigh, then an agent of `type` spawned, its first request at `effort` on `model`. */
async function spawn($: Engine, type: string, o: Spawn = {}) {
  const text = o.text ?? BRIEF
  const turn = o.turn ?? 's1'
  if (!o.spawn?.resume) {
    await $.turn.start({ text: 'Have the builder add the note.', turnId: 'm1' })
    for await (const _ of $.turn.step({ turnId: 'm1', index: 0, model: SESSION, effort: 'xhigh', messageCount: 1 })) { /* drain */ }
  }
  await $.tool.call({ tool: 'Agent', prompt: text, description: 'add the note', subagent_type: type, tool_use_id: turn, ...o.call } as never)
  await $.agent.spawn({ prompt: text, description: 'add the note', subagentType: type, parentModel: SESSION, provider: provider(type), tool_use_id: turn, ...o.spawn } as never)
  await $.turn.start({ text, turnId: turn, agentId: 'a1' } as never)
  for await (const _ of $.turn.step({ turnId: turn, index: 0, model: o.model ?? SESSION, effort: (o.effort ?? 'high') as never, messageCount: 1, agentId: 'a1' } as never)) { /* drain */ }
  await $.turn.complete({ turnId: turn, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer', agentId: 'a1' } as never)
}

describe('the agents setting', () => {
  test('matches a name exactly: a plugin\'s agent, every agent of a plugin with plugin:*, a project\'s own agent, case aside', () => {
    const c = configFrom({ agents: ' lab:builder , Tools:* , Reviewer ,' })
    expect(c.agents).toEqual(['lab:builder', 'tools:*', 'reviewer'])
    expect(listedAgent('lab:builder', c)).toBe(true)
    expect(listedAgent('lab:checker', c)).toBe(false)
    expect(listedAgent('tools:anything', c)).toBe(true)
    expect(listedAgent('toolset:anything', c)).toBe(false)
    expect(listedAgent('reviewer', c)).toBe(true)
    expect(listedAgent('code-reviewer', c)).toBe(false)
    expect(listedAgent('lab:checker', configFrom({ agents: 'lab:*' }))).toBe(true)
    expect(listedAgent('lab:checker', configFrom({}))).toBe(false)
  })

  test('* lists every agent that is not a built-in', () => {
    const c = configFrom({ agents: '*' })
    expect(listedAgent('lab:builder', c)).toBe(true)
    expect(listedAgent('reviewer', c)).toBe(true)
    expect(listedAgent('Explore', c, true)).toBe(false)
  })

  test('a listed plugin agent that declares high is set by its plain brief to the build effort', { options: { agents: 'lab:builder', measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'lab:builder')
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).toContain('subagent of type "lab:builder"')
    expect(seen.sent).toEqual(['medium'])
    const [record] = seen.records()
    expect(record).toMatchObject({ who: 'agent', agent: 'lab:builder', via: 'listed', base: 'high', sent: 'medium', chosen: 'medium', arm: 'auto' })
  })

  test('a listed project agent, named bare, is set the same way', { options: { agents: 'reviewer' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'reviewer')
    expect(seen.sent).toEqual(['medium'])
  })

  test('a listed agent\'s control run goes at its own high', { options: { agents: 'lab:builder', measure: true, controlShare: 100 } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'lab:builder')
    expect(seen.sent).toEqual(['high'])
    expect(seen.records()[0]).toMatchObject({ arm: 'control', base: 'high', sent: 'high', chosen: 'medium', via: 'listed' })
  })

  test('with nothing listed, a plugin or project agent keeps its own effort, with no classifier call', async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'lab:builder')
    await spawn($, 'reviewer', { turn: 's2' })
    expect(seen.prompts.length).toBe(0)
    expect(seen.sent).toEqual(['high', 'high'])
  })

  test('an unlisted agent keeps its own effort while another is listed', { options: { agents: 'lab:builder' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'lab:checker')
    expect(seen.prompts.length).toBe(0)
    expect(seen.sent).toEqual(['high'])
  })

  test('lab:* lists every agent of the plugin', { options: { agents: 'lab:*' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'lab:checker')
    expect(seen.prompts.length).toBe(1)
    expect(seen.sent).toEqual(['medium'])
  })

  test('an effort the Agent call names wins over the listing', { options: { agents: '*' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'lab:builder', { effort: 'xhigh', call: { effort: 'xhigh' } })
    expect(seen.prompts.length).toBe(0)
    expect(seen.sent).toEqual(['xhigh'])
  })

  test('CLAUDE_CODE_SUBAGENT_EFFORT wins over the listing', { options: { agents: '*' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')], true, { CLAUDE_CODE_SUBAGENT_EFFORT: 'high' })
    await spawn($, 'lab:builder')
    expect(seen.prompts.length).toBe(0)
    expect(seen.sent).toEqual(['high'])
  })

  test('a listed agent on a model the pilot does not manage is left alone', { options: { agents: '*' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'lab:builder', { model: 'claude-sonnet-5-5' })
    expect(seen.sent).toEqual(['high'])
  })

  test('a listed agent whose definition gives a number keeps it', { options: { agents: '*' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'lab:builder', { effort: 20000 })
    expect(seen.sent).toEqual([20000])
  })

  test('a fork, a teammate or a workflow agent is left alone, listed or not', { options: { agents: '*' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await spawn($, 'lab:builder', { spawn: { isTeammate: true } })
    await spawn($, 'lab:builder', { spawn: { fork: true }, turn: 's2' })
    await spawn($, 'lab:builder', { spawn: { workflow: { name: 'w' } }, turn: 's3' })
    expect(seen.prompts.length).toBe(0)
    expect(seen.sent).toEqual(['high', 'high', 'high'])
  })

  test('a listed agent woken again keeps its work: a question about the build at its own effort, never below the build effort', { options: { agents: '*' } }, async ($, on) => {
    const seen = await session($, on, [pick('fix', true), pick('chat', false, true)])
    await spawn($, 'lab:builder')
    await spawn($, 'lab:builder', { text: 'Which file did you change?', turn: 's2', spawn: { resume: { agentId: 'a1' } } })
    expect(seen.prompts[1]).toContain('The subagent\'s work under way (fix)')
    expect(seen.sent).toEqual(['high', 'medium'])
  })

  test('a listed agent spawned in plan mode is set by its brief, as a built-in is', { options: { agents: '*' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')])
    await $.classic.UserPromptSubmit({ prompt: 'Plan a CSV export.', permission_mode: 'plan' } as never)
    await spawn($, 'lab:builder')
    expect(seen.sent).toEqual(['medium'])
  })

  test('headless off: a listed agent in a claude -p run is not steered, as a built-in is not', { options: { agents: '*' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')], false)
    await spawn($, 'lab:builder')
    expect(seen.prompts.length).toBe(0)
    expect(seen.sent).toEqual(['high'])
  })

  test('headless on: it is', { options: { agents: '*', headless: true } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')], false)
    await spawn($, 'lab:builder')
    expect(seen.sent).toEqual(['medium'])
  })

  test('a listed agent whose brief is hard work goes at the hard-build effort', { options: { agents: 'lab:builder' } }, async ($, on) => {
    const seen = await session($, on, [pick('fix', true)])
    await spawn($, 'lab:builder')
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
/** The engine's classic SessionStart for a session started with --agent <type> (on the main thread: no agent_id). */
const startedAs = ($: Engine, type: string) => $.classic.SessionStart({ source: 'startup', agent_type: type } as never)

const NOTICE = '<task-notification><task-id>b1</task-id><status>completed</status><summary>Background command "npm test" completed</summary></task-notification>'

describe('a headless session run as an agent', () => {
  test('classifies its first prompt as the agent\'s brief and records the turn as that agent\'s', { options: { headless: true, measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('implement'), pick('chat')], false)
    await startedAs($, 'lab:builder')
    await headlessTurn($, 't1', BRIEF, 'sdk')
    expect(seen.prompts[0]).toContain('subagent of type "lab:builder"')
    expect(seen.prompts[0]).toContain('This is its first brief')
    expect(seen.main).toEqual(['medium'])
    const [first] = seen.records()
    expect(first).toMatchObject({ who: 'agent', agent: 'lab:builder', via: 'session', phase: 'implement', chosen: 'medium', sent: 'medium', base: 'high', pick: { phase: 'implement', hard: false } })
  })

  test('the sessionAgent setting names the agent where the engine does not', { options: { headless: true, sessionAgent: 'reviewer', measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')], false)
    await headlessTurn($, 't1', BRIEF, 'sdk')
    expect(seen.prompts[0]).toContain('subagent of type "reviewer"')
    expect(seen.records()[0]).toMatchObject({ who: 'agent', agent: 'reviewer', via: 'session' })
  })

  test('and stands over the engine\'s word', { options: { headless: true, sessionAgent: 'reviewer' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')], false)
    await startedAs($, 'lab:builder')
    await headlessTurn($, 't1', BRIEF, 'sdk')
    expect(seen.prompts[0]).toContain('subagent of type "reviewer"')
  })

  test('headless off: nothing is classified, the setting set or not', { options: { sessionAgent: 'reviewer' } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')], false)
    await startedAs($, 'lab:builder')
    await headlessTurn($, 't1', BRIEF, 'sdk')
    expect(seen.prompts.length).toBe(0)
    expect(seen.main).toEqual(['high'])
  })

  test('holds a light brief at the build effort, as a subagent\'s', { options: { headless: true } }, async ($, on) => {
    const seen = await session($, on, [pick('chat')], false)
    await startedAs($, 'lab:builder')
    await headlessTurn($, 't1', BRIEF, 'sdk')
    expect(seen.main).toEqual(['medium'])
  })

  test('routes a later notification as one, still recorded as the agent\'s session', { options: { headless: true, measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('implement'), pick('chat')], false)
    await startedAs($, 'lab:builder')
    await headlessTurn($, 't1', BRIEF, 'sdk')
    await headlessTurn($, 't2', NOTICE, 'task-notification')
    expect(seen.prompts[1]).not.toContain('subagent of type')
    expect(seen.prompts[1]).toContain('automatic notification')
    const [, second] = seen.records()
    expect(second).toMatchObject({ who: 'notification', agent: 'lab:builder', via: 'session' })
  })

  test('reads a resumed session\'s first prompt as a message, not a brief', { options: { headless: true, measure: true, controlShare: 0 } }, async ($, on) => {
    const said = [{ role: 'user', text: BRIEF }, { role: 'assistant', text: 'Done: the note is in.' }]
    const seen = await session($, on, [pick('implement'), pick('fix')], false, {}, said)
    await startedAs($, 'lab:builder')
    await headlessTurn($, 't1', 'The note is in the wrong section: move it.', 'sdk')
    expect(seen.prompts.some(p => p.includes('subagent of type'))).toBe(false)
    expect(seen.records()[0]).toMatchObject({ who: 'person', agent: 'lab:builder', via: 'session' })
  })

  test('a headless session not started as an agent is routed as before', { options: { headless: true, measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('implement')], false)
    await headlessTurn($, 't1', BRIEF, 'sdk')
    expect(seen.prompts[0]).not.toContain('subagent of type')
    expect(seen.records()[0].via).toBe(undefined)
  })

  test('an interactive session is not one, whatever the setting says', { options: { headless: true, sessionAgent: 'reviewer', measure: true, controlShare: 0 } }, async ($, on) => {
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
      run({ who: 'agent', agent: 'lab:builder', via: 'listed' }),
      run({ who: 'agent', agent: 'lab:builder', via: 'session', arm: 'control', sent: 'high' }),
      run({ who: 'agent', agent: 'reviewer', via: 'listed' }),
      run({ who: 'person' }),
    ])
    const groups = d.phases.map(p => `${p.who}${p.agent ? `:${p.agent}` : ''}`)
    expect(groups).toEqual(['person', 'agent', 'agent:lab:builder', 'agent:reviewer'])
    const builder = d.phases.find(p => p.agent === 'lab:builder')!
    expect(builder.pilot?.turns).toBe(1)
    expect(builder.control?.turns).toBe(1)
  })
})
