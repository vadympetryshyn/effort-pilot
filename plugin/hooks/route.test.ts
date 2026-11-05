import { describe, expect, test } from 'claude-code/testing'

import type { Route, Spend, Task, TurnRecord } from '../types'
import { afterPlan, cacheRewritten, carry, configFrom, DEFAULTS, effortFor, forAgent, forNotice, managed, midTurn, parse, parseRecords, perMessage, report, sameModel, SYSTEM, wholeRequest } from './route'
import type { Step } from './route'

const route = (phase: Route['phase'], effort: Route['effort'], extra: Partial<Route> = {}): Route => ({ phase, hard: false, effort, why: 'w', ...extra })
const task = (phase: Task['phase'], effort: Task['effort']): Task => ({ phase, hard: false, effort, text: 'the work' })

describe('effortFor', () => {
  test('plan xhigh, analyze high, build medium or high when hard, talk low', () => {
    expect(effortFor('plan', false)).toBe('xhigh')
    expect(effortFor('analyze', false)).toBe('high')
    expect(effortFor('implement', false)).toBe('medium')
    expect(effortFor('fix', true)).toBe('high')
    expect(effortFor('chat', false)).toBe('low')
    expect(effortFor('trivial', false, true)).toBe('xhigh')
  })
})

describe('carry', () => {
  test('a follow-up keeps the work\'s effort', () => {
    const r = carry(task('plan', 'xhigh'), route('trivial', 'low', { continues: true }), 'continue')
    expect(r.route.effort).toBe('xhigh')
    expect(r.route.kept).toBe(true)
    expect(carry(task('analyze', 'high'), route('analyze', 'high', { continues: true }), 'but would the same happen with two workers?').route.effort).toBe('high')
  })
  test('a question about a build takes its own effort; the build stays the work', () => {
    const r = carry(task('implement', 'high'), route('chat', 'low', { continues: true }), 'is coral the orange one?')
    expect(r.route.effort).toBe('low')
    expect(r.task.phase).toBe('implement')
  })
  test('a word to go on during a build keeps the build\'s effort', () => {
    for (const text of ['done', 'ok', 'continue']) {
      const r = carry(task('implement', 'medium'), route('trivial', 'low', { continues: true }), text)
      expect(r.route.effort).toBe('medium')
      expect(r.route.phase).toBe('implement')
      expect(r.route.kept).toBe(true)
      expect(r.task.phase).toBe('implement')
    }
    expect(carry(task('fix', 'high'), route('trivial', 'low', { continues: true }), 'go on').route.effort).toBe('high')
  })
  test('a question about a build still takes its own effort at the default build effort', () => {
    const r = carry(task('implement', 'medium'), route('chat', 'low', { continues: true }), 'which file holds the button?')
    expect(r.route.effort).toBe('low')
    expect(r.task.phase).toBe('implement')
    expect(r.task.effort).toBe('medium')
  })
  test('a question about an analysis takes its own effort; the analysis stays the work', () => {
    const r = carry(task('analyze', 'high'), route('chat', 'low', { continues: true }), 'so in plain words, what was the cause?')
    expect(r.route.effort).toBe('low')
    expect(r.route.kept).toBe(undefined)
    expect(r.task.phase).toBe('analyze')
  })
  test('a question about a plan takes its own effort; the plan stays the work', () => {
    const r = carry(task('plan', 'xhigh'), route('chat', 'low', { continues: true }), 'why so?')
    expect(r.route.effort).toBe('low')
    expect(r.task.phase).toBe('plan')
    expect(r.task.effort).toBe('xhigh')
  })
  test('a question that says the analysis fell short keeps its effort', () => {
    const r = carry(task('analyze', 'high'), route('chat', 'low', { continues: true, faulted: true }), 'that is not the cause, is it?')
    expect(r.route.effort).toBe('high')
    expect(r.route.kept).toBe(true)
  })
  test('restating the last answer (translate, shorten) takes its own light effort', () => {
    const pick = parse('{"phase":"chat","hard":false,"continues":true,"restate":true,"why":"translate"}')!
    expect(pick.continues).toBe(false)
    expect(carry(task('analyze', 'high'), pick, 'translate it').route.effort).toBe('low')
  })
  test('moving from planning to building takes the build\'s effort', () => {
    expect(carry(task('plan', 'xhigh'), route('implement', 'medium', { continues: true }), 'go').route.effort).toBe('medium')
    expect(carry(task('plan', 'xhigh'), route('implement', 'high', { hard: true, continues: true }), 'go').route.effort).toBe('medium')
    expect(carry(task('analyze', 'high'), route('fix', 'high', { hard: true, continues: true }), 'fix it').route.effort).toBe('high')
  })
  test('a side question gets its own effort and keeps the work under way', () => {
    const r = carry(task('analyze', 'high'), route('chat', 'low', { continues: false }), 'what is a mutex?')
    expect(r.route.effort).toBe('low')
    expect(r.task.phase).toBe('analyze')
  })
})

describe('an effort the person asks for', () => {
  test('it stands over the rule', () => {
    const pick = parse('{"phase":"implement","hard":false,"continues":false,"asked":"high","build":"none","why":"add a button"}')!
    expect(pick.effort).toBe('high')
    expect(pick.asked).toBe('high')
    expect(pick.build).toBe(undefined)
  })
  test('none, or a word that is not a level, asks for nothing', () => {
    const pick = parse('{"phase":"chat","hard":false,"continues":false,"asked":"hard","why":"q"}')!
    expect(pick.effort).toBe('low')
    expect(pick.asked).toBe(undefined)
  })
  test('the follow-ups of that work keep it', () => {
    const asked = carry(null, route('implement', 'xhigh', { asked: 'xhigh' }), 'do it on xhigh')
    expect(asked.task.asked).toBe('xhigh')
    expect(carry(asked.task, route('chat', 'low', { continues: true }), 'why so?').route.effort).toBe('xhigh')
  })
  test('a new task ends it', () => {
    const asked = carry(null, route('implement', 'xhigh', { asked: 'xhigh' }), 'do it on xhigh').task
    expect(carry(asked, route('chat', 'low', { continues: false }), 'what is a mutex?').route.effort).toBe('low')
  })
  test('the effort asked for the build carries out the plan', () => {
    const planning: Task = { ...task('plan', 'xhigh'), build: 'high' }
    expect(afterPlan('p', planning).route.effort).toBe('high')
    expect(carry(planning, route('implement', 'medium', { continues: true }), 'go').route.effort).toBe('high')
  })
  test('taking it back hands the effort to the rule again', () => {
    const asked = carry(null, route('implement', 'xhigh', { asked: 'xhigh' }), 'do it on xhigh').task
    const back = parse('{"phase":"implement","hard":false,"continues":true,"asked":"auto","why":"back to auto"}')!
    expect(back.release).toBe(true)
    expect(carry(asked, back, 'back to auto').route.effort).toBe('medium')
    expect(midTurn(asked, route('implement', 'xhigh'), back, 'back to auto')?.route?.effort).toBe('medium')
  })
  test('typed while the agent works, it takes effect at once, up or down', () => {
    const r = midTurn(task('implement', 'high'), route('implement', 'high'), route('implement', 'medium', { continues: true, asked: 'medium' }), 'medium is enough')
    expect(r?.route?.effort).toBe('medium')
    expect(r?.task.asked).toBe('medium')
  })
})

describe('a message typed while the agent works', () => {
  test('a question or correction about the work changes nothing', () => {
    expect(midTurn(task('implement', 'medium'), route('implement', 'medium'), route('analyze', 'high', { continues: true }), 'why this way?')).toBe(null)
  })
  test('a side remark or thanks changes nothing', () => {
    expect(midTurn(task('implement', 'medium'), route('implement', 'medium'), route('chat', 'low', { continues: false }), 'thanks')).toBe(null)
  })
  test('a new, harder task raises the turn and becomes the work', () => {
    const r = midTurn(task('chat', 'low'), route('chat', 'low'), route('analyze', 'high', { continues: false }), 'now find why login fails')
    expect(r?.route?.effort).toBe('high')
    expect(r?.task.phase).toBe('analyze')
  })
  test('a new, lighter task becomes the work but never lowers the turn', () => {
    const r = midTurn(task('plan', 'xhigh'), route('plan', 'xhigh'), route('implement', 'medium', { continues: false }), 'also add a button')
    expect(r?.route).toBe(null)
    expect(r?.task.phase).toBe('implement')
  })
})

describe('subagents, notifications, an approved plan', () => {
  test('a subagent thinks at least at medium', () => {
    expect(forAgent(route('trivial', 'low')).effort).toBe('medium')
    expect(forAgent(route('analyze', 'high')).effort).toBe('high')
  })
  test('a notification goes at the work it serves; with no work known, at its own pick', () => {
    expect(forNotice(null, task('implement', 'medium'))?.effort).toBe('medium')
    expect(forNotice(route('chat', 'low'), task('fix', 'high'))?.effort).toBe('high')
    expect(forNotice(route('chat', 'low'), null)?.effort).toBe('low')
    expect(forNotice(null, null)).toBe(null)
  })
  test('an approved plan is implementation at medium, always', () => {
    expect(afterPlan('p').route.effort).toBe('medium')
    expect(afterPlan('p').route.phase).toBe('implement')
  })
})

describe('report', () => {
  const cls: Spend = { calls: 1, input: 800, out: 40, cacheRead: 0, cacheWrite: 0, ms: 1000 }
  const base = {
    s: 'a', hard: false, chosen: 'medium', base: 'high', model: 'claude-opus-5-5', steps: 3, input: 10,
    cacheRead: 100_000, cacheWrite: 1000, ms: 1000, reason: 'answer', phase: 'implement', cls,
  } as const
  const records: TurnRecord[] = []
  let t = 0
  for (const who of [undefined, 'notification', 'agent'] as const) {
    for (const arm of ['auto', 'control'] as const) {
      for (let i = 0; i < 5; i++) {
        records.push({ ...base, t: t++, who, arm, sent: arm === 'auto' ? 'medium' : 'high', out: arm === 'auto' ? 800 : 1200, gen: arm === 'auto' ? 500 + i : 1000 + i })
      }
    }
  }
  test('groups by whose turn, old records as your prompts', () => {
    const out = report(records)
    expect(out).toContain('your prompts · implement')
    expect(out).toContain('notifications · implement')
    expect(out).toContain('subagents · implement')
  })
  test('the net takes the classifier\'s cost off the saving', () => {
    const out = report(records)
    expect(out).toContain('30 calls on 30 turns')
    expect(out).toContain('Effort Pilot pays for itself')
    expect(out).toContain('faster')
    const costly = records.map(r => ({ ...r, cls: { ...cls, input: 80_000_000 } }))
    expect(report(costly)).toContain('costs more than it saves')
  })
  test('each phase is judged on cost, model time and falling short, against high', () => {
    const out = report(records)
    expect(out).toContain('vs high')
    expect(out).toContain('cost a turn')
    expect(out).toContain('model time')
    expect(out).toContain('fell short')
  })
  test('a turn the person says fell short counts against its arm', () => {
    const later = records.filter(r => r.who === undefined).map((r, i) => ({ ...r, t: 1000 + i, s: 'b', faulted: i % 2 === 1 ? true as const : undefined }))
    expect(report(later)).toMatch(/fell short \d+%/)
  })
  test('turns at another own effort are left out', () => {
    expect(report(records.map(r => ({ ...r, base: 'medium' as const })))).toContain('none comparable')
  })
  test('a clear saving shows its range', () => {
    expect(report(records)).toContain('better with Effort Pilot: clear')
  })
  test('turns where the efforts agree are counted, not compared', () => {
    const same = records.map(r => ({ ...r, sent: 'high' as const, chosen: 'high' as const }))
    expect(report(same)).toContain('none comparable')
    expect(report(same)).toContain('net: not known yet')
  })
  test('turns marked as a test are left out', () => {
    const out = report([...records, ...records.map(r => ({ ...r, test: true as const }))])
    expect(out).toContain('30 turns over')
    expect(out).toContain('30 test or failed turns left out')
  })
  test('the range is wide when turns vary', () => {
    const noisy = records.map((r, i) => ({ ...r, out: (i % 3) * 5000 + 100 }))
    expect(report(noisy)).toContain('not clear yet')
  })
  test('no net until a phase has 5+ turns on each arm', () => {
    expect(report(records.slice(0, 3))).toContain('net: not known yet')
  })
})

describe('settings', () => {
  // The manifest's defaults, as /config stores them.
  const manifest = { planEffort: 'xhigh', analyzeEffort: 'high', buildEffort: 'medium', hardBuildEffort: 'high', talkEffort: 'low', managedModels: 'opus,fable', headless: false, measure: false, controlShare: 30 }
  test('the defaults are the table: plan xhigh, analyze high, build medium, hard build high, talk low', () => {
    expect(configFrom(manifest)).toEqual(DEFAULTS)
    expect(configFrom({})).toEqual(DEFAULTS)
    const c = configFrom(manifest)
    expect(effortFor('plan', false, false, c)).toBe('xhigh')
    expect(effortFor('analyze', false, false, c)).toBe('high')
    expect(effortFor('implement', false, false, c)).toBe('medium')
    expect(effortFor('fix', true, false, c)).toBe('high')
    expect(effortFor('chat', false, false, c)).toBe('low')
    expect(effortFor('trivial', false, false, c)).toBe('low')
    expect(effortFor('chat', false, true, c)).toBe('xhigh')
  })
  test('a value outside the levels falls back to its default', () => {
    expect(configFrom({ planEffort: 'huge', buildEffort: 3 }).plan).toBe('xhigh')
    expect(configFrom({ planEffort: 'huge', buildEffort: 3 }).build).toBe('medium')
  })
  test('a custom table moves every rule that reads it', () => {
    const c = configFrom({ ...manifest, planEffort: 'max', buildEffort: 'high', hardBuildEffort: 'xhigh', talkEffort: 'medium', analyzeEffort: 'xhigh' })
    expect(effortFor('plan', false, false, c)).toBe('max')
    expect(effortFor('implement', false, false, c)).toBe('high')
    expect(effortFor('fix', true, false, c)).toBe('xhigh')
    expect(effortFor('chat', false, false, c)).toBe('medium')
    expect(effortFor('analyze', false, false, c)).toBe('xhigh')
    expect(effortFor('chat', false, true, c)).toBe('max')
    expect(parse('{"phase":"implement","hard":false,"continues":false,"why":"add a button"}', c)?.effort).toBe('high')
    expect(afterPlan('p', null, c).route.effort).toBe('high')
    expect(afterPlan('p', null, c).route.why).toContain('planned at max')
    expect(carry(task('plan', 'max'), route('implement', 'high', { continues: true }), 'go', c).route.effort).toBe('high')
    expect(forAgent(route('trivial', 'medium'), c).effort).toBe('high')
  })
  test('the effort asked for in words still stands over a custom table', () => {
    const c = configFrom({ buildEffort: 'high' })
    expect(afterPlan('p', { ...task('plan', 'xhigh'), build: 'low' }, c).route.effort).toBe('low')
    expect(parse('{"phase":"implement","hard":false,"asked":"low","why":"q"}', c)?.effort).toBe('low')
  })
  test('managed models: words matched case-insensitively in the model name', () => {
    expect(managed('claude-opus-5-5')).toBe(true)
    expect(managed('Claude-Fable')).toBe(true)
    expect(managed('claude-sonnet-4-5')).toBe(false)
    expect(managed(null)).toBe(false)
    const c = configFrom({ managedModels: ' Sonnet , HAIKU ,' })
    expect(c.models).toEqual(['sonnet', 'haiku'])
    expect(managed('claude-sonnet-4-5', c)).toBe(true)
    expect(managed('claude-opus-5-5', c)).toBe(false)
    expect(managed('claude-opus-5-5', configFrom({ managedModels: '' }))).toBe(false)
  })
})

describe('turn records', () => {
  const good = JSON.stringify({ t: 1, s: 'a', arm: 'auto', phase: 'implement', hard: false, chosen: 'medium', base: 'high', sent: 'medium', model: 'claude-opus-5-5', steps: 2, out: 10, input: 1, cacheRead: 0, cacheWrite: 0, ms: 5, reason: 'answer' })
  test('a corrupt line is skipped, the rest read', () => {
    const text = `${good}\n{"t":2,"s":"a","arm":"au\nnot json\n[1,2]\n\n${good}\n`
    expect(parseRecords(text).length).toBe(2)
  })
  test('a line without what a turn is compared by is skipped; missing counts read as 0', () => {
    expect(parseRecords('{"t":1,"s":"a","arm":"auto"}').length).toBe(0)
    const [r] = parseRecords('{"t":1,"s":"a","arm":"control","phase":"chat","hard":false,"chosen":"low","base":"high","sent":"high","reason":"answer"}')
    expect(r?.out).toBe(0)
    expect(r?.model).toBe('')
    expect(report(parseRecords(good))).toContain('1 turns over')
  })
})

describe('perMessage', () => {
  test('the newer models on a first-party login take effort per message', () => {
    for (const m of ['claude-opus-5', 'claude-opus-5-5', 'claude-opus-5-5[1m]', 'claude-fable-5-1', 'claude-fable-5-1-20260301', 'claude-fable-5-1[1m]', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      expect(perMessage(m, true)).toBe(true)
    }
  })
  test('Claude 4.x and older take it per request', () => {
    for (const m of ['claude-opus-4-6', 'claude-opus-4-1-20250805', 'claude-opus-4-6[1m]', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229']) {
      expect(wholeRequest(m, true)).toBe('model')
    }
  })
  test('Fable 5 takes it per request, Fable 5.1 per message', () => {
    expect(wholeRequest('claude-fable-5', true)).toBe('model')
    expect(wholeRequest('claude-fable-5-20260101', true)).toBe('model')
    expect(wholeRequest('claude-fable-5[1m]', true)).toBe('model')
    expect(wholeRequest('claude-fable-5-1', true)).toBe(null)
    expect(wholeRequest('claude-fable-5-1-20260301', true)).toBe(null)
  })
  test('a provider id names the model the same way', () => {
    expect(wholeRequest('us.anthropic.claude-opus-4-1-20250805-v1:0', false)).toBe('model')
    expect(wholeRequest('claude-opus-4-1@20250805', false)).toBe('model')
  })
  test('without a first-party credential any model takes it per request', () => {
    expect(wholeRequest('claude-opus-5-5', false)).toBe('provider')
    expect(perMessage('claude-opus-5-5', true)).toBe(true)
  })
  test('a numeric effort goes per request, a level per message', () => {
    expect(wholeRequest('claude-opus-5-5', true, 32000)).toBe('number')
    expect(wholeRequest('claude-opus-5-5', true, 'high')).toBe(null)
  })
  test('an alias or a model not known here counts as per message', () => {
    expect(perMessage('opus', true)).toBe(true)
    expect(perMessage('claude-opus-6', true)).toBe(true)
    expect(perMessage('', true)).toBe(true)
  })
})

describe('sameModel', () => {
  test('case and a trailing tag do not make another model', () => {
    expect(sameModel('claude-opus-5-5[1m]', 'claude-opus-5-5')).toBe(true)
    expect(sameModel('Claude-Opus-5-5', 'claude-opus-5-5')).toBe(true)
  })
  test('another model, or one not known, is not the same', () => {
    expect(sameModel('claude-sonnet-5-5', 'claude-opus-5-5')).toBe(false)
    expect(sameModel('claude-opus-5-5', undefined)).toBe(false)
    expect(sameModel('', '')).toBe(false)
  })
})

describe('SYSTEM', () => {
  test('reads Claude Code\'s own keyword as asking for xhigh, never max', () => {
    expect(SYSTEM).toContain('The word "ultrathink" (Claude Code\'s own keyword) is asked xhigh, never max')
  })
})

describe('cacheRewritten', () => {
  const prev: Step = { model: 'claude-opus-5-5', effort: 'high', messageCount: 10, prompt: 50_000, cacheRead: 48_000, at: 1_000 }
  const cur = (extra: Partial<Step & { input: boolean }> = {}) => ({ ...prev, effort: 'low', messageCount: 12, prompt: 51_000, at: 31_000, input: true, ...extra })
  test('a switch that reads little from the cache marks the model', () => {
    expect(cacheRewritten(prev, cur({ cacheRead: 3_000 }))).toBe(true)
  })
  test('a switch that reads the cache marks nothing', () => {
    expect(cacheRewritten(prev, cur({ cacheRead: 49_000 }))).toBe(false)
  })
  test('a miss with no switch marks nothing', () => {
    expect(cacheRewritten(prev, cur({ effort: 'high', cacheRead: 0 }))).toBe(false)
  })
  test('a miss after a compaction, a long gap or on a small prompt marks nothing', () => {
    expect(cacheRewritten(prev, cur({ cacheRead: 0, messageCount: 3 }))).toBe(false)
    expect(cacheRewritten(prev, cur({ cacheRead: 0, at: prev.at + 5 * 60_000 }))).toBe(false)
    expect(cacheRewritten({ ...prev, prompt: 3_000, cacheRead: 2_000 }, cur({ cacheRead: 0 }))).toBe(false)
  })
  test('a miss where the cache was not read before, on another model, or on a step without new input marks nothing', () => {
    expect(cacheRewritten({ ...prev, cacheRead: 0 }, cur({ cacheRead: 0 }))).toBe(false)
    expect(cacheRewritten(prev, cur({ cacheRead: 0, model: 'claude-fable-5-1' }))).toBe(false)
    expect(cacheRewritten(prev, cur({ cacheRead: 0, input: false }))).toBe(false)
    expect(cacheRewritten(null, cur({ cacheRead: 0 }))).toBe(false)
  })
})
