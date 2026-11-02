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
 * which in a model's name makes it managed).
 */
export type Config = { plan: Effort; analyze: Effort; build: Effort; hardBuild: Effort; talk: Effort; models: readonly string[] }

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
  /** Whose turn: your prompt, a notification (a background task finished, a scheduled prompt), or a subagent's run. Absent: person. */
  who?: Who
  /** The subagent's type, for who 'agent'. */
  agent?: string
  /** Each request of the turn: the effort it went at and its output tokens (at most 60). */
  trace?: [Effort | null, number][]
  /** Milliseconds the model spent answering the turn's requests: its speed, without tools and subagents. */
  gen?: number
  /** The turn's prompt says the turn before fell short (the classifier reads it): the quality signal. */
  faulted?: boolean
  /** The effort was the one the person asked for: not the pilot's pick, left out of the comparison. */
  asked?: true
  /** A turn recorded by a test run: left out of the report. */
  test?: true
}

export type Who = 'person' | 'notification' | 'agent'

/**
 * A subagent as the pilot sees it. source: auto (it set the effort), control (classified, left inherited),
 * own (its definition or the call set it, or it is not a built-in agent), skip (a model or setting the pilot leaves alone).
 */
export type AgentRun = {
  id: string
  type: string
  description: string
  effort: Effort | null
  source: 'auto' | 'control' | 'own' | 'skip'
  why: string
  status: 'running' | 'done'
}

/** What the pilot itself spent classifying a turn's messages: Haiku calls, their tokens, the wait before the turn. */
export type Spend = { calls: number; input: number; out: number; cacheRead: number; cacheWrite: number; ms: number }

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
      /** Classifier spend since the last main-loop turn ended; folded into that turn's record. */
      spend: Shaped<Spend>
      /** Plan mode was on at some point of this main-loop turn: the turn records as a plan. */
      planned: boolean
      /** The effort in effect on the wire (Claude Code changes it only on a request with new input). */
      wire: Effort | null
      /** An effort asked for mid-turn that waits for the next input (an approved plan, plan mode entered). */
      held: Effort | null
      /** Whose turn the main loop runs now; null: a prompt the pilot does not route (left untouched, not recorded). */
      who: Who | null
      /** The subagents of this session, newest last (at most 8), for the band. */
      agents: Shaped<AgentRun[]>
      acc: Shaped<{ steps: number; out: number; input: number; cacheRead: number; cacheWrite: number; gen: number; base: Effort | null; sent: Effort | null; at: number; trace: [Effort | null, number][] }>
    }
  }
}
