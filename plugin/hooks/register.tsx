import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Config, Effort, Mode, Route, Spend, Tally, Task, TurnRecord, Who } from '../types'
import {
  afterPlan, briefPrompt, unasked, carry, configFrom, DEFAULTS, EFFORTS, forAgent, forNotice, managed as managedBy, midTurn, parse,
  parseRecords, prompt, recentOf, report, seedPrompt, SHORT, SYSTEM,
} from './route'

// The settings (userConfig), read once per load: a change in /config reloads the module with the new values.
let config: Config = DEFAULTS
// Measuring (control turns, turn records, the report) is off unless the person turns it on: most people want the
// effort set, not an experiment run on their turns.
let measuring = false
// The share of eligible turns left at the person's own effort while measuring, 0 to 1.
let controlShare = 0.3
// Steer headless sessions too (claude -p, the Agent SDK). Off by default: a script or pipeline expects the effort it set.
let headless = false
const managed = (model: string | null | undefined) => managedBy(model, config)

const mode = atom({ plugin: 'effort-pilot', key: 'mode' } as const, 'auto' as Mode)
const pin = atom({ plugin: 'effort-pilot', key: 'pin' } as const, null as Effort | null)
const route = atom({ plugin: 'effort-pilot', key: 'route' } as const, null, { shape: 'route-1' })
const trail = atom({ plugin: 'effort-pilot', key: 'trail' } as const, [], { shape: 'trail-1' })
const tally = atom({ plugin: 'effort-pilot', key: 'tally' } as const, {}, { shape: 'tally-1' })
const model = atom({ plugin: 'effort-pilot', key: 'model' } as const, '')
const latency = atom({ plugin: 'effort-pilot', key: 'latency' } as const, 0)
const lastAnswer = atom({ plugin: 'effort-pilot', key: 'lastAnswer' } as const, '')
const arm = atom({ plugin: 'effort-pilot', key: 'arm' } as const, 'auto' as 'auto' | 'control')
const EMPTY = {
  steps: 0, out: 0, input: 0, cacheRead: 0, cacheWrite: 0, gen: 0,
  base: null as Effort | null, sent: null as Effort | null, at: 0, trace: [] as [Effort | null, number][],
}
const task = atom({ plugin: 'effort-pilot', key: 'task' } as const, null as Task | null, { shape: 'task-1' })
const planMode = atom({ plugin: 'effort-pilot', key: 'planMode' } as const, false)
const NONE: Spend = { calls: 0, input: 0, out: 0, cacheRead: 0, cacheWrite: 0, ms: 0 }
const spend = atom({ plugin: 'effort-pilot', key: 'spend' } as const, NONE, { shape: 'spend-1' })
const effective = atom({ plugin: 'effort-pilot', key: 'effective' } as const, null, { shape: 'effective-1' })
const who = atom({ plugin: 'effort-pilot', key: 'who' } as const, 'person' as Who | null)
const agents = atom({ plugin: 'effort-pilot', key: 'agents' } as const, [], { shape: 'agents-1' })
// The effort in effect on the wire. Claude Code takes a new effort only on a request that carries new input (a
// turn's first, or the first after a message typed mid-turn); on tool-result steps the one in effect stays.
const wire = atom({ plugin: 'effort-pilot', key: 'wire' } as const, null as Effort | null)
// An effort asked for mid-turn (an approved plan, plan mode entered) that waits for the next input to take effect.
// Plan mode was on at some point of this main-loop turn: the turn records as a plan.
const planned = atom({ plugin: 'effort-pilot', key: 'planned' } as const, false)
const held = atom({ plugin: 'effort-pilot', key: 'held' } as const, null as Effort | null)
const acc = atom({ plugin: 'effort-pilot', key: 'acc' } as const, EMPTY, { shape: 'acc-3' })

/** Plan mode's effort: the plan effort, or the one the person asked for the planning. */
async function planLevel($: EngineInterface): Promise<Effort> {
  return (await read($, task))?.asked ?? config.plan
}
/** Publish the effort the next request goes at, or null when the person's own setting stands. */
async function publish($: EngineInterface) {
  const [m, p, r, a, name] = [await read($, mode), await read($, pin), await read($, route), await read($, arm), await read($, model)]
  const [w, h] = [await read($, wire), await read($, held)]
  const value = m !== 'auto' || !managed(name) ? null
    : h && w ? { effort: w, source: 'auto' as const }
    : p ? { effort: p, source: 'pinned' as const }
    : a === 'auto' && (await read($, planMode)) ? { effort: await planLevel($), source: 'auto' as const }
    : r && a === 'auto' ? { effort: r.effort, source: 'auto' as const }
    : null
  await update($, effective, () => value)
}
/**
 * Keep the engine's plan-mode fact. Plan mode is the plan effort, whole: entering it makes the work a plan (the band shows it),
 * and nothing typed while it lasts is classified. Leaving it by an approved plan is approved()'s.
 */
async function setPlan($: EngineInterface, isPlan: boolean) {
  if ((await read($, planMode)) === isPlan) return
  await update($, planMode, () => isPlan)
  if (isPlan) {
    await update($, planned, () => true)
    const t = await read($, task)
    // What the turn's prompt asked for (the planning's effort, the build's) holds through the plan.
    const effort = lastPick?.asked ?? config.plan
    await update($, task, () => ({
      phase: 'plan' as const, hard: false, effort, text: t?.text ?? '',
      ...(lastPick?.asked ? { asked: lastPick.asked } : {}), ...(lastPick?.build ? { build: lastPick.build } : {}),
    }))
    await update($, arm, () => 'auto' as const)
    // Through settle, so the status line, the trail and the band show it: the classic hook that reports plan mode
    // runs after prompt.submit has classified the prompt typed with it.
    await settle($, {
      phase: 'plan', hard: false, effort,
      why: `plan mode: ${lastPick?.asked ? `${effort}, as you asked` : effort} until you leave it${lastPick?.build ? ` · then ${lastPick.build}, as you asked` : ''}`,
    })
  }
  await publish($)
}

/** Route a turn that starts with this text: a person's prompt, a notification, or a message that waited in the queue. */
async function begin($: EngineInterface, text: string, kind: string) {
  const notice = NOTICE.has(kind)
  if (!routed(kind) || (await read($, mode)) === 'off') {
    await update($, who, () => null)
    return
  }
  // Pinned by hand: the effort is the person's, so a classification would be spent for nothing.
  if (!managed(await read($, model)) || (await read($, pin)) !== null) return
  await update($, who, () => (notice ? 'notification' : 'person') as Who)
  // Plan mode is the plan effort until it is left: nothing said in it is classified, and no turn in it is a control turn.
  if (await read($, planMode)) {
    await update($, arm, () => 'auto' as const)
    // Only what the person asks for: the planning's effort, or the build's once the plan is approved.
    const said = await classify($, text, true).catch(() => null)
    await asks($, said)
    await publish($)
    return
  }
  if (!notice) await seed($, text).catch(err => $.ui.log(`effort-pilot: could not read the session so far: ${String(err)}`))
  // A notification with work under way goes at that work's effort: nothing to classify.
  const work = await read($, task)
  const pick = notice && work ? null : await classify($, text, true, notice).catch(() => null)
  if (notice && work) await update($, latency, () => 0)
  const share0 = share()
  const carried = pick && !notice ? carry(work, pick, text, config) : null
  const next = notice ? forNotice(pick, work) : carried?.route ?? null
  lastPick = notice ? null : pick
  // A control turn only where the pilot would send another effort than the person's own: a turn where the two
  // agree runs the same either way and tells the comparison nothing.
  // An effort the person asked for is theirs: never a control turn.
  await update($, arm, () => (next && !next.asked && differs(next.effort) && Math.random() < share0 ? 'control' : 'auto'))
  if (carried) await update($, task, () => carried.task)
  if (next) await settle($, next)
  await publish($)
}

/** In plan mode: an effort the person asks for the planning takes effect, one for the build waits for the plan. */
async function asks($: EngineInterface, said: Route | null) {
  if (!said?.asked && !said?.build) return
  const t = await read($, task)
  if (!t) return
  await update($, task, () => ({ ...t, ...(said.asked ? { asked: said.asked, effort: said.asked } : {}), ...(said.build ? { build: said.build } : {}) }))
  const r = await read($, route)
  const level = said.asked ?? r?.effort ?? config.plan
  await settle($, { phase: 'plan', hard: false, effort: level, asked: said.asked, why: `plan mode: ${level}${said.asked ? ', as you asked' : ''}${(said.build ?? t.build) ? ` · then ${said.build ?? t.build}, as you asked` : ''}` })
}

// Measuring: a share of turns is left at the person's own effort (control), picked at random per turn; effort costs
// no cache on these models, so mixing them in one session is fair. Every turn is kept, one file a session.
const share = () => (measuring ? controlShare : 0)
/** Where turn records go; null with no home folder known, and then nothing is written. */
async function dir($: EngineInterface) {
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/effort-pilot/turns` : null
}
// The engine's file system has no append: a session's file is read and written whole. One file a session keeps it
// small (a record is about a kilobyte), well under the 4 MiB a read may take.
async function keep($: EngineInterface, r: TurnRecord) {
  if (!measuring) return
  const d = await dir($)
  if (!d) return
  const path = `${d}/${r.s}.jsonl`
  const before = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  await $.fs.write(path, `${before}${JSON.stringify(r)}\n`)
}
async function records($: EngineInterface): Promise<TurnRecord[]> {
  const d = await dir($)
  if (!d || !(await $.fs.exists(d))) return []
  const all: TurnRecord[] = []
  for (const f of await $.fs.list(d)) {
    if (!f.name.endsWith('.jsonl')) continue
    all.push(...parseRecords(await $.fs.read(`${d}/${f.name}`)))
  }
  return all
}

// Who may be routed: what a person typed, and the notifications that start a turn of their own (a background task
// finished, a scheduled prompt fired). A headless session (claude -p, the Agent SDK) is left alone unless the
// headless setting is on.
const LIVE = new Set(['composer', 'bridge'])
const NOTICE = new Set(['task-notification', 'scheduled-trigger'])
// Whether a person is at the prompt, as session.start or the last prompt's origin told; null until known (a module
// reloaded mid-session), then taken as interactive.
let interactive: boolean | null = null
const steered = () => headless || interactive !== false
function routed(kind: string) {
  if (LIVE.has(kind)) return true
  if (NOTICE.has(kind)) return steered()
  return kind === 'sdk' && headless
}

/** One Haiku call over the classifier's rules; its cost goes into the turn's record unless count is false. */
async function ask($: EngineInterface, text: string, count: boolean) {
  const started = await $.clock.now()
  const r = await $.model.complete({ model: 'haiku', effort: 'low', system: SYSTEM, prompt: text, maxTokens: 150, timeoutMs: 8000 })
  const took = Math.round((await $.clock.now()) - started)
  if (count) {
    const u = r.usage
    await update($, spend, c => ({
      calls: c.calls + 1, input: c.input + u.input_tokens, out: c.out + u.output_tokens,
      cacheRead: c.cacheRead + u.cache_read_input_tokens, cacheWrite: c.cacheWrite + u.cache_creation_input_tokens, ms: c.ms + took,
    }))
  }
  return { route: r.isAnswered ? parse(r.text, config) : null, took }
}

/**
 * The mod knows no work yet but the session has messages before this one (installed or reloaded mid-session,
 * or resumed): name the work under way from the session's last messages, once.
 */
async function seed($: EngineInterface, current: string) {
  if ((await read($, task)) !== null || (await read($, route)) !== null) return
  const found = recentOf(await $.session.messages(), current)
  if (!found) return
  const { route: r } = await ask($, seedPrompt(found.recent), true)
  if (found.answer) await update($, lastAnswer, () => found.answer)
  if (r) await update($, task, () => ({ phase: r.phase, hard: r.hard, effort: r.effort, text: found.request }))
}

/**
 * A message typed mid-turn has reached the agent. A question or a correction about the work under way changes nothing;
 * a new task becomes the work under way and raises the turn's effort to its own (never lowers it).
 */
async function delivered($: EngineInterface, kind: string, text: string) {
  if (!routed(kind) || (await read($, mode)) !== 'auto' || (await read($, pin)) !== null) return
  if (!managed(await read($, model)) || (await read($, who)) === null) return
  const pick = await classify($, text, true, false, true).catch(() => null)
  if (await read($, planMode)) {
    await asks($, pick)
    await publish($)
    return
  }
  // A control turn stays at the person's own effort unless they name one now.
  if ((await read($, arm)) !== 'auto' && !pick?.asked) return
  const took = pick ? midTurn(await read($, task), await read($, route), pick, text, config) : null
  if (!took) return
  if (took.route?.asked) await update($, arm, () => 'auto' as const)
  await update($, task, () => took.task)
  if (took.route) {
    await settle($, took.route)
    await publish($)
  }
}

/** count: false for /effort-pilot classify, a test the person runs by hand. */
async function classify($: EngineInterface, text: string, count = true, notice = false, midTurn = false): Promise<Route | null> {
  const { route: r, took } = await ask($, prompt(text, await read($, task), await read($, route), await read($, lastAnswer), notice, midTurn), count)
  await update($, latency, () => took)
  return r
}

async function settle($: EngineInterface, next: Route) {
  const before = await read($, route)
  await update($, route, () => next)
  await update($, trail, list => [...list, next].slice(-8))
  const m = await read($, mode)
  // A control turn runs at the person's own effort: the pick is only what the pilot would have sent.
  const control = m === 'auto' && (await read($, pin)) === null && (await read($, arm)) === 'control'
  $.ui.status(control
    ? `effort: your own (control turn) · Effort Pilot would pick ${SHORT[next.effort]} · ${next.phase}`
    : `effort${m === 'auto' ? '' : ` (${m})`}: ${label(next)}`)
  if (before && before.effort !== next.effort && m === 'auto' && !control) {
    $.ui.toast(`effort: ${SHORT[before.effort]} → ${label(next)}`)
  }
}

/** An effort asked for in words is dropped: the rule chooses again for the work under way. */
async function release($: EngineInterface) {
  const t = await read($, task)
  if (!t?.asked && !t?.build) return
  const back = unasked(t, config)
  await update($, task, () => back)
  const r = await read($, route)
  if (r?.asked) await settle($, { phase: back.phase, hard: back.hard, effort: back.effort, why: 'back to the rule' })
}

/** An approved plan moves the work from planning to building: the build effort, not the planning one. */
async function approved($: EngineInterface, plan: string) {
  if ((await read($, mode)) !== 'auto' || (await read($, pin)) !== null || !managed(await read($, model))) return
  const next = afterPlan(plan, await read($, task), config)
  await update($, task, () => next.task)
  await settle($, next.route)
}

/** How a route reads on the band, the status line and a toast: an effort the person asked for says so, not a phase. */
const label = (r: Route) => (r.asked ? `${SHORT[r.effort]} · you asked` : `${SHORT[r.effort]} ${r.phase}`)
const describe = (r: Route) => `${SHORT[r.effort]} ${r.phase}${r.hard ? ' (hard)' : ''}${r.continues ? ' (continues)' : ''}${r.kept ? ' (kept)' : ''} — ${r.why}`

// Subagents. Each starts on input of its own (its brief, or a message that wakes it), so an effort set on its first
// request holds for its run. Whoever already decided keeps the decision: an effort the Agent call names, an agent
// that is not a built-in (its definition is its author's), an effort that is not the session's own (declared).
// Only built-in agents that inherited the session's effort, on a managed model, are set: by their brief, not their type.
type Decision = {
  route: Route | null
  task: Task | null
  arm: 'auto' | 'control'
  source: AgentRun['source']
  type: string
  description: string
  checked: boolean
  acc: typeof EMPTY
  model: string
}
// A message typed mid-turn reaches the model on the next request: that request carries new input.
let freshInput = false
// The origin and text of messages typed mid-turn and not yet delivered: read once they reach the agent, inside the
// turn (turn.step) or as the next turn's prompt when the turn ends first (turn.start).
let queued: string | null = null
let waiting: string[] = []
// The classification of the prompt that started this turn: what it asked for holds if it enters plan mode.
let lastPick: Route | null = null
// A prompt.submit ran while the session was idle: the turn that follows is that prompt's, already routed.
let submitted = false
const byBrief = new Map<string, Decision>()
const byAgent = new Map<string, Decision>()
const explicit = new Set<string>()
// The session's own effort as the main loop last saw it (before the pilot's rewrite): what a subagent inherits.
let sessionEffort: string | undefined
// Measuring's one baseline is high: a control turn only where the person's own effort is high (unknown before the
// session's first request: taken as high) and the pilot would send another.
const differs = (effort: Effort) => (sessionEffort === undefined || sessionEffort === 'high') && effort !== 'high'

async function showAgent($: EngineInterface, id: string, d: Decision, status: AgentRun['status']) {
  const row: AgentRun = {
    id, type: d.type, description: d.description, status,
    effort: d.source === 'auto' ? (d.route?.effort ?? null) : null,
    source: d.source, why: d.route?.why ?? '',
  }
  await update($, agents, list => [...list.filter(a => a.id !== id), row].slice(-8))
}

async function keepAgent($: EngineInterface, d: Decision, reason: string) {
  const r = d.route
  if (!r || d.acc.steps === 0 || (d.source !== 'auto' && d.source !== 'control')) return
  await keep($, {
    t: await $.clock.now(), s: await $.session.id(), arm: d.arm, phase: r.phase, hard: r.hard, chosen: r.effort,
    base: d.acc.base, sent: d.acc.sent, model: d.model, steps: d.acc.steps, out: d.acc.out, input: d.acc.input,
    cacheRead: d.acc.cacheRead, cacheWrite: d.acc.cacheWrite, ms: Math.round((await $.clock.now()) - d.acc.at), reason,
    who: 'agent', agent: d.type, trace: d.acc.trace, gen: Math.round(d.acc.gen),
  })
}

function tallied(a: typeof EMPTY, sent: Effort | null, base: Effort | null, u: { output_tokens: number; input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, took: number) {
  return {
    ...a,
    steps: a.steps + 1,
    gen: (a.gen ?? 0) + took,
    out: a.out + u.output_tokens,
    input: a.input + u.input_tokens,
    cacheRead: a.cacheRead + u.cache_read_input_tokens,
    cacheWrite: a.cacheWrite + u.cache_creation_input_tokens,
    base: a.base ?? base,
    sent: a.sent ?? sent,
    trace: a.trace.length < 60 ? [...a.trace, [sent, u.output_tokens] as [Effort | null, number]] : a.trace,
  }
}

const level = (x: unknown): Effort | null => (typeof x === 'string' ? (EFFORTS.find(l => l === x) ?? null) : null)

export const register: Register = (on, options) => {
  config = configFrom(options)
  measuring = options.measure === true
  const pct = typeof options.controlShare === 'number' ? options.controlShare : 30
  controlShare = Math.min(100, Math.max(0, pct)) / 100
  headless = options.headless === true
  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive
    await $.command.register({
      name: 'effort-pilot',
      description: 'Effort Pilot: on | shadow | off | stats | report | classify <text>',
    })
    const name = (await $.session.model()) ?? ''
    await update($, model, () => name)
    return next(e)
  })

  on('command.run', { command: 'effort-pilot' }, async ($, e) => {
    const args = e.args.trim()
    const [verb = ''] = args.toLowerCase().split(/\s+/)
    // on also takes back an effort set by hand with /effort: one way to hand the effort back to the pilot.
    if (verb === 'on' || verb === 'auto') {
      await update($, mode, () => 'auto' as Mode)
      await update($, pin, () => null)
      await release($)
    } else if (verb === 'shadow' || verb === 'off') await update($, mode, () => verb as Mode)
    else if (verb === 'classify') {
      const r = await classify($, args.slice('classify'.length).trim(), false)
      return { text: r ? describe(r) : 'no answer from the classifier' }
    } else if (verb === 'report') {
      if (!measuring) return { text: 'measuring is off: no control turns, no turn records. Turn it on in /config: effort-pilot · measure.' }
      const d = await dir($)
      return { text: `${report(await records($))}\n\nrecords: ${d ?? 'none (no home folder known)'}` }
    } else if (verb === 'stats') {
      const t = await read($, tally)
      const rows = EFFORTS.filter(l => t[l]).map(l => `${l}: ${t[l]?.steps} requests, ${t[l]?.out} output tokens`)
      const turns = (await read($, trail)).map(describe)
      const subs = (await read($, agents)).map(a => `${a.type} «${a.description}»: ${a.effort ?? 'its own'} (${a.source}${a.status === 'running' ? ', running' : ''})${a.why ? ` — ${a.why}` : ''}`)
      return {
        text: [
          `turns:\n${turns.join('\n') || 'none yet'}`,
          `subagents:\n${subs.join('\n') || 'none yet'}`,
          `main-loop requests by effort:\n${rows.join('\n') || 'none yet'}`,
        ].join('\n\n'),
      }
    }
    await publish($)
    const p = await read($, pin)
    const measured = measuring ? ` · measuring, ${Math.round(controlShare * 100)}% control turns` : ''
    return { text: `Effort Pilot: ${await read($, mode)}${p ? `, pinned ${p}` : ''}${measured}` }
  })

  // A person who sets /effort by hand takes over until `/effort-pilot on` (or `/effort auto`).
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    const lv = e.args.trim().toLowerCase()
    const l = EFFORTS.find(x => x === lv)
    if (l) {
      await update($, pin, () => l)
      $.ui.toast(`Effort Pilot paused: you set ${l} (/effort-pilot on to resume)`)
    } else if (lv === 'auto') {
      await update($, pin, () => null)
      await release($)
    }
    await publish($)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e)
    const name = (await $.session.model()) ?? ''
    await update($, model, () => name)
    await publish($)
    return result
  }).catch(($, e, next) => next(e))

  // Classify each prompt a person sends, and each notification that starts a turn of its own, before the turn starts.
  // A message typed while a turn runs is not read: it waits in the queue, and once delivered it can change the effort
  // only for the rest of that turn, while the next prompt is classified anyway. It counts only as new input, the
  // moment Claude Code applies an effort asked for mid-turn. If the turn ends before it is delivered, it starts a turn
  // of its own, classified then (turn.start).
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'sdk') interactive = false
    else if (LIVE.has(e.origin.kind)) interactive = true
    if (e.turnId !== undefined) {
      if (!e.command && !e.isMeta && !NOTICE.has(e.origin.kind)) {
        freshInput = true
        queued = e.origin.kind
        waiting.push(e.text)
      }
      return next(e)
    }
    submitted = true
    if (e.command || e.isMeta) return next(e)
    await begin($, e.text, e.origin.kind)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Plan mode is the engine's fact: the permission mode it hands every classic hook, read before each turn. Within
  // a turn, plan mode ends when an ExitPlanMode call is approved (the classic PostToolUse of that call still reads
  // plan), and starts when EnterPlanMode runs.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await setPlan($, e.permission_mode === 'plan')
    return next(e)
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && !result.deny && !result.isError) {
      await approved($, result.text ?? '')
      await setPlan($, false)
      const r = await read($, route)
      if (r && r.effort !== (await read($, wire))) await update($, held, () => r.effort)
      await publish($)
    }
    return result
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'EnterPlanMode' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && !result.deny && !result.isError) {
      await setPlan($, true)
      const level = await planLevel($)
      if ((await read($, wire)) !== level) await update($, held, () => level)
      await publish($)
    }
    return result
  }).catch(($, e, next) => next(e))

  // A skill the main loop loads comes back as a message of its own beside the tool result: new input, so the next
  // request takes the effort asked for (an approved plan's effort takes effect as a skill loads).
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && !result.deny && !result.isError) freshInput = true
    return result
  }).catch(($, e, next) => next(e))

  // An Agent call that names its effort has decided: the spawn it makes is left alone.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.effort !== undefined && e.tool_use_id) explicit.add(e.tool_use_id)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    if (e.fork || e.workflow || e.isTeammate || (await read($, mode)) !== 'auto' || (await read($, pin)) !== null) return next(e)
    if (!steered()) return next(e)
    const resumed = e.resume ? byAgent.get(e.resume.agentId) : undefined
    const builtin = e.provider.plugin === 'engine'
    const named = explicit.has(e.tool_use_id)
    const d: Decision = {
      route: null, task: resumed?.task ?? null, arm: 'auto', source: 'own', type: e.subagentType,
      description: e.description, checked: false, acc: { ...EMPTY, at: await $.clock.now() }, model: '',
    }
    let description = e.description
    if (builtin && !named && e.prompt.trim()) {
      const { route: pick } = await ask($, briefPrompt(e.subagentType, e.description, e.prompt, d.task), true).catch(() => ({ route: null }))
      if (pick) {
        const carried = d.task ? carry(d.task, pick, e.prompt, config) : { route: pick, task: { phase: pick.phase, hard: pick.hard, effort: pick.effort, text: e.prompt } }
        d.route = forAgent(carried.route, config)
        d.task = carried.task
        d.arm = differs(d.route.effort) && Math.random() < share() ? 'control' : 'auto'
        d.source = d.arm === 'auto' ? 'auto' : 'control'
        // Shown on the agent's line in the transcript when it will hold: no model named, so the session's own.
        if (d.source === 'auto' && e.model === undefined && managed(e.parentModel)) description = `${e.description} · effort ${SHORT[d.route.effort]}`
      }
    }
    byBrief.set(e.prompt, d)
    const result = await next({ ...e, description })
    if (result.agentId) {
      byAgent.set(result.agentId, d)
      byBrief.delete(e.prompt)
      await showAgent($, result.agentId, d, 'running')
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      // No prompt.submit before this turn and a message still queued: the turn is that message's, read only now.
      const kind = queued
      queued = null
      waiting = []
      if (!submitted && kind && e.text.trim()) await begin($, e.text, kind)
      submitted = false
      const at = await $.clock.now()
      await update($, acc, () => ({ ...EMPTY, at }))
      const plan = await read($, planMode)
      await update($, planned, () => plan)
    } else if (!byAgent.has(e.agentId)) {
      const d = byBrief.get(e.text)
      if (d) {
        byAgent.set(e.agentId, d)
        byBrief.delete(e.text)
      }
    }
    return next(e)
  })

  // Every request of the main loop on a managed model goes at the turn's effort; a managed subagent's at its own.
  // The model is never changed.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const d = byAgent.get(e.agentId)
      if (!d) return yield* next(e)
      if (!d.checked) {
        d.checked = true
        d.model = e.model
        // A model the pilot leaves alone, or an effort that is not the one the session would hand down: declared.
        if (!managed(e.model)) d.source = 'skip'
        else if (sessionEffort !== undefined && e.effort !== sessionEffort) d.source = 'own'
        await showAgent($, e.agentId, d, 'running')
      }
      const effort = d.source === 'auto' ? d.route?.effort : undefined
      const began = await $.clock.now()
      const result = yield* next(effort ? { ...e, effort } : e)
      const took = (await $.clock.now()) - began
      if (result?.usage) d.acc = tallied(d.acc, effort ?? level(e.effort), level(e.effort), result.usage, took)
      return result
    }
    sessionEffort = typeof e.effort === 'string' ? e.effort : sessionEffort
    if ((await read($, model)) !== e.model) {
      await update($, model, () => e.model)
      await publish($)
    }
    // New input: the turn's first request, or one that carries a message typed before it was sent (one typed while
    // it runs waits for the next request).
    const input = e.index === 0 || freshInput
    if (input) freshInput = false
    if (input && e.index > 0) {
      const kind = queued
      const texts = waiting
      queued = null
      waiting = []
      // A message typed mid-turn goes with this request: read it now, so this request already goes at its effort.
      if (kind && texts.length) await delivered($, kind, texts.join('\n\n')).catch(err => $.ui.log(`effort-pilot: could not read the message typed mid-turn: ${String(err)}`))
    }
    const r = await read($, route)
    const p = await read($, pin)
    const live = (await read($, mode)) === 'auto' && managed(e.model) && e.effort !== undefined && (await read($, who)) !== null
      && (p !== null || (await read($, arm)) === 'auto')
    const effort = live ? (p ?? ((await read($, planMode)) ? await planLevel($) : r?.effort)) : undefined
    const began = await $.clock.now()
    const result = yield* next(effort ? { ...e, effort } : e)
    const took = (await $.clock.now()) - began
    const base = level(e.effort)
    // What actually went: the asked effort on a step with new input, else the one already in effect.
    if (input) {
      await update($, wire, () => effort ?? base)
      if ((await read($, held)) !== null) {
        await update($, held, () => null)
        await publish($)
      }
    }
    const sent = (await read($, wire)) ?? effort ?? base
    const u = result?.usage
    if (u) await update($, acc, a => tallied(a, sent, base, u, took))
    if (sent && u && managed(e.model)) {
      await update($, tally, t => ({ ...t, [sent]: { steps: (t[sent]?.steps ?? 0) + 1, out: (t[sent]?.out ?? 0) + u.output_tokens } }))
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      const d = byAgent.get(e.agentId)
      if (d) {
        await keepAgent($, d, e.reason).catch(err => $.ui.log(`effort-pilot: could not keep the subagent run: ${String(err)}`))
        await showAgent($, e.agentId, d, 'done')
        d.acc = { ...EMPTY, at: await $.clock.now() }
      }
      return result
    }
    const faulted = lastPick?.faulted
    lastPick = null
    await update($, lastAnswer, () => result.text.slice(-1500))
    const r = await read($, route)
    const a = await read($, acc)
    const m = await read($, model)
    const w = await read($, who)
    const cls = await read($, spend)
    await update($, spend, () => NONE)
    // Only turns the pilot routed and classified, and not pinned by hand.
    if (r && w && a.steps > 0 && managed(m) && (await read($, mode)) === 'auto' && (await read($, pin)) === null) {
      const plan = await read($, planned)
      await keep($, {
        t: await $.clock.now(), s: await $.session.id(), arm: await read($, arm),
        phase: plan ? 'plan' : r.phase, hard: r.hard, chosen: plan ? config.plan : r.effort,
        base: a.base, sent: a.sent, model: m, steps: a.steps, out: a.out, input: a.input,
        cacheRead: a.cacheRead, cacheWrite: a.cacheWrite, ms: Math.round((await $.clock.now()) - a.at), reason: e.reason, cls,
        who: w, trace: a.trace, gen: Math.round(a.gen), ...(faulted ? { faulted: true } : {}), ...(r.asked ? { asked: true as const } : {}),
      }).catch(err => $.ui.log(`effort-pilot: could not keep the turn: ${String(err)}`))
    }
    return result
  })

  // The band above the prompt: the effort now, how it got here, and why; then the subagents and theirs.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const current = await read($, model)
    const r = await read($, route)
    const m = await read($, mode)
    const { Box, Text } = $.ui.resolve(e)
    const below = await next(e)
    if (!managed(current)) {
      if (r === null) return below
      return (
        <Box flexDirection="column">
          <Text dimColor>⏵ Effort Pilot: off on {current} (it manages {config.models.join(', ') || 'no models'}) — set effort yourself</Text>
          {below}
        </Box>
      )
    }
    if (r === null) return below
    const [list, p, ms, w, subs] = [await read($, trail), await read($, pin), await read($, latency), await read($, who), await read($, agents)]
    const shown = subs.filter(a => a.status === 'running').concat(subs.filter(a => a.status === 'done')).slice(0, 4)
    const word = (a: AgentRun) => a.source === 'auto' && a.effort ? SHORT[a.effort] : a.source === 'control' ? 'inherited (control)' : a.source === 'skip' ? 'not managed' : 'its own'
    // A control turn goes at the person's own effort: say that effort first, and the pilot's pick only as what it
    // would have been, so the pick is never read as the effort in force.
    if (m === 'auto' && !p && (await read($, arm)) === 'control') {
      // The session's own setting as the last request carried it; before any request, the one last in effect.
      const own = sessionEffort ?? (await read($, wire))
      return (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text bold color="claude">⏵ effort{own ? ` ${SHORT[own as keyof typeof SHORT] ?? own}` : ''}</Text>
            <Text color="warning">control turn: your own effort, not Effort Pilot's (a share of turns, to measure it)</Text>
          </Box>
          <Text dimColor>Effort Pilot would pick {SHORT[r.effort]} {r.phase} · {r.why}</Text>
          {below}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold color="claude">⏵ effort{m !== 'auto' ? ` (${m})` : ''}{p ? ` (pinned ${p})` : ''}</Text>
          {list.slice(-6).map((x, i, all) => (
            <Text key={`t${i}`} dimColor={i < all.length - 1} bold={i === all.length - 1}>
              {i > 0 ? '→ ' : ''}{label(x)}
            </Text>
          ))}
        </Box>
        {(await read($, held)) ? (
          <Text color="warning">
            running at {SHORT[(await read($, wire)) ?? 'high']} for now · {SHORT[(await read($, held))!]} from the next new input (your message, or a skill loading): Claude Code switches effort only then
          </Text>
        ) : null}
        <Text dimColor>{(await read($, planMode)) ? `plan mode → ${SHORT[await planLevel($)]} · ` : ''}{w === 'notification' ? 'notification · ' : ''}{r.why}{ms ? ` · classified in ${(ms / 1000).toFixed(1)}s` : ''}</Text>
        {shown.length ? (
          <Text dimColor>
            subagents: {shown.map(a => `${a.type} «${a.description.slice(0, 28)}» ${word(a)}${a.status === 'done' ? ' ✓' : ''}`).join(' · ')}
          </Text>
        ) : null}
        {below}
      </Box>
    )
  })
}
