import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { DAY, KEEP_DAYS, slotFile } from './store'

const NOW = 20_400 * DAY + 3_600_000
const HOME = '/home/someone'
const STORE = `${HOME}/.claude/plugins/data/effort-pilot-inline/turns`
const OLD = `${HOME}/.claude/effort-pilot/turns`

/** Runs /effort-pilot <args> as the person would type it. */
const command = (args: string) => ({ command: 'effort-pilot', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } })

const good = JSON.stringify({ t: NOW - 1000, s: 'a', arm: 'auto', phase: 'implement', hard: false, chosen: 'medium', base: 'high', sent: 'medium', model: 'claude-opus-5-5', steps: 2, out: 10, input: 1, cacheRead: 0, cacheWrite: 0, ms: 5, reason: 'answer' })

test('measuring is off by default: no report, no control turns', async ($, on) => {
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  const report = await $.command.run(command('report'))
  expect(report.text).toContain('measuring is off')
  const status = await $.command.run(command(''))
  expect(status.text).toBe('Effort Pilot: auto')
})

test('turned on, the report works and the control share is the setting\'s', { options: { measure: true } }, async ($, on) => {
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  disk(on)
  const report = await $.command.run(command('report'))
  expect(report.text).toContain('no turns recorded yet')
  expect(report.text).toContain(`records: ${STORE} (the last 90 days)`)
  const status = await $.command.run(command(''))
  expect(status.text).toContain('measuring, 30% control turns')
})

test('a custom control share', { options: { measure: true, controlShare: 10 } }, async ($, on) => {
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  const status = await $.command.run(command(''))
  expect(status.text).toContain('measuring, 10% control turns')
})

test('a corrupt line in a record file is skipped', { options: { measure: true } }, async ($, on) => {
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  disk(on, { [`${STORE}/${slotFile(NOW)}`]: `${good}\n{"t":2,"s":"a","ar\n` })
  const report = await $.command.run(command('report'))
  expect(report.text).toContain('1 turns over')
})

test('with no home folder known, no records are read', { options: { measure: true } }, async ($, on) => {
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('env.get', () => ({ value: undefined }))
  const report = await $.command.run(command('report'))
  expect(report.text).toContain('no turns recorded yet')
  expect(report.text).toContain('records: none')
})

const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const reply = '{"phase":"analyze","hard":false,"continues":false,"asked":"none","build":"none","faulted":false,"why":"look into it"}'
const at = (t: number, s = 'old') => JSON.stringify({ t, s, arm: 'auto', phase: 'chat', hard: false, chosen: 'low', base: 'high', sent: 'low', model: 'claude-opus-5-5', steps: 1, out: 1, input: 1, cacheRead: 0, cacheWrite: 0, ms: 1, reason: 'answer' })

/** A file system in memory (files by path, each with the time it was last written) and a clock a millisecond a call. */
function disk(on: On, files: Record<string, string> = {}, mtimeMs = NOW) {
  const fs = new Map(Object.entries(files).map(([k, text]) => [k, { text, mtimeMs }]))
  const parent = (p: string) => p.slice(0, p.lastIndexOf('/'))
  let clock = NOW
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('clock.now', () => ({ value: clock++ }))
  on('fs.exists', (_$, e) => ({ value: fs.has(e.path) || [...fs.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.read', (_$, e) => ({ value: fs.get(e.path)!.text }))
  on('fs.write', (_$, e) => {
    fs.set(e.path, { text: e.text, mtimeMs: clock })
    return { value: undefined }
  })
  on('fs.list', (_$, e) => ({
    value: [...fs.entries()].filter(([k]) => parent(k) === e.path)
      .map(([k, f]) => ({ name: k.slice(k.lastIndexOf('/') + 1), kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })),
  }))
  return { text: (path: string) => fs.get(path)?.text, lines: (path: string) => (fs.get(path)?.text ?? '').split('\n').filter(Boolean).length }
}

/** An interactive session on a managed model, its classifier answering analyze. */
async function session($: Engine, on: On) {
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => ({ value: { isAnswered: true, text: reply, usage } }))
  on('session.start', () => ({ cwd: '/' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage } as never
  })
  on('turn.complete', () => ({ text: 'done' }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
}

/** One turn the person starts with a prompt: classified, one request, completed. */
async function turn($: Engine, turnId: string) {
  const text = 'Why does the login test fail?'
  await $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text, turnId })
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })) { /* drain */ }
  await $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
}

test('a turn is kept in the day file of the plugin\'s data folder, and the next one joins it', { options: { measure: true } }, async ($, on) => {
  const fs = disk(on)
  await session($, on)
  await turn($, 't1')
  await turn($, 't2')
  expect(fs.lines(`${STORE}/${slotFile(NOW)}`)).toBe(2)
  const report = await $.command.run(command('report'))
  expect(report.text).toContain('2 turns over')
})

test('measuring off: no turn is kept', async ($, on) => {
  const fs = disk(on)
  await session($, on)
  await turn($, 't1')
  expect(fs.text(`${STORE}/${slotFile(NOW)}`)).toBe(undefined)
})

test('a day file is reused after 90 days: its old records go, and files not written for 90 days are emptied', { options: { measure: true } }, async ($, on) => {
  const expired = NOW - KEEP_DAYS * DAY
  const other = `${STORE}/${slotFile(NOW - DAY)}`
  const fs = disk(on, { [`${STORE}/${slotFile(NOW)}`]: `${at(expired)}\n`, [other]: `${at(expired - DAY)}\n` }, expired)
  await session($, on)
  await turn($, 't1')
  expect(fs.lines(`${STORE}/${slotFile(NOW)}`)).toBe(1)
  expect(fs.text(`${STORE}/${slotFile(NOW)}`)).toContain('sess-1')
  expect(fs.text(other)).toBe('')
})

test('records older than 90 days are not reported, even in a file not yet rewritten', { options: { measure: true } }, async ($, on) => {
  disk(on, { [`${STORE}/${slotFile(NOW - DAY)}`]: `${at(NOW - KEEP_DAYS * DAY - DAY)}\n${at(NOW - DAY)}\n` })
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  const report = await $.command.run(command('report'))
  expect(report.text).toContain('1 turns over')
})

test('records from the old location move into the data folder once, and the old files are emptied', { options: { measure: true } }, async ($, on) => {
  const fs = disk(on, {
    [`${OLD}/s1.jsonl`]: `${at(NOW - DAY, 's1')}\n${at(NOW - KEEP_DAYS * DAY - DAY, 's1')}\n`,
    [`${OLD}/s2.jsonl`]: `${at(NOW - 2 * DAY, 's2')}\n${at(NOW - DAY + 5, 's2')}\n`,
  })
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  const report = await $.command.run(command('report'))
  expect(report.text).toContain('3 turns over')
  expect(fs.text(`${OLD}/s1.jsonl`)).toBe('')
  expect(fs.text(`${OLD}/s2.jsonl`)).toBe('')
  expect(fs.lines(`${STORE}/${slotFile(NOW - DAY)}`)).toBe(2)
  expect(fs.lines(`${STORE}/${slotFile(NOW - 2 * DAY)}`)).toBe(1)
  expect((await $.command.run(command('report'))).text).toContain('3 turns over')
})

test('reset empties every records file, old and new, and says how many turns it cleared', async ($, on) => {
  let help = ''
  const fs = disk(on, {
    [`${STORE}/${slotFile(NOW)}`]: `${at(NOW - 5)}\n${at(NOW - 4)}\n`,
    [`${OLD}/s1.jsonl`]: `${at(NOW - DAY, 's1')}\n`,
  })
  on('command.register', (_$, e) => {
    help = e.description ?? ''
    return { value: { command: 'effort-pilot' } }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.start', () => ({ cwd: '/' }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  expect(help).toContain('reset')
  expect((await $.command.run(command('reset'))).text).toBe('Effort Pilot: cleared 3 turn records')
  expect(fs.text(`${STORE}/${slotFile(NOW)}`)).toBe('')
  expect(fs.text(`${OLD}/s1.jsonl`)).toBe('')
  expect((await $.command.run(command('reset'))).text).toBe('Effort Pilot: no turn records to clear')
})

/** A built-in subagent spawned in a measured session, its brief classified as this reply: runs one request and ends. */
async function subagent($: Engine, on: On, answer: string) {
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('model.complete', () => ({ value: { isAnswered: true, text: answer, usage } }))
  on('session.start', () => ({ cwd: '/' }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'a1' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], usage } as never
  })
  on('turn.complete', () => ({ text: 'done' }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  const prompt = 'Search the code for every caller of the export helper. Thoroughness: medium.'
  await $.agent.spawn({ prompt, description: 'find callers', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, tool_use_id: 'tu1' } as never)
  await $.turn.start({ text: prompt, turnId: 'st1', agentId: 'a1' } as never)
  for await (const _ of $.turn.step({ turnId: 'st1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1, agentId: 'a1' } as never)) { /* drain */ }
  await $.turn.complete({ turnId: 'st1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer', agentId: 'a1' } as never)
}

test('a level the classifier reads in a subagent\'s brief is no ask: recorded as the pilot\'s pick', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
  const fs = disk(on)
  await subagent($, on, '{"phase":"analyze","hard":false,"continues":false,"asked":"medium","build":"none","faulted":false,"why":"search the code"}')
  const [record] = (fs.text(`${STORE}/${slotFile(NOW)}`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  expect(record.who).toBe('agent')
  expect(record.asked).toBe(undefined)
  expect(record.chosen).toBe('high')
})

test('a subagent whose brief names no effort is recorded as the pilot\'s pick', { options: { measure: true, controlShare: 0 } }, async ($, on) => {
  const fs = disk(on)
  await subagent($, on, reply)
  const [record] = (fs.text(`${STORE}/${slotFile(NOW)}`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  expect(record.who).toBe('agent')
  expect(record.asked).toBe(undefined)
})
