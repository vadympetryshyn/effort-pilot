import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { TurnRecord } from '../types'
import { report, reportData } from './route'
import { DAY, slotFile } from './store'

const NOW = 20_400 * DAY + 3_600_000
const HOME = '/home/someone'
const STORE = `${HOME}/.claude/plugins/data/effort-pilot-inline/turns`

let n = 0
/** A finished turn: a pilot turn at medium where high was the person's own, unless the fields say otherwise. */
const turn = (fields: Partial<TurnRecord>): TurnRecord => ({
  t: NOW - 60_000 + n++, s: `s${n}`, arm: 'auto', phase: 'implement', hard: false, chosen: 'medium', base: 'high', sent: 'medium',
  model: 'claude-opus-5-5', steps: 2, out: 1000, input: 500, cacheRead: 20_000, cacheWrite: 2000, ms: 9000, gen: 6000, reason: 'answer',
  cls: { calls: 1, input: 900, out: 40, cacheRead: 0, cacheWrite: 0, ms: 1200 },
  ...fields,
})
const control = (fields: Partial<TurnRecord> = {}) => turn({ arm: 'control', sent: 'high', out: 3000, gen: 12_000, ...fields })

/** Six pilot and six control turns of one phase (compared), a phase with too few, one with none comparable, a test. */
function sample(): TurnRecord[] {
  return [
    ...Array.from({ length: 6 }, (_, i) => turn({ out: 900 + i * 50 })),
    ...Array.from({ length: 6 }, (_, i) => control({ out: 3000 + i * 50 })),
    turn({ phase: 'chat', chosen: 'low', sent: 'low' }),
    turn({ phase: 'chat', chosen: 'low', sent: 'low', cls: undefined }),
    control({ phase: 'chat', chosen: 'low' }),
    turn({ who: 'notification', phase: 'trivial', chosen: 'high', sent: 'high' }),
    turn({ who: 'notification', phase: 'trivial', chosen: 'high', sent: 'high' }),
    turn({ test: true }),
  ]
}

/** One phase, five turns on each arm, whose cost varies so much its range spans zero; the pilot's is lower on the point. */
const shaky = () => [
  ...Array.from({ length: 5 }, (_, i) => turn({ phase: 'fix', out: [500, 5000, 900, 4000, 1200][i] })),
  ...Array.from({ length: 5 }, (_, i) => control({ phase: 'fix', out: [4500, 700, 3900, 1100, 2600][i] })),
]

describe('the report as data', () => {
  const d = reportData(sample())

  test('counts the turns, leaving out test turns', () => {
    expect(d.turns).toBe(17)
    expect(d.left).toBe(1)
  })

  test('compares a phase with five or more turns on each arm, and judges each measure', () => {
    const p = d.phases.find(x => x.who === 'person' && x.phase === 'implement')!
    expect(p.pilot?.turns).toBe(6)
    expect(p.control?.turns).toBe(6)
    expect(p.efforts).toEqual(['medium'])
    expect(p.need).toEqual({ pilot: 0, control: 0 })
    expect(p.measures?.cost.verdict).toBe('better')
    expect(p.measures?.time.verdict).toBe('better')
    // Neither arm fell short: no gap, so no count of turns to come either.
    expect(p.measures?.short).toMatchObject({ verdict: 'unclear', share: 0, more: null })
  })

  test('says how many turns a phase with too few still needs', () => {
    const p = d.phases.find(x => x.phase === 'chat')!
    expect(p.measures).toBeUndefined()
    expect(p.need).toEqual({ pilot: 3, control: 4 })
  })

  test('keeps a phase with no comparable turn, counted as not compared', () => {
    const p = d.phases.find(x => x.who === 'notification')!
    expect(p.pilot).toBeNull()
    expect(p.control).toBeNull()
    expect(p.same).toBe(2)
  })

  test('counts the turns at each effort sent', () => {
    expect(d.sent).toEqual({ medium: 6, high: 9, low: 2 })
  })

  test('counts the classifier\'s own cost and the turns that carry none', () => {
    expect(d.classifier).toMatchObject({ calls: 16, turns: 16, missing: 1, wait: 1.2 })
  })

  test('sums the net over the compared phases only', () => {
    expect(d.net).toMatchObject({ phases: 1, turns: 6 })
    expect(d.net!.saved).toBeGreaterThan(0)
  })

  test('says the net pays for itself once every compared phase\'s cost saving is clear', () => {
    expect(d.net).toMatchObject({ verdict: 'pays', unclear: 0 })
  })

  test('reads an unclear measure with the turns still needed while the range spans zero', () => {
    const cost = reportData(shaky()).phases[0]!.measures!.cost
    expect(cost.verdict).toBe('unclear')
    expect(cost.more!.pilot).toBeGreaterThan(0)
    expect(cost.more!.control).toBeGreaterThan(0)
  })

  test('leaves the net unclear while a compared phase\'s cost range spans zero, whatever the point says', () => {
    const net = reportData(shaky()).net!
    expect(net.saved - net.perTurn).toBeGreaterThan(0)
    expect(net).toMatchObject({ verdict: 'unclear', unclear: 1, phases: 1 })
  })

  test('has nothing to read with no records', () => {
    expect(reportData([])).toMatchObject({ turns: 0, phases: [], classifier: null, net: null })
    expect(report([])).toBe('no turns recorded yet')
  })
})

/** Runs /effort-pilot report as the person would type it. */
const command = { command: 'effort-pilot', args: 'report', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }

/** A records folder in memory, seeded with `records`; `put` writes more into it. */
function disk(on: On, records: TurnRecord[]) {
  const fs = new Map<string, string>([[`${STORE}/${slotFile(NOW)}`, records.map(r => JSON.stringify(r)).join('\n') + '\n']])
  const parent = (p: string) => p.slice(0, p.lastIndexOf('/'))
  on('command.register', () => ({ value: { command: 'effort-pilot' } }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.exists', (_$, e) => ({ value: fs.has(e.path) || [...fs.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.read', (_$, e) => ({ value: fs.get(e.path)! }))
  on('fs.write', (_$, e) => {
    fs.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_$, e) => ({
    value: [...fs.entries()].filter(([k]) => parent(k) === e.path)
      .map(([k, text]) => ({ name: k.slice(k.lastIndexOf('/') + 1), kind: 'file' as const, size: text.length, mtimeMs: NOW, isLink: false })),
  }))
  return { put: (r: TurnRecord) => fs.set(`${STORE}/${slotFile(NOW)}`, `${fs.get(`${STORE}/${slotFile(NOW)}`)}${JSON.stringify(r)}\n`) }
}

const PANE = {
  plugin: 'effort-pilot',
  component: 'Pane',
  requestId: 'effort-pilot-report',
  props: { title: 'Effort Pilot report', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the report opens a pane of bars, pilot against control, on every surface', { options: { measure: true } }, async ($, on) => {
  disk(on, sample())
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  const answer = await $.command.run(command)
  expect(answer.text).toBe('report opened beside the chat')
  expect(opened).toEqual(['effort-pilot-report'])

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^17 turns over/ }))?.text).toContain('17 turns over 0.0 days')
    expect((await ui.find({ type: 'Text', text: /your prompts · implement/ }))?.text).toContain('6 pilot, 6 control turns')
    // A compared measure: its range and its verdict in words.
    expect((await ui.find({ type: 'Text', text: /better with Effort Pilot: clear/ }))?.text).toMatch(/^ {2}−\d+% \(90% range −\d+% … −\d+%\) → better/)
    // A phase with too few turns says so, and how many it still needs.
    expect((await ui.find({ type: 'Text', text: /too few turns to compare/ }))?.text).toBe('too few turns to compare: 3 pilot and 4 control to go (5+ in each)')
    // The bars: the control's cost is the longer of the two.
    const bars = (await ui.findAll({ type: 'Text', text: /^█+$/ })).map(x => x.text.length)
    expect(bars.length).toBeGreaterThan(6)
    expect((await ui.find({ type: 'Text', text: /notifications · trivial: 2 turns/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /waits 1\.2s before a prompt/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Effort Pilot pays for itself/ }))).toBeDefined()
    await ui.unmount()
  }
})

test('the pane\'s net is not clear while a compared phase\'s cost range spans zero', { options: { measure: true } }, async ($, on) => {
  disk(on, shaky())
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run(command)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^not clear yet: the cost range spans zero in 1 of 1 compared phase$/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /pays for itself|costs more than it saves/ }))).toBeUndefined()
  await ui.unmount()
})

test('the pane gives a listed agent type its own group, with its pilot and control counts', { options: { measure: true } }, async ($, on) => {
  const run = { who: 'agent', agent: 'lab:builder', via: 'listed' } as const
  disk(on, [...Array.from({ length: 3 }, () => turn(run)), ...Array.from({ length: 2 }, () => control(run))])
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run(command)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^agent lab:builder · implement/ }))?.text).toContain('3 pilot, 2 control turns')
  await ui.unmount()
})

test('refresh reads the records again', { options: { measure: true } }, async ($, on) => {
  const fs = disk(on, sample())
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run(command)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /^17 turns over/ }))).toBeDefined()
  fs.put(turn({ phase: 'plan', chosen: 'xhigh', sent: 'xhigh' }))
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /^18 turns over/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /your prompts · plan/ }))).toBeDefined()
  await ui.unmount()
})

test('where no pane can be placed, the report is the text, and the pane is not left waiting', { options: { measure: true } }, async ($, on) => {
  const records = sample()
  disk(on, records)
  const closed: string[] = []
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface: a run with no surface attached' } }))
  on('ui.close', (_$, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  const answer = await $.command.run(command)
  expect(answer.text).toBe(`${report(records)}\n\nrecords: ${STORE} (the last 90 days)`)
  expect(closed).toEqual(['effort-pilot-report'])
})

test('with no records, the pane says so', { options: { measure: true } }, async ($, on) => {
  disk(on, [])
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.command.run(command)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No turns recorded yet/ }))).toBeDefined()
  await ui.unmount()
})

test('a pane drawn before any read offers to read', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Not read yet/ }))).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'refresh' }))).toBeDefined()
  await ui.unmount()
})
