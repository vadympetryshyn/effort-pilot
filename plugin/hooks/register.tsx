import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Config, Effort, Mode, Route, Spend, Tally, Task, TurnRecord, Who } from '../types'
import {
  afterPlan, asideText, briefPrompt, cacheRewritten, commandText, unasked, carry, configFrom, DEFAULTS, EFFORTS, flagOn, forAgent, forNotice, listedAgent, managed as managedBy,
  midTurn, noticeOf, parse, parseRecords, prompt, promptOf, recentOf, report, reportData, sameModel, seedPrompt, SHORT, SYSTEM, wholeRequest,
} from './route'
import type { Aside, Step } from './route'
import { board as drawBoard, PANE, PANE_TITLE } from './board'
import { bySlot, dataDir, fresh, KEEP_DAYS, legacyDir, pack, slotFile, stale } from './store'

// The settings (userConfig), read once per load: a change in /config reloads the module with the new values.
let config: Config = DEFAULTS
// Measuring (control turns, turn records, the report) is off unless the person turns it on: most people want the
// effort set, not an experiment run on their turns.
let measuring = false
// The share of eligible turns left at the person's own effort while measuring, 0 to 1.
let controlShare = 0.3
// Steer headless sessions too (claude -p, the Agent SDK). Off by default: a script or pipeline expects the effort it set.
let headless = false
// Whether the session holds a first-party Anthropic credential: read once a process (a /clear keeps the process, a
// reload asks again); undefined until read, and taken as first-party until then.
let firstParty: boolean | undefined
async function credential($: EngineInterface) {
  if (firstParty !== undefined) return
  firstParty = await $.session.authorize().then(a => a !== null, err => {
    $.ui.log(`effort-pilot: could not read the session's credential: ${String(err)}`)
    return true
  })
}
// Models a switch was seen to rewrite the prompt cache on, in this process (cacheRewritten): left to the person.
const rewrites = new Set<string>()
/** Why the pilot stands aside on a model the settings name; null where it sets the effort. */
function aside(model: string | null | undefined): Aside | null {
  if (!managedBy(model, config)) return null
  if (rewrites.has(model ?? '')) return 'usage'
  return wholeRequest(model, firstParty !== false, sessionEffort)
}
// A model the settings name, where the effort goes per message: a switch there costs no prompt cache. Elsewhere it is
// one setting of the whole request, every switch rewrites the conversation's cache, and the person's own effort stands.
const managed = (model: string | null | undefined) => managedBy(model, config) && aside(model) === null

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
// turn's first, the first after a message typed mid-turn, a skill loading, a user-side line a plugin adds); on steps
// whose only new input is tool results the one in effect stays.
const wire = atom({ plugin: 'effort-pilot', key: 'wire' } as const, null as Effort | null)
// Plan mode was on at some point of this main-loop turn: the turn records as a plan.
const planned = atom({ plugin: 'effort-pilot', key: 'planned' } as const, false)
const acc = atom({ plugin: 'effort-pilot', key: 'acc' } as const, EMPTY, { shape: 'acc-3' })
// The report the pane draws, as read when it opened or was last refreshed.
const board = atom({ plugin: 'effort-pilot', key: 'board' } as const, null, { shape: 'board-1' })

/** Plan mode's effort: the plan effort, or the one the person asked for the planning. */
async function planLevel($: EngineInterface): Promise<Effort> {
  return (await read($, task))?.asked ?? config.plan
}
/**
 * The main loop's model, as session.start, /model or the last request set it. A session that began with no
 * session.start (a /clear: the same process goes on under a new session id, its state empty) asks the engine once.
 */
async function modelOf($: EngineInterface) {
  const known = await read($, model)
  if (known) return known
  const name = (await $.session.model()) ?? ''
  if (name) await update($, model, () => name)
  return name
}
// The person's say over the pilot (off or shadow, or an effort set by hand with /effort), carried over a /clear: the
// new conversation starts with empty state and no session.start, while Claude Code keeps the effort they set. A new
// process starts at auto.
let cleared: { from: string; mode: Mode; pin: Effort | null } | null = null
/** In the conversation a /clear started: take back the person's mode and pin from the one it ended. */
async function resume($: EngineInterface) {
  if (!cleared || (await $.session.id()) === cleared.from) return
  const { mode: m, pin: p } = cleared
  cleared = null
  await update($, mode, () => m)
  await update($, pin, () => p)
}
/** Publish the effort the next request goes at, or null when the person's own setting stands. */
async function publish($: EngineInterface) {
  const [m, p, r, a, name] = [await read($, mode), await read($, pin), await read($, route), await read($, arm), await read($, model)]
  const value = m !== 'auto' || !managed(name) ? null
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
    turnPlan = { effort, asked: !!lastPick?.asked }
    await settle($, {
      phase: 'plan', hard: false, effort, ...(lastPick?.asked ? { asked: lastPick.asked } : {}),
      why: `plan mode: ${lastPick?.asked ? `${effort}, as you asked` : effort} until you leave it${lastPick?.build ? ` · then ${lastPick.build}, as you asked` : ''}`,
    })
  }
  await publish($)
}

/**
 * Route a turn that starts with this text: a person's prompt, a notification, or a message that waited in the queue.
 * handBack: the engine marked the notification meta (a subagent's hand-back), the result of a finished task.
 */
async function begin($: EngineInterface, text: string, kind: string, handBack = false) {
  const notice = NOTICE.has(kind)
  await credential($)
  if (!routed(kind) || (await read($, mode)) === 'off') {
    await update($, who, () => null)
    return
  }
  // Pinned by hand: the effort is the person's, so a classification would be spent for nothing.
  const name = await modelOf($)
  const why = aside(name)
  if (why) $.ui.status(`effort: your own · ${asideText(name, why)}`)
  if (!managed(name) || (await read($, pin)) !== null) return
  await update($, who, () => (notice ? 'notification' : 'person') as Who)
  // Plan mode is the plan effort until it is left: nothing said in it is classified, and no turn in it is a control turn.
  if (await read($, planMode)) {
    await update($, arm, () => 'auto' as const)
    // Only what the person asks for: the planning's effort, or the build's once the plan is approved.
    const said = await classify($, text, true).catch(() => null)
    turnPick = said
    await asks($, said)
    await publish($)
    return
  }
  if (!notice && (await briefed($, text))) return
  if (!notice) await seed($, text).catch(err => $.ui.log(`effort-pilot: could not read the session so far: ${String(err)}`))
  const work = await read($, task)
  const pick = await classify($, text, true, notice).catch(() => null)
  const share0 = share()
  const carried = pick && !notice ? carry(work, pick, text, config) : null
  const envelope = noticeOf(text)
  const next = notice ? forNotice(pick, work, handBack ? { ...envelope, finished: true } : envelope, config) : carried?.route ?? null
  lastPick = notice ? null : pick
  turnPick = pick
  // A control turn only where the pilot would send another effort than the person's own: a turn where the two
  // agree runs the same either way and tells the comparison nothing.
  // An effort the person asked for is theirs: never a control turn.
  await update($, arm, () => (next && !next.asked && differs(next.effort) && Math.random() < share0 ? 'control' : 'auto'))
  if (carried) await update($, task, () => carried.task)
  if (next) await settle($, next)
  await publish($)
}

// The agent the main loop runs as in a session started with --agent, as the engine's classic SessionStart says it.
let mainAgent = ''
/**
 * The agent a headless session runs as (`claude -p --agent <type>`): the sessionAgent setting where a launcher sets it,
 * else the engine's word; empty in an interactive session, where a person talks to the agent.
 */
const sessionAgent = () => (interactive === false ? config.sessionAgent || mainAgent : '')
/**
 * In a headless session run as an agent, its first input (nothing routed yet, nothing said before it) is that agent's
 * brief, not a person's message: classified as a subagent's brief and held at least at the build effort, as one is.
 * Later inputs (a notification, a resumed session's message) are routed as anyone's. True when it routed the input.
 */
async function briefed($: EngineInterface, text: string) {
  const type = sessionAgent()
  if (!type || (await read($, task)) !== null || (await read($, route)) !== null) return false
  if (recentOf(await $.session.messages().catch(() => []), text)) return false
  const { route: pick } = await ask($, briefPrompt(type, '', text, null, await noUltrathink($)), true).catch(() => ({ route: null }))
  turnPick = pick
  lastPick = null
  if (!pick) return true
  const next = forAgent(pick, config)
  await update($, who, () => 'agent' as Who)
  await update($, arm, () => (!next.asked && differs(next.effort) && Math.random() < share() ? 'control' : 'auto'))
  await update($, task, () => ({ phase: pick.phase, hard: pick.hard, effort: next.effort, text, ...(pick.asked ? { asked: pick.asked } : {}), ...(pick.build ? { build: pick.build } : {}) }))
  await settle($, next)
  await publish($)
  return true
}

/** In plan mode: an effort the person asks for the planning takes effect, one for the build waits for the plan. */
async function asks($: EngineInterface, said: Route | null) {
  if (!said?.asked && !said?.build) return
  const t = await read($, task)
  if (!t) return
  await update($, task, () => ({ ...t, ...(said.asked ? { asked: said.asked, effort: said.asked } : {}), ...(said.build ? { build: said.build } : {}) }))
  const r = await read($, route)
  const level = said.asked ?? r?.effort ?? config.plan
  if (said.asked) turnPlan = { effort: said.asked, asked: true }
  await settle($, { phase: 'plan', hard: false, effort: level, asked: said.asked, why: `plan mode: ${level}${said.asked ? ', as you asked' : ''}${(said.build ?? t.build) ? ` · then ${said.build ?? t.build}, as you asked` : ''}` })
}

// Measuring: a share of turns is left at the person's own effort (control), picked at random per turn; effort costs
// no cache on these models, so mixing them in one session is fair. Every turn is kept, in the plugin's data folder
// (store.ts: one file a day, KEEP_DAYS days kept, removed with the plugin).
const share = () => (measuring ? controlShare : 0)
/** Where turn records go; null when neither the plugin's root nor the home folder places it, and then nothing is written. */
async function dir($: EngineInterface) {
  const d = dataDir($.plugin.root, $.plugin.name, await $.env.get('HOME'))
  return d ? `${d}/turns` : null
}
const legacy = async ($: EngineInterface) => legacyDir(await $.env.get('HOME'))
/** The record files of a folder, as listed; none when it does not exist. */
async function files($: EngineInterface, d: string | null) {
  if (!d || !(await $.fs.exists(d))) return []
  return (await $.fs.list(d)).filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
}
const readOr = ($: EngineInterface, path: string) => $.fs.read(path).then(t => (typeof t === 'string' ? t : ''), () => null)

// Records a 1.0 install kept, one file a session outside the data folder, move in once a load: those within
// KEEP_DAYS into their day files, then their files are emptied (the engine cannot delete). One it cannot read stays.
let moved = false
async function migrate($: EngineInterface, d: string) {
  if (moved) return
  moved = true
  const old = await legacy($)
  const now = await $.clock.now()
  for (const f of await files($, old)) {
    if (f.size === 0) continue
    const path = `${old}/${f.name}`
    const text = await readOr($, path)
    if (text === null) continue
    for (const [slot, lines] of bySlot(text, now)) {
      const target = `${d}/${slot}`
      const before = (await $.fs.exists(target)) ? ((await readOr($, target)) ?? '') : ''
      await $.fs.write(target, pack(`${before}${lines}`))
    }
    await $.fs.write(path, '')
  }
}

// The engine's file system has no append: a day's file is read and written whole. Writes of one load go one at a time.
let writing: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = writing.then(work)
  writing = run.catch(() => undefined)
  return run
}
function keep($: EngineInterface, r: TurnRecord): Promise<void> {
  if (!measuring) return Promise.resolve()
  return serial(async () => {
    const d = await dir($)
    if (!d) return
    await migrate($, d)
    const path = `${d}/${slotFile(r.t)}`
    const before = (await $.fs.exists(path)) ? ((await readOr($, path)) ?? '') : ''
    await $.fs.write(path, pack(`${before}${JSON.stringify(r)}\n`))
    for (const f of await files($, d)) if (`${d}/${f.name}` !== path && stale(f, r.t)) await $.fs.write(`${d}/${f.name}`, '')
  })
}
async function records($: EngineInterface): Promise<TurnRecord[]> {
  const d = await dir($)
  if (!d) return []
  await serial(() => migrate($, d))
  const now = await $.clock.now()
  const all: TurnRecord[] = []
  for (const f of await files($, d)) all.push(...parseRecords((await readOr($, `${d}/${f.name}`)) ?? '').filter(r => fresh(r.t, now)))
  return all
}
/** Reads the records for the report and keeps their read for the pane. */
async function readReport($: EngineInterface) {
  const d = await dir($)
  const all = await records($)
  const where = `records: ${d ?? 'none (no home folder known)'} (the last ${KEEP_DAYS} days)`
  await update($, board, () => ({ data: reportData(all), where }))
  return { records: all, where }
}
/** Empties every records file, the data folder's and a 1.0 install's: the number of turns it held. */
async function reset($: EngineInterface) {
  let cleared = 0
  for (const d of [await dir($), await legacy($)]) {
    for (const f of await files($, d)) {
      if (f.size === 0) continue
      cleared += parseRecords((await readOr($, `${d}/${f.name}`)) ?? '').length
      await $.fs.write(`${d}/${f.name}`, '')
    }
  }
  return cleared
}

// Who may be routed: what a person typed, and the notifications that start a turn of their own (a background task
// finished, a scheduled prompt fired, another Claude session's message). A headless session (claude -p, the Agent SDK)
// is left alone unless the headless setting is on.
const LIVE = new Set(['composer', 'bridge'])
const NOTICE = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message'])
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
  if (!managed(await modelOf($)) || (await read($, who)) === null) return
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

// Whether the person turned Claude Code's "ultrathink" keyword off (CLAUDE_CODE_DISABLE_ULTRATHINK): read once a load.
let ultrathinkOff: boolean | null = null
async function noUltrathink($: EngineInterface) {
  if (ultrathinkOff === null) ultrathinkOff = flagOn(await $.env.get('CLAUDE_CODE_DISABLE_ULTRATHINK').catch(() => undefined))
  return ultrathinkOff
}

/** count: false for /effort-pilot classify, a test the person runs by hand. */
async function classify($: EngineInterface, text: string, count = true, notice = false, midTurn = false): Promise<Route | null> {
  const { route: r, took } = await ask($, prompt(text, await read($, task), await read($, route), await read($, lastAnswer), notice, midTurn, await noUltrathink($)), count)
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

/** The effort the pilot sets on the main loop's next request on this model; undefined where the person's own stands. */
async function aim($: EngineInterface, name: string): Promise<Effort | undefined> {
  const p = await read($, pin)
  const live = (await read($, mode)) === 'auto' && managed(name) && (await read($, who)) !== null
    && (p !== null || (await read($, arm)) === 'auto')
  if (!live) return undefined
  return p ?? ((await read($, planMode)) ? await planLevel($) : (await read($, route))?.effort)
}

/**
 * An effort a tool call changed (a plan approved, plan mode entered) would wait through the steps whose only new input
 * is tool results. A user-side line after the result is new input, as a skill's body is: the next request takes the
 * effort. Only when that request goes at another effort than the one in effect. A context line does not do it: it
 * goes as a system message, not new input.
 */
async function applyNow($: EngineInterface, purpose: string) {
  const [w, next] = [await read($, wire), await aim($, await read($, model))]
  if (!w || !next || next === w) return
  const text = `Effort Pilot: reasoning effort is now ${next}, ${purpose}.`
  // Never throws: the tool has already run, and the hook must hand back its result.
  const added = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(err => ({ deny: String(err) }))
  if (added.deny) $.ui.log(`effort-pilot: ${next} waits for the next new input: ${added.deny}`)
  else freshInput = true
}

/**
 * A switch of effort was seen to rewrite the prompt cache on this model: it takes effort per request here. From the
 * next request the person's own effort stands, for the rest of the process (a wrong mark lasts one session).
 */
async function rewrote($: EngineInterface, name: string, prev: Step, cur: Step) {
  rewrites.add(name)
  $.ui.log(`effort-pilot: on ${name} a switch from ${prev.effort} to ${cur.effort} read ${cur.cacheRead} of the ${prev.prompt} prompt tokens before it from the cache: effort is one setting per request here; your own effort stands from the next request`)
  $.ui.toast(`Effort Pilot: ${asideText(name, 'usage')}`)
  $.ui.status(`effort: your own · ${asideText(name, 'usage')}`)
  await publish($)
}

/** An approved plan moves the work from planning to building: the build effort, not the planning one. */
async function approved($: EngineInterface, plan: string) {
  if ((await read($, mode)) !== 'auto' || (await read($, pin)) !== null || !managed(await modelOf($))) return
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
// An agent type the person lists (the agents setting) is set by its brief like a built-in, over an effort its own
// definition declares: listing it is their choice over its author's. The Agent call's effort and
// CLAUDE_CODE_SUBAGENT_EFFORT still win.
type Decision = {
  route: Route | null
  /** The classifier's own pick for the brief, before the rules after it. */
  pick: Route | null
  task: Task | null
  arm: 'auto' | 'control'
  source: AgentRun['source']
  type: string
  description: string
  checked: boolean
  /** Its type is in the agents setting: steered by its brief over its own effort, and reported in a group of its own. */
  listed: boolean
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
// The effort plan mode aimed in the main loop's running turn, and whether the person asked for it: the turn's record
// keeps it, though an approved plan moves the work on to the build effort before the turn ends. Null in a turn with no
// plan mode.
let turnPlan: { effort: Effort; asked: boolean } | null = null
// The classifier's own pick for the message that started this turn (a notification's too), before the rules after it:
// the turn's record keeps it beside the effort the rules sent.
let turnPick: Route | null = null
// A prompt.submit ran while the session was idle: the turn that follows is that prompt's, already routed.
let submitted = false
// The main loop's running turn, from its turn.start to its turn.complete; null while the main loop is idle. A prompt
// submitted while only a subagent runs carries that subagent's turn id, yet starts a main-loop turn of its own.
let mainTurn: string | null = null
// A slash command the person typed, from its prompt.submit until the engine expands it for the model (skill.prompt):
// a skill or prompt command, routed then from its line as typed. A built-in that runs on its own (/clear, /model) raises
// no prompt.submit, and one that is never expanded is never routed. Cleared as its turn starts.
let typed: { name: string; text: string; args: string; kind: string } | null = null
/**
 * A typed command the engine did not expand for the model is not routed: whatever turn it starts is no one's the pilot
 * read, so the last turn's `who` must not label it, and the person's own effort stands for it.
 */
async function unrouted($: EngineInterface) {
  if (!typed) return
  typed = null
  await update($, who, () => null)
}
const byBrief = new Map<string, Decision>()
const byAgent = new Map<string, Decision>()
const explicit = new Set<string>()
// The session's own effort as the main loop last saw it (before the pilot's rewrite), and its model: what a subagent
// on that model inherits. One on another model starts at that model's saved effort or its default.
let sessionEffort: string | number | undefined
let sessionModel: string | undefined
// The main loop's last request, for the cache check (cacheRewritten).
let lastStep: Step | null = null
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
    who: 'agent', agent: d.type, ...(d.listed ? { via: 'listed' as const } : {}), trace: d.acc.trace, gen: Math.round(d.acc.gen), ...(r.asked ? { asked: true as const } : {}),
    ...picked(d.pick, r),
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

/**
 * What a record keeps of how its effort was reached: the classifier's own pick and whether the rules kept the work's
 * effort over it. Not the why: the classifier words it from the prompt, and records hold no prompt text.
 */
const picked = (pick: Route | null, r: Route) => ({
  ...(pick ? { pick: { phase: pick.phase, hard: pick.hard } } : {}), ...(r.kept ? { kept: true as const } : {}),
})

const level = (x: unknown): Effort | null => (typeof x === 'string' ? (EFFORTS.find(l => l === x) ?? null) : null)

export const register: Register = (on, options) => {
  config = configFrom(options)
  measuring = options.measure === true
  const pct = typeof options.controlShare === 'number' ? options.controlShare : 30
  controlShare = Math.min(100, Math.max(0, pct)) / 100
  headless = options.headless === true
  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive
    await credential($)
    await $.command.register({
      name: 'effort-pilot',
      description: 'Effort Pilot: on | shadow | off | stats | report | reset | classify <text>',
    })
    const name = (await $.session.model()) ?? ''
    await update($, model, () => name)
    return next(e)
  })

  // The main loop's agent in a session started with --agent: the classic event names it on the main thread (no agent_id).
  on('classic.SessionStart', async ($, e, next) => {
    if (e.agent_id === undefined) mainAgent = e.agent_type ?? ''
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    // A conversation cleared before anything ran in it still holds the choice carried into it.
    await resume($)
    if (e.reason === 'clear') cleared = { from: e.sessionId, mode: await read($, mode), pin: await read($, pin) }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'effort-pilot' }, async ($, e) => {
    await resume($)
    await credential($)
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
      const all = await readReport($)
      // A pane beside the chat where a surface draws one; else (claude -p, a surface that places none) the text.
      const opened = await $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => null)
      if (opened?.isPlaced) return { text: 'report opened beside the chat' }
      if (opened) await $.ui.close({ id: PANE }).catch(() => undefined)
      return { text: `${report(all.records)}\n\n${all.where}` }
    } else if (verb === 'reset') {
      const n = await serial(() => reset($))
      return { text: n ? `Effort Pilot: cleared ${n} turn records` : 'Effort Pilot: no turn records to clear' }
    } else if (verb === 'stats') {
      const name = await modelOf($).catch(() => '')
      const why = aside(name)
      const t = await read($, tally)
      const rows = EFFORTS.filter(l => t[l]).map(l => `${l}: ${t[l]?.steps} requests, ${t[l]?.out} output tokens`)
      const turns = (await read($, trail)).map(describe)
      const subs = (await read($, agents)).map(a => `${a.type} «${a.description}»: ${a.effort ?? 'its own'} (${a.source}${a.status === 'running' ? ', running' : ''})${a.why ? ` — ${a.why}` : ''}`)
      return {
        text: [
          ...(why ? [`Effort Pilot: ${asideText(name, why)}`] : []),
          `turns:\n${turns.join('\n') || 'none yet'}`,
          `subagents:\n${subs.join('\n') || 'none yet'}`,
          `main-loop requests by effort:\n${rows.join('\n') || 'none yet'}`,
        ].join('\n\n'),
      }
    }
    await publish($)
    const p = await read($, pin)
    const name = await modelOf($).catch(() => '')
    const why = aside(name)
    const off = why ? ` · ${asideText(name, why)}` : ''
    const measured = measuring ? ` · measuring, ${Math.round(controlShare * 100)}% control turns` : ''
    return { text: `Effort Pilot: ${await read($, mode)}${p ? `, pinned ${p}` : ''}${off}${measured}` }
  })

  // A person who sets /effort by hand takes over until `/effort-pilot on` (or `/effort auto`).
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    await resume($)
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
  // of its own, classified then (turn.start). A slash command typed while a turn runs waits until it ends and is
  // submitted then, as from an idle session: routed as below. Only the main loop's running turn makes a message mid-turn:
  // one submitted while only a subagent works (it carries the subagent's turn id) starts a main-loop turn, routed here.
  // A meta submit is the engine's own, not routed, except a notification's: a subagent's hand-back comes as a meta
  // message from a peer, and is routed like any finished task's result.
  on('prompt.submit', async ($, e, next) => {
    await resume($)
    if (e.origin.kind === 'sdk') interactive = false
    else if (LIVE.has(e.origin.kind)) interactive = true
    if (e.turnId !== undefined && mainTurn !== null) {
      if (!e.command && !e.isMeta && !NOTICE.has(e.origin.kind)) {
        freshInput = true
        queued = e.origin.kind
        waiting.push(e.text)
      }
      return next(e)
    }
    submitted = true
    if (e.isMeta && !NOTICE.has(e.origin.kind)) return next(e)
    // A skill or prompt command is expanded for the model beneath (skill.prompt) and routed there.
    if (e.command) {
      typed = { name: e.command.name, text: e.text, args: e.command.args, kind: e.origin.kind }
      const result = await next(e)
      await unrouted($)
      return result
    }
    await begin($, e.text, e.origin.kind, !!e.isMeta)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The engine expands the skill or prompt command the person typed: a turn of model work on their request, routed
  // like a typed prompt from the command's line (`/name args`); with no arguments, with what the command says it does.
  // A skill the Skill tool loads mid-turn is not one.
  on('skill.prompt', async ($, e, next) => {
    const t = typed
    if (t && e.skill === t.name) {
      typed = null
      await begin($, commandText(t.text, t.args, e.frontmatter?.description, e.text), t.kind).catch(err => $.ui.log(`effort-pilot: could not route the command: ${String(err)}`))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Plan mode is the engine's fact: the permission mode it hands every classic hook, read before each turn. Within
  // a turn, plan mode ends when an ExitPlanMode call is approved (the classic PostToolUse of that call still reads
  // plan), and starts when EnterPlanMode runs. Either changes the effort from the very next request (applyNow).
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await setPlan($, e.permission_mode === 'plan')
    return next(e)
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && !result.deny && !result.isError) {
      await approved($, result.text ?? '')
      await setPlan($, false)
      await publish($)
      await applyNow($, 'for carrying out the approved plan')
    }
    return result
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'EnterPlanMode' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && !result.deny && !result.isError) {
      await setPlan($, true)
      await publish($)
      await applyNow($, 'for planning')
    }
    return result
  }).catch(($, e, next) => next(e))

  // A skill the main loop loads comes back as a message of its own beside the tool result: new input, so the next
  // request takes the effort asked for.
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
    await credential($)
    // Where a switch would rewrite the prompt cache, the subagent keeps the session's effort: nothing to classify.
    if (aside(e.model ?? e.parentModel) !== null) return next(e)
    const resumed = e.resume ? byAgent.get(e.resume.agentId) : undefined
    const builtin = e.provider.plugin === 'engine'
    const listed = listedAgent(e.subagentType, config, builtin)
    // An effort the Agent call names, or the one the person set for every subagent: theirs, nothing to classify.
    const named = explicit.has(e.tool_use_id) || !!(await $.env.get('CLAUDE_CODE_SUBAGENT_EFFORT').catch(() => undefined))?.trim()
    const d: Decision = {
      route: null, pick: null, task: resumed?.task ?? null, arm: 'auto', source: 'own', type: e.subagentType,
      description: e.description, checked: false, listed, acc: { ...EMPTY, at: await $.clock.now() }, model: '',
    }
    let description = e.description
    if ((builtin || listed) && !named && e.prompt.trim()) {
      const { route: pick } = await ask($, briefPrompt(e.subagentType, e.description, e.prompt, d.task, await noUltrathink($)), true).catch(() => ({ route: null }))
      if (pick) {
        const carried = d.task ? carry(d.task, pick, e.prompt, config) : { route: pick, task: { phase: pick.phase, hard: pick.hard, effort: pick.effort, text: e.prompt } }
        d.route = forAgent(carried.route, config)
        d.pick = pick
        d.task = carried.task
        // A listed agent's own effort is its definition's (high, as such agents declare), whatever the session's: the
        // control run goes at it.
        d.arm = (listed ? !d.route.asked && d.route.effort !== 'high' : differs(d.route.effort)) && Math.random() < share() ? 'control' : 'auto'
        d.source = d.arm === 'auto' ? 'auto' : 'control'
        // Shown on the agent's line in the transcript when it will hold: on a model the pilot steers.
        if (d.source === 'auto' && managed(e.model ?? e.parentModel)) description = `${e.description} · effort ${SHORT[d.route.effort]}`
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
      mainTurn = e.turnId
      await resume($)
      // No prompt.submit before this turn and a message still queued: the turn is that message's, read only now.
      const kind = queued
      queued = null
      waiting = []
      await unrouted($)
      if (!submitted && kind && e.text.trim()) await begin($, e.text, kind)
      submitted = false
      const at = await $.clock.now()
      await update($, acc, () => ({ ...EMPTY, at }))
      const plan = await read($, planMode)
      await update($, planned, () => plan)
      const t = plan ? await read($, task) : null
      turnPlan = plan ? { effort: t?.asked ?? config.plan, asked: !!t?.asked } : null
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
        // A model the pilot leaves alone, a number, or on the session's model an effort that is not the one the session
        // hands down: declared. On another model the effort is that model's saved one or its default, which no one
        // chose for this agent: steered by its brief. A listed agent's declared effort is not its decision.
        if (!managed(e.model)) d.source = 'skip'
        else if (typeof e.effort === 'number') d.source = 'own'
        else if (!d.listed && sessionEffort !== undefined && sameModel(e.model, sessionModel) && e.effort !== sessionEffort) d.source = 'own'
        await showAgent($, e.agentId, d, 'running')
      }
      const effort = d.source === 'auto' ? d.route?.effort : undefined
      const began = await $.clock.now()
      const result = yield* next(effort ? { ...e, effort } : e)
      const took = (await $.clock.now()) - began
      if (result?.usage) d.acc = tallied(d.acc, effort ?? level(e.effort), level(e.effort), result.usage, took)
      return result
    }
    await resume($)
    await credential($)
    sessionEffort = e.effort ?? sessionEffort
    sessionModel = e.model
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
    // A number is the person's own effort: it goes as they set it.
    const effort = typeof e.effort === 'string' ? await aim($, e.model) : undefined
    const began = await $.clock.now()
    const result = yield* next(effort ? { ...e, effort } : e)
    const took = (await $.clock.now()) - began
    const base = level(e.effort)
    // What actually went: the asked effort on a step with new input, else the one already in effect.
    if (input) await update($, wire, () => effort ?? base)
    const sent = (await read($, wire)) ?? effort ?? base
    const u = result?.usage
    if (u) {
      const cur = { model: e.model, effort: sent, messageCount: e.messageCount, prompt: promptOf(u), cacheRead: u.cache_read_input_tokens, at: began }
      const prev = lastStep
      // A conversation's first request: none seen yet in this process, or the conversation began again (a /clear).
      lastStep = { ...cur, at: began + took, first: !prev || e.messageCount < prev.messageCount }
      if (managed(e.model) && cacheRewritten(prev, { ...cur, input })) await rewrote($, e.model, prev!, cur)
      await update($, acc, a => tallied(a, sent, base, u, took))
    }
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
    mainTurn = null
    const faulted = lastPick?.faulted
    const own = turnPick
    const aimed = turnPlan
    lastPick = null
    turnPlan = null
    turnPick = null
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
        phase: plan ? 'plan' : r.phase, hard: r.hard, chosen: plan ? (aimed?.effort ?? config.plan) : r.effort,
        base: a.base, sent: a.sent, model: m, steps: a.steps, out: a.out, input: a.input,
        cacheRead: a.cacheRead, cacheWrite: a.cacheWrite, ms: Math.round((await $.clock.now()) - a.at), reason: e.reason, cls,
        who: w, ...(sessionAgent() ? { agent: sessionAgent(), via: 'session' as const } : {}), trace: a.trace, gen: Math.round(a.gen), ...(faulted ? { faulted: true } : {}), ...(r.asked || (plan && aimed?.asked) ? { asked: true as const } : {}),
        ...picked(own, r),
      }).catch(err => $.ui.log(`effort-pilot: could not keep the turn: ${String(err)}`))
    }
    return result
  })

  // The report pane: the read kept when it opened; Refresh reads the records again.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const refresh = () => void readReport($).catch(err => $.ui.log(`effort-pilot: could not read the turn records: ${String(err)}`))
    return drawBoard($.ui.resolve(e), await read($, board), e.props.bodyColumns, refresh)
  })

  // The band above the prompt: the effort now, how it got here, and why; then the subagents and theirs.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const current = await read($, model)
    const r = await read($, route)
    const m = await read($, mode)
    const { Box, Text } = $.ui.resolve(e)
    const below = await next(e)
    await credential($)
    const why = aside(current)
    if (why) {
      return (
        <Box flexDirection="column">
          <Text dimColor>⏵ Effort Pilot: {asideText(current, why)}</Text>
          {below}
        </Box>
      )
    }
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
