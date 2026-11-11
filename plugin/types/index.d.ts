export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/**
 * plan: the person asks for a plan (or plan mode is on) · analyze: reason through a hard question, nothing to build
 * implement: carry out a plan or a scoped change · fix: correct or finish something already built
 * trivial: a small edit, one command, "ok/continue" with nothing to build · chat: a question, summary, status
 */
export type Phase = 'plan' | 'analyze' | 'implement' | 'fix' | 'trivial' | 'chat'
/** auto: set effort; shadow: show what it would set, change nothing; off: nothing. */
export type Mode = 'auto' | 'shadow' | 'off'

/**
 * The settings the rule reads: the effort of each kind of work, and the models it applies to (lower-case words, any of
 * which in a model's name makes it managed). agents: the agent types steered by their brief besides the built-ins
 * (lower-case: `plugin:agent`, `plugin:*`, a bare name, or `*`); sessionAgent: the agent type a headless session runs as
 * (`claude -p --agent <type>`) where the engine does not say it; empty: the engine's word. planModel: the model the main
 * loop's requests go on while plan mode lasts (an alias or a full id, as typed); empty: the model is never changed.
 */
export type Config = { plan: Effort; analyze: Effort; build: Effort; hardBuild: Effort; talk: Effort; models: readonly string[]; agents: readonly string[]; sessionAgent: string; planModel: string }

export type Route = {
  phase: Phase
  hard: boolean
  effort: Effort
  why: string
  /** The classifier read the message as part of the work already under way (adds to it, refines it, asks about it). */
  continues?: boolean
  /** The effort was kept from the task under way rather than taken from this message alone. */
  kept?: boolean
  /** The effort the person asked for, in their words, for this work: it stands over the rule. */
  asked?: Effort
  /** The effort the person asked for carrying out a plan, once it is made. */
  build?: Effort
  /**
   * The model the person asked to work on from now (an alias such as `sonnet`, or a full id): a switch of the session's
   * main loop, from this message on. After the rule, also the model asked for carrying out a plan, once building starts.
   */
  model?: string
  /** The model the person asked for carrying out a plan, once it is made. */
  buildModel?: string
  /** The person takes back an effort they asked for: the rule chooses again. */
  release?: boolean
  /** The message says the agent's last work fell short: wrong, broken, incomplete or misunderstood. */
  faulted?: boolean
}

/** The work under way: what started it and the effort it set; follow-ups keep it. */
export type Task = {
  phase: Phase
  hard: boolean
  effort: Effort
  text: string
  /** An effort the person asked for this work: follow-ups keep it until a new task. */
  asked?: Effort
  /** An effort the person asked for carrying out the plan this work makes. */
  build?: Effort
  /** A model the person asked for carrying out the plan this work makes. */
  buildModel?: string
}

/** One finished main-loop turn, as measuring keeps it. arm control: classified, but the effort was left as it was. */
export type TurnRecord = {
  t: number
  s: string
  arm: 'auto' | 'control'
  phase: Phase
  hard: boolean
  /** The effort the rule picks for the phase. */
  chosen: Effort
  /** The effort the engine had for the turn before the pilot: the person's own setting. */
  base: Effort | null
  /** The effort the turn's requests went at. */
  sent: Effort | null
  model: string
  steps: number
  out: number
  input: number
  cacheRead: number
  cacheWrite: number
  ms: number
  reason: string
  /** The classifier's cost for this turn; absent on some records. */
  cls?: Spend
  /**
   * Whose turn: your prompt, a notification (a background task finished, a scheduled prompt), or an agent's run on its
   * brief (a subagent's, or the first turn of a headless session run as an agent). Absent: person.
   */
  who?: Who
  /** The agent's type: the subagent's for who 'agent'; on every turn of a headless session run as an agent, that agent's. */
  agent?: string
  /**
   * How an agent's run came under the pilot, set only there: `listed` (a subagent whose type the agents setting lists,
   * steered by its brief over its own effort) or `session` (a turn of a headless session run as the agent, `claude -p
   * --agent <type>`: its first turn, the brief, is who 'agent'; a later notification or message who 'notification' or
   * 'person'). The report gives these runs groups of their own per agent type.
   */
  via?: 'listed' | 'session'
  /** Each request of the turn: the effort it went at and its output tokens (at most 60). */
  trace?: [Effort | null, number][]
  /** Milliseconds the model spent answering the turn's requests: its speed, without tools and subagents. */
  gen?: number
  /** The turn's prompt says the turn before fell short (the classifier reads it): the quality signal. */
  faulted?: boolean
  /** The effort was the one the person asked for: not the pilot's pick, left out of the comparison. */
  asked?: true
  /** The classifier's own pick for the turn's message, before the rules after it (absent: not classified). */
  pick?: { phase: Phase; hard: boolean }
  /** The rules kept the effort of the work under way rather than the turn's own pick. */
  kept?: true
  /** Plan mode was on in the turn: never a control turn, so left out of the comparison. */
  planMode?: true
  /** A turn recorded by a test run: left out of the report. */
  test?: true
}

export type Who = 'person' | 'notification' | 'agent'

/**
 * A subagent as the pilot sees it. source: auto (it set the effort), control (classified, left inherited),
 * own (its definition or the call set it, or it is neither a built-in nor a listed agent), skip (a model or setting the
 * pilot leaves alone).
 */
export type AgentRun = {
  id: string
  type: string
  description: string
  effort: Effort | null
  source: 'auto' | 'control' | 'own' | 'skip'
  why: string
  status: 'running' | 'done'
  /** The effort its first request went at, once seen (a number as given); absent before it, null where none went. */
  seen?: Effort | number | null
  /** Who set that effort, in a word or two (own, call, env, control, not managed, yours); absent where the pilot did. */
  tag?: string
}

/** What the pilot itself spent classifying a turn's messages: Haiku calls, their tokens, the wait before the turn. */
export type Spend = { calls: number; input: number; out: number; cacheRead: number; cacheWrite: number; ms: number }

/** One arm of a compared phase: its turns, mean cost a turn ($), median model time (ms), share that fell short (0–1). */
export type ArmRead = { turns: number; cost: number; time: number; short: number }

/**
 * One measure of a compared phase: the pilot's gain over control (a share of control's cost or time, or points of
 * falling short; positive: better) with its 90% range, the verdict, and, while unclear, the turns each arm would
 * still need for the range to leave zero if the gap holds (null: no gap to hold).
 */
export type MeasureRead = { share: number; low: number; high: number; verdict: 'better' | 'worse' | 'unclear'; more: { pilot: number; control: number } | null }

/** One group's phase in the report: what was compared, what was not, and the verdicts once both arms have 5+ turns. */
export type PhaseRead = {
  who: Who
  /** A listed agent's group (records with via): its type; absent for the groups by who. */
  agent?: string
  phase: Phase
  /** The efforts the pilot's compared turns went at, in the order first seen. */
  efforts: Effort[]
  pilot: ArmRead | null
  control: ArmRead | null
  /** Turns of the phase not compared: high either way, another own effort, an asked effort, or one held over. */
  same: number
  /** Turns still needed on each arm before the phase is compared (5 each); both 0 once compared. */
  need: { pilot: number; control: number }
  /** Present once both arms have 5+ turns. */
  measures?: { cost: MeasureRead; time: MeasureRead; short: MeasureRead }
}

/** The measurement's read, as data: the text report and the report pane both draw it. */
export type ReportData = {
  turns: number
  days: number
  sessions: number
  /** Records left out: test or failed turns. */
  left: number
  phases: PhaseRead[]
  /** Turns by the effort their requests went at; none: no request carried one. */
  sent: Partial<Record<Effort | 'none', number>>
  /** The classifier's own cost; null while none is recorded. */
  classifier: { calls: number; turns: number; input: number; out: number; cost: number; perTurn: number; wait: number; missing: number } | null
  /**
   * Over the compared phases, a pilot turn: cost saved ($) and model time saved (ms); null while no phase is compared.
   * verdict: unclear while any compared phase's cost range spans zero (`unclear` of them); once none does, the sign of
   * saved − perTurn decides pays or costs.
   */
  net: { phases: number; turns: number; saved: number; perTurn: number; faster: number; verdict: 'pays' | 'costs' | 'unclear'; unclear: number } | null
}

/** Requests and output tokens at each effort level, main loop only. */
export type Tally = Partial<Record<Effort, { steps: number; out: number }>>

declare module 'claude-code' {
  interface PluginState {
    'effort-pilot': {
      mode: Mode
      pin: Effort | null
      route: Shaped<Route | null>
      trail: Shaped<Route[]>
      tally: Shaped<Tally>
      model: string
      latency: number
      lastAnswer: string
      arm: 'auto' | 'control'
      /** The session's permission mode is plan, as the engine last reported it (classic hook input). */
      planMode: boolean
      task: Shaped<Task | null>
      /** What the next request goes at, for other plugins to show: null when the pilot is not setting it. Its shape (effective-1) is read by other plugins: keep it. */
      effective: Shaped<{ effort: Effort; source: 'auto' | 'pinned' } | null>
      /**
       * The model the next main-loop request goes on, for other plugins to show, where the pilot sends it on another
       * model than the session's: one the person asked for in words (asked), one asked for making a plan (plan), or the
       * planModeModel setting in plan mode (setting); an alias or a full id. Null: the session's own model. Its shape
       * (effective-model-1) is read by other plugins: keep it.
       */
      effectiveModel: Shaped<{ model: string; source: 'asked' | 'plan' | 'setting' } | null>
      /** Classifier spend since the last main-loop turn ended; folded into that turn's record. */
      spend: Shaped<Spend>
      /** Plan mode was on at some point of this main-loop turn: the turn records as a plan. */
      planned: boolean
      /** The classifier gave no answer for this main-loop turn's message: it runs at the person's own effort, unrecorded. */
      blind: boolean
      /** The effort in effect on the wire (Claude Code changes it only on a request with new input). */
      wire: Effort | null
      /** Whose turn the main loop runs now; null: a prompt the pilot does not route (left untouched, not recorded). */
      who: Who | null
      /** The subagents of this session, newest last (at most 8), for the band. */
      agents: Shaped<AgentRun[]>
      /** The report the pane draws, as read when it opened or was last refreshed, and where the records are; null before. */
      board: Shaped<{ data: ReportData; where: string } | null>
      /** This main-loop turn's requests so far; model: the plan-mode model, once a request of the turn went on it. */
      acc: Shaped<{ steps: number; out: number; input: number; cacheRead: number; cacheWrite: number; gen: number; base: Effort | null; sent: Effort | null; at: number; trace: [Effort | null, number][]; model?: string; askedModel?: true }>
      /**
       * The model the person asked to work on, for the rest of the session's main loop: an alias or a full id; the effort
       * named with it (held on a model the pilot does not manage); plan: asked for making a plan, so it wins over the
       * plan-mode model until building starts. Null: the session's own model.
       */
      wanted: Shaped<{ model: string; effort: Effort | null; plan: boolean } | null>
    }
  }
}
