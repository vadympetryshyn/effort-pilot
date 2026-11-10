import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DAY, slotFile } from './store'

// A notification (a background task finished, another Claude session's message) is classified with work under way:
// a result to relay goes at its own pick (at least medium; a finished task's during a plan or an analysis at least
// high), one the agent must think through at the work's effort.
// Each turn's record keeps the classifier's own pick and whether the work's effort was kept.

const NOW = 20_400 * DAY + 3_600_000
const HOME = '/home/someone'
const STORE = `${HOME}/.claude/plugins/data/effort-pilot-inline/turns`
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const pick = (phase: string, hard = false) => JSON.stringify({ phase, hard, continues: true, asked: 'none', build: 'none', faulted: false, why: `reads as ${phase}` })

/** An interactive session on a managed model; the classifier answers each call from `replies`, in turn. */
async function session($: Engine, on: On, replies: string[]) {
  const seen = { calls: 0, prompts: [] as string[], files: new Map<string, string>(), sent: [] as unknown[] }
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
  on('model.complete', (_$, e) => {
    seen.prompts.push(e.prompt)
    return { value: { isAnswered: true, text: replies[seen.calls++] ?? replies.at(-1)!, usage } }
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

/** One turn started by `text` from `kind`: submitted, one request at high, completed. */
async function turn($: Engine, turnId: string, text: string, kind: string) {
  await $.prompt.submit({ text, origin: { kind } } as never)
  await $.turn.start({ text, turnId })
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) { /* drain */ }
  await $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
}

const agentDone = '<task-notification> <task-id>a1</task-id> <status>completed</status> <summary>Agent "Add the export button" finished</summary> <result>The export button is in and its test passes.</result> </task-notification>'
const shellFailed = '<task-notification> <task-id>b1</task-id> <status>failed</status> <summary>Background command "Run the tests" failed with exit code 1</summary> </task-notification>'
const monitorEvent = '<task-notification> <task-id>m1</task-id> <summary>Monitor event: "build log"</summary> <event>compiled 12 files</event> </task-notification>'
const records = (seen: { files: Map<string, string> }) => (seen.files.get(`${STORE}/${slotFile(NOW)}`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))

describe('a notification with work under way', () => {
  test('an agent\'s result during an analysis, read as chat, goes at high', async ($, on) => {
    const seen = await session($, on, [pick('analyze'), pick('chat')])
    await turn($, 't1', 'Why does the export time out on large reports?', 'composer')
    await turn($, 't2', agentDone, 'task-notification')
    expect(seen.calls).toBe(2)
    expect(seen.sent).toEqual(['high', 'high'])
  })

  test('an agent\'s result during a plan at xhigh, read as chat, goes at high', { options: { planEffort: 'xhigh' } }, async ($, on) => {
    const seen = await session($, on, [pick('plan'), pick('chat')])
    await turn($, 't1', 'Plan the CSV export of the reports page.', 'composer')
    await turn($, 't2', agentDone, 'task-notification')
    expect(seen.sent).toEqual(['xhigh', 'high'])
  })

  test('a monitor event (no status) during an analysis, read as chat, goes at medium, and the record keeps the pick', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('analyze'), pick('chat')])
    await turn($, 't1', 'Why does the export time out on large reports?', 'composer')
    await turn($, 't2', monitorEvent, 'task-notification')
    expect(seen.calls).toBe(2)
    expect(seen.sent).toEqual(['high', 'medium'])
    const [person, notice] = records(seen)
    expect(person.pick).toEqual({ phase: 'analyze', hard: false })
    expect(person.kept).toBe(undefined)
    expect(person.why).toBe(undefined)
    expect(notice.who).toBe('notification')
    expect(notice.pick).toEqual({ phase: 'chat', hard: false })
    expect(notice.kept).toBe(undefined)
    expect(notice.chosen).toBe('medium')
  })

  test('one the agent must think through keeps the work\'s effort, and the record says it was kept', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('analyze'), pick('analyze')])
    await turn($, 't1', 'Why does the export time out on large reports?', 'composer')
    await turn($, 't2', agentDone, 'task-notification')
    expect(seen.sent).toEqual(['high', 'high'])
    const notice = records(seen)[1]
    expect(notice.pick).toEqual({ phase: 'analyze', hard: false })
    expect(notice.kept).toBe(true)
  })

  test('a failed background command keeps the work\'s effort, whatever the pick', async ($, on) => {
    const seen = await session($, on, [pick('analyze'), pick('chat')])
    await turn($, 't1', 'Why does the export time out on large reports?', 'composer')
    await turn($, 't2', shellFailed, 'task-notification')
    expect(seen.sent).toEqual(['high', 'high'])
  })
})

describe('another Claude session\'s message', () => {
  test('is routed as a notification, not as the person\'s prompt', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('analyze'), pick('chat')])
    await turn($, 't1', 'Why does the export time out on large reports?', 'composer')
    await turn($, 't2', 'Another Claude session sent a message: the staging deploy is done.', 'peer')
    expect(seen.calls).toBe(2)
    expect(seen.prompts[1]).toContain('message from another Claude session')
    expect(seen.sent).toEqual(['high', 'medium'])
    expect(records(seen)[1].who).toBe('notification')
  })
})

// A message submitted while only a subagent works carries the subagent's turn id, but the main loop is idle: it starts
// a main-loop turn of its own and is routed as it is submitted. Only the main loop's running turn makes one mid-turn.
const handBack = '<agent-message from="a2">[Subagent hand-back] The search is done: the timeout comes from the unpaged report query.</agent-message>'

/** A subagent's turn that is still running, with the main loop idle. */
async function subagentRuns($: Engine) {
  await $.turn.start({ text: 'Find where the report query is built.', turnId: 'sub1', agentId: 'a1' } as never)
}

/** A main-loop turn started by a message submitted over the turn `over` (none: the main loop idle), meta when the engine marks it so. */
async function turnOver($: Engine, over: string | undefined, turnId: string, text: string, kind: string, isMeta = false) {
  await $.prompt.submit({ text, origin: { kind }, turnId: over, ...(isMeta ? { isMeta } : {}) } as never)
  await $.turn.start({ text, turnId })
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) { /* drain */ }
  await $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
}

describe('a message submitted while only a subagent works', () => {
  test('a finished task\'s notification is classified once and routed as a notification', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('analyze'), pick('chat')])
    await turn($, 't1', 'Why does the export time out on large reports?', 'composer')
    await subagentRuns($)
    await turnOver($, 'sub1', 't2', agentDone, 'task-notification')
    expect(seen.calls).toBe(2)
    expect(seen.sent).toEqual(['high', 'high'])
    const notice = records(seen)[1]
    expect(notice.who).toBe('notification')
    expect(notice.cls.calls).toBe(1)
    expect(notice.pick).toEqual({ phase: 'chat', hard: false })
  })

  test('a subagent\'s hand-back is classified once and routed as a notification', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('analyze'), pick('chat')])
    await turn($, 't1', 'Why does the export time out on large reports?', 'composer')
    await subagentRuns($)
    await turnOver($, 'sub1', 't2', handBack, 'peer', true)
    expect(seen.calls).toBe(2)
    expect(seen.prompts[1]).toContain('message from another Claude session')
    expect(seen.sent).toEqual(['high', 'high'])
    const notice = records(seen)[1]
    expect(notice.who).toBe('notification')
    expect(notice.cls.calls).toBe(1)
    expect(notice.pick).toEqual({ phase: 'chat', hard: false })
  })

  test('a person\'s prompt is classified once, not again as its turn starts', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('analyze'), pick('implement')])
    await turn($, 't1', 'Why does the export time out on large reports?', 'composer')
    await subagentRuns($)
    await turnOver($, 'sub1', 't2', 'Add paging to the report query.', 'composer')
    expect(seen.calls).toBe(2)
    const prompt = records(seen)[1]
    expect(prompt.who).toBe('person')
    expect(prompt.cls.calls).toBe(1)
    expect(prompt.pick).toEqual({ phase: 'implement', hard: false })
  })
})

// A subagent's hand-back comes as a meta message from a peer: the result of a finished task, routed like one.
describe('a subagent\'s hand-back', () => {
  test('during an analysis, read as chat, goes at high, and the record is the notification\'s', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
    const seen = await session($, on, [pick('analyze'), pick('chat')])
    await turn($, 't1', 'Why does the export time out on large reports?', 'composer')
    await turnOver($, undefined, 't2', handBack, 'peer', true)
    expect(seen.calls).toBe(2)
    expect(seen.sent).toEqual(['high', 'high'])
    const notice = records(seen)[1]
    expect(notice.who).toBe('notification')
    expect(notice.pick).toEqual({ phase: 'chat', hard: false })
  })

  test('during a plain build goes at its own pick: at least medium, at most the work\'s', async ($, on) => {
    const seen = await session($, on, [pick('implement'), pick('chat'), pick('fix')])
    await turn($, 't1', 'Add a CSV export button to the reports page.', 'composer')
    await turnOver($, undefined, 't2', handBack, 'peer', true)
    await turnOver($, undefined, 't3', handBack, 'peer', true)
    expect(seen.calls).toBe(3)
    expect(seen.sent).toEqual(['medium', 'medium', 'medium'])
  })

  test('a meta message that is no notification is still not classified', async ($, on) => {
    const seen = await session($, on, [pick('analyze'), pick('chat')])
    await turn($, 't1', 'Why does the export time out on large reports?', 'composer')
    await turnOver($, undefined, 't2', 'Caveat: the messages below were generated by a local command.', 'composer', true)
    expect(seen.calls).toBe(1)
  })
})

describe('a notification submitted over the main loop\'s running turn', () => {
  test('is not classified as it is submitted', async ($, on) => {
    const seen = await session($, on, [pick('analyze'), pick('chat')])
    await $.prompt.submit({ text: 'Why does the export time out on large reports?', origin: { kind: 'composer' } } as never)
    await $.turn.start({ text: 'Why does the export time out on large reports?', turnId: 't1' })
    await $.prompt.submit({ text: agentDone, origin: { kind: 'task-notification' }, turnId: 't1' } as never)
    expect(seen.calls).toBe(1)
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) { /* drain */ }
    await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
    expect(seen.calls).toBe(1)
    expect(seen.sent).toEqual(['high'])
  })
})
