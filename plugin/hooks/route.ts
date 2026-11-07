import type { ArmRead, Config, Effort, MeasureRead, Phase, PhaseRead, ReportData, Route, Spend, Task, TurnRecord, Who } from '../types'

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const PHASES: readonly Phase[] = ['plan', 'analyze', 'implement', 'fix', 'trivial', 'chat']

/** The settings' defaults: the effort table and the models it applies to. */
export const DEFAULTS: Config = { plan: 'xhigh', analyze: 'high', build: 'medium', hardBuild: 'high', talk: 'low', models: ['opus', 'fable'], agents: [], sessionAgent: '' }

/**
 * The settings as the plugin's options hold them (userConfig): a missing or unknown value falls back to its default,
 * so a bad entry in settings never stops the plugin.
 */
export function configFrom(options: Readonly<Record<string, unknown>>): Config {
  const effort = (key: string, fallback: Effort) => EFFORTS.find(x => x === options[key]) ?? fallback
  const listed = typeof options.managedModels === 'string'
    ? options.managedModels.split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
    : DEFAULTS.models
  const agents = typeof options.agents === 'string' ? options.agents.split(',').map(x => x.trim().toLowerCase()).filter(Boolean) : DEFAULTS.agents
  const sessionAgent = typeof options.sessionAgent === 'string' ? options.sessionAgent.trim() : DEFAULTS.sessionAgent
  return {
    plan: effort('planEffort', DEFAULTS.plan),
    analyze: effort('analyzeEffort', DEFAULTS.analyze),
    build: effort('buildEffort', DEFAULTS.build),
    hardBuild: effort('hardBuildEffort', DEFAULTS.hardBuild),
    talk: effort('talkEffort', DEFAULTS.talk),
    models: listed,
    agents,
    sessionAgent,
  }
}

/**
 * An agent type the settings list (agents): steered by its brief like a built-in, even where its own definition sets an
 * effort. An entry names one type exactly (`plugin:agent`, case aside) or every agent of a plugin (`plugin:*`).
 */
export function listedAgent(type: string, config: Config = DEFAULTS) {
  const t = type.trim().toLowerCase()
  return t !== '' && config.agents.some(x => (x.endsWith(':*') ? t.startsWith(x.slice(0, -1)) : t === x))
}

/** The models whose effort the plugin sets: a name holding one of the configured words. Others are left to the person. */
export function managed(model: string | null | undefined, config: Config = DEFAULTS) {
  const m = (model ?? '').toLowerCase()
  return m !== '' && config.models.some(x => m.includes(x))
}

/**
 * Why a model's effort is one setting of the whole request, so that changing it rewrites the conversation's prompt
 * cache; null where the effort goes per message and a change costs no cache.
 * - model: Claude 4.x and older, and Fable 5 (not 5.1 or later);
 * - provider: no first-party Anthropic credential (Bedrock, Vertex, Foundry, a gateway);
 * - number: the effort is a number, which goes out with every request;
 * - usage: a switch was seen to rewrite the cache (cacheRewritten), on a model not known here.
 * A model not known here counts as per message: the usage check catches it.
 */
export type Aside = 'model' | 'provider' | 'number' | 'usage'
export function wholeRequest(model: string | null | undefined, firstParty: boolean, effort?: string | number): Aside | null {
  const m = (model ?? '').toLowerCase()
  if (m) {
    // The older naming puts the generation first: claude-3-5-sonnet, claude-2.1.
    if (/claude-\d/.test(m)) return 'model'
    // The newer one puts the family first: claude-opus-4-6, claude-sonnet-4-5-20250929, claude-fable-5-1[1m]. A minor
    // version is one or two digits; eight are a date.
    const v = /(?:^|[^a-z])(opus|sonnet|haiku|fable)[-\s](\d+)(?:[-.](\d{1,2}))?(?![0-9])/.exec(m)
    if (v) {
      const major = Number(v[2])
      if (major < 5) return 'model'
      if (v[1] === 'fable' && major === 5 && v[3] === undefined) return 'model'
    }
  }
  if (!firstParty) return 'provider'
  if (typeof effort === 'number') return 'number'
  return null
}
/** The effort goes per message on this model and setup: switching it costs no prompt cache. */
export const perMessage = (model: string | null | undefined, firstParty: boolean, effort?: string | number) => wholeRequest(model, firstParty, effort) === null
/** One model under two spellings: case aside, and a trailing tag such as [1m] dropped. */
export const sameModel = (a: string | null | undefined, b: string | null | undefined) => {
  const bare = (m: string | null | undefined) => (m ?? '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
  return bare(a) !== '' && bare(a) === bare(b)
}

/** How the band, the status and stats say the pilot stands aside on a model (after "Effort Pilot: "). */
export function asideText(model: string, why: Aside) {
  const detail = { model: '', provider: ' (no first-party Anthropic login: Bedrock, Vertex, Foundry or a gateway)', number: ' (your effort is a number)', usage: ' (a switch was seen to rewrite the prompt cache)' }[why]
  return `off on ${model} — effort is one setting per request here${detail}, so a change would rewrite the prompt cache; your own effort stands`
}

/** One main-loop request as the cache check needs it. at: when it started (cur) or ended (prev), in ms. */
export type Step = { model: string; effort: string | number | null; messageCount: number; prompt: number; cacheRead: number; at: number }
/** Below this the API caches nothing, and five minutes is the cache's life: a miss after either tells nothing. */
const CACHED = 4096
const LIFE = 5 * 60_000
/** The whole prompt a request carried: uncached, read from the cache and written to it. */
export const promptOf = (u: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
/**
 * A request with new input went at another effort than the one before it, on the same model, with the conversation
 * only grown and the cache still alive and read, yet lost part of the prompt before it from the cache: the effort is
 * one setting of the whole request here. With the cache kept, the request reads back about all of the prompt before
 * it (Claude Code caches up to the last message); a rewrite often reads only the system and tools prefix, which on a
 * short conversation is over half the prompt. So it is judged by what was not read back: at least CACHED tokens (a
 * smaller loss costs nothing worth acting on) and more than a fifth of the prompt before it.
 */
export function cacheRewritten(prev: Step | null, cur: Step & { input: boolean }) {
  if (!prev || !cur.input) return false
  if (cur.effort === null || prev.effort === null || cur.effort === prev.effort) return false
  if (cur.model !== prev.model || cur.messageCount < prev.messageCount) return false
  if (cur.at - prev.at >= LIFE || prev.cacheRead <= 0 || prev.prompt < CACHED) return false
  const lost = prev.prompt - cur.cacheRead
  return lost >= CACHED && lost > prev.prompt / 5
}

/**
 * The rule: the plan effort only for a plan, which is plan mode or the person explicitly asking for one;
 * a hard question the analyze effort; building the build effort, the hard-build one when hard; talk and small edits
 * the talk effort.
 */
export function effortFor(phase: Phase, hard: boolean, planMode = false, config: Config = DEFAULTS): Effort {
  if (planMode) return config.plan
  switch (phase) {
    case 'plan':
      return config.plan
    case 'analyze':
      return config.analyze
    case 'implement':
    case 'fix':
      return hard ? config.hardBuild : config.build
    case 'trivial':
    case 'chat':
      return config.talk
  }
}

export const SYSTEM = `You classify one message a person sends to a coding agent (Claude Code), to set how hard the agent thinks on this turn. Reply with one JSON object and nothing else:
{"phase":"plan|analyze|implement|fix|trivial|chat","hard":true|false,"continues":true|false,"restate":true|false,"asked":"low|medium|high|xhigh|max|auto|none","build":"low|medium|high|xhigh|max|none","faulted":true|false,"why":"<=8 words"}

- plan: ONLY when the person explicitly asks you to make a plan: to plan, design or lay out how something will be built before building it, or to redo a plan. Anything else is not plan: a request to build or change something ("can you make it so that…", "add…", "¿puedes hacer que…?") is implement; a question, an analysis, research or "think about X" without asking for a plan is analyze or chat.
- analyze: reason through a hard question or investigate something, with nothing to build: a subtle bug's cause to explain, a trade-off to judge, a proof, "think carefully whether…". Also: why something is slow or fails, how something works or will work under the hood, whether a claim is technically true (and what to tell a user about it), whether we could or should do something ("don't you think we should…?").
- implement: carry out an agreed plan or build a clear, scoped feature or change; write tests; refactor. "go", "do it", "давай", "ja, setz das um" right after a plan is implement. A message that orders an action (start it, test it now, buy or pay, delete, merge, push, deploy, log in) is implement or fix, never chat or trivial.
- fix: correct, finish or adjust something already built: a bug, a failing test, a review comment, "this is wrong, redo X".
- trivial: a tiny edit (rename, typo, one line, a config value); a word to go on with nothing new to build: "ok", "continue", or "done"/"готово" when the person did what the agent asked of them (trivial even after a plan).
- chat: a question about what was done, an explanation of the agent's answer, a summary, status, small talk.
hard (only for implement and fix): what the agent itself will do on this turn, not how hard or important the subject is. true when it does the hard part itself: investigates a bug of unknown cause, writes tricky or many-file code (a redesign or rework of a screen or flow too), or runs a risky operation (merge, push, deploy, deletes, production data, money): an order to push, merge, deploy, release or delete is hard. false when it briefs or messages a subagent, relays a result, records a decision, runs a known command, or changes a look, wording, order or colour.
continues: true only when the message is about the same subject as the work under way, and that work is not finished: it adds a requirement, refines or narrows it, asks a question about it or about the agent's findings so far, answers the agent's question, or pushes back on its reasoning; a word to go on ("done", "ok", "готово") when the agent's last answer said more of that work is to come. false when it is about another subject (a side question, however short, is not part of the work), starts a different task, only closes the work (thanks, ok, a recap after it is done). On the first turn it is false.
restate: true when the message only asks to restate the agent's last answer with nothing new to work out: translate it, shorten it, rephrase it simpler, reformat it, repeat it. A question about the answer, a doubt about it or a request to check it is not restate.
asked: the effort level the person tells the agent to think at itself, now, for the work this message hands it, in any words or language ("do it on high", "hazlo en xhigh", "medium is enough", "think at max"); for a message that asks for a plan, the level named for making the plan ("plan it on max"). none when the message names no level for it. Talking about effort is not asking: a level named as a default, a rule or a setting (for a tool, a plugin, an autopilot, a config), as what some kind of work should get in general, or as the subject of the code to change ("make the autopilot default to high for fixes", "nach einem Plan soll es medium sein" are not asking); a model's name. When unsure, none. The word "ultrathink" (Claude Code's own keyword) is asked xhigh, never max, in a message that asks for a plan too, unless it is quoted or talked about.
asked is auto when the person takes back a level they named before and lets the effort be chosen again ("back to auto", "vuelve a automático").
build: the effort level the person tells the agent to carry out a plan at, once it is made ("plan it, then implement on high"); none otherwise. The same: talking about effort in general is not asking.
faulted: true when the message says the agent's last work fell short: what it did or answered is wrong, broken, does not work, missed or ignored part of what the person had asked, misunderstood it, or must be redone ("не працює", "das ist nicht, was ich wollte", "still broken", "you forgot X", "I did not ask you to…"). Not faulted: a new request or requirement, even one the person forgot to give before; a change of taste in work that works (another colour, layout, order or wording, "I don't like how it looks"); the person deciding otherwise than the agent proposed; a problem in something the agent's last work did not make (a tool, a plugin, another system); a question or a change of mind. When unsure, false.
plan costs the most: when unsure whether the person asked for a plan, they did not. When unsure between two phases, pick the cheaper.
The person may write in any language. Judge by what the turn will make the agent do, not by the message's length.`

const NOTICE_LINE = 'This message is not from the person: it is an automatic notification (a background task or agent finished, a scheduled prompt fired) or a message from another Claude session. Classify what the agent will do next with it. A finished agent\'s result that the agent only relays to the person or hands to the next agent is light: chat, or implement or fix with hard false. So is a report that the work is built, committed, or passes its checks or QA (minor findings at most). When the result reports a failure, a blocker, a cause still unknown, results that miss the target, or a decision to make, the agent must work it out: the work under way\'s phase, analyze, or fix with hard true. continues: true when it belongs to the work under way.'

const MID_LINE = 'The person typed this message while the agent was still working on the work under way; it reaches the agent in the middle of that work. continues: true when it is about that work in any way (a question about it, a correction, a detail, a narrowing, an extra requirement for it, a reply to the agent). false only when it hands the agent a different task or asks about another subject.'

/** Claude Code turns its `ultrathink` keyword off when CLAUDE_CODE_DISABLE_ULTRATHINK is set: the word asks for nothing then. */
export const NO_ULTRATHINK_LINE = 'Claude Code\'s "ultrathink" keyword is turned off here: the word asks for no level.'
/** An environment flag is on when set to anything but empty, "0" or "false". */
export const flagOn = (v: string | undefined) => {
  const x = (v ?? '').trim().toLowerCase()
  return x !== '' && x !== '0' && x !== 'false'
}

export function prompt(text: string, task: Task | null, previous: Route | null, lastAnswer: string, notice = false, midTurn = false, noUltrathink = false) {
  return [
    task ? `The work under way (${task.phase}) began with the message:\n"""\n${task.text.slice(0, 600)}\n"""` : 'No work under way yet (first turn).',
    previous ? `Previous turn: ${previous.phase}.` : '',
    lastAnswer ? `The agent's last answer ended:\n"""\n${lastAnswer.slice(-1200)}\n"""` : '',
    notice ? NOTICE_LINE : '',
    midTurn ? MID_LINE : '',
    noUltrathink ? NO_ULTRATHINK_LINE : '',
    `The ${notice ? 'notification' : "person's new message"}:\n"""\n${text.slice(0, 4000)}\n"""`,
    'Do not answer the message: classify it. Reply with the JSON object only.',
  ].filter(Boolean).join('\n\n')
}

/**
 * A subagent's brief, or a new message to a subagent already at work (task: the brief it began with).
 * The subagent works alone on it; classify the work it will do.
 */
export function briefPrompt(type: string, description: string, brief: string, task: Task | null, noUltrathink = false) {
  return [
    `A coding agent hands work to a subagent of type "${type}" (${description}). The subagent works on it alone and reports back. Classify the work the subagent will do, as if the text below were the new message. Finding, listing or mapping code, or collecting facts or sources to hand back as found, is chat, however thorough. When the brief asks the subagent to weigh what it finds (find a cause, judge a trade-off, design, recommend), it is analyze: a research task that ends in a document of weighed findings, a design or recommendations is analyze. Acting on the world (sending, posting, writing production data, spending money) is implement with hard true.`,
    task ? `The subagent's work under way (${task.phase}) began with the brief:\n"""\n${task.text.slice(0, 600)}\n"""` : 'This is its first brief: continues false.',
    noUltrathink ? NO_ULTRATHINK_LINE : '',
    `The ${task ? 'new message to the subagent' : 'brief'}:\n"""\n${brief.slice(0, 4000)}\n"""`,
  ].filter(Boolean).join('\n\n')
}

/**
 * The plugin started in a session already under way (installed or reloaded mid-session, or a resumed session):
 * it knows no work yet. The session's last messages are handed to the classifier to name the work under way,
 * so a "continue" right after the load keeps that work's effort instead of reading as a first, trivial turn.
 */
export function seedPrompt(recent: string) {
  return [
    'The plugin started in a session already under way, so it does not know the work in progress. These are the session\'s last messages, oldest first:',
    `"""\n${recent}\n"""`,
    'Classify the person\'s latest real request among them (not a command\'s output, a notification or a summary) as if it were the new message. continues: false.',
  ].join('\n\n')
}

/** The last few messages with text, oldest first, each cut short; null when no one has written anything yet. */
export function recentOf(rows: readonly { role: string; text: string; toolResults?: readonly unknown[] }[], current: string) {
  const said = rows.filter(r => r.text.trim() && !(r.role === 'user' && r.toolResults?.length))
  if (said.at(-1)?.role === 'user' && said.at(-1)!.text.trim() === current.trim()) said.pop()
  if (!said.some(r => r.role === 'user')) return null
  const tail = said.slice(-6)
  return {
    recent: tail.map(r => `[${r.role}] ${r.text.trim().slice(0, 500)}`).join('\n\n'),
    request: [...tail].reverse().find(r => r.role === 'user')?.text.trim() ?? '',
    answer: [...said].reverse().find(r => r.role === 'assistant')?.text.slice(-1500) ?? '',
  }
}

const RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }
const BUILD: readonly Phase[] = ['implement', 'fix']
const THINK: readonly Phase[] = ['plan', 'analyze']
const TALK: readonly Phase[] = ['chat', 'trivial']

/** How much of a command's own prompt the classifier reads when the command has no description. */
export const COMMAND_BODY = 800

/**
 * What the classifier reads for a slash command the person typed: its line as typed, where the arguments are their
 * request. With no arguments the line says nothing of the work, so what the command says it does goes with it: its
 * description, else the start of the prompt it expands to.
 */
export function commandText(line: string, args: string, description: unknown, body: string): string {
  if (args.trim()) return line
  const about = typeof description === 'string' && description.trim() ? description.trim() : body.trim().slice(0, COMMAND_BODY)
  return about ? `${line}\n\nWhat the command does: ${about}` : line
}

/** The work without the effort the person asked for: the rule's effort again. */
export function unasked(task: Task, config: Config = DEFAULTS): Task {
  const { asked: _a, build: _b, ...rest } = task
  return { ...rest, effort: effortFor(rest.phase, rest.hard, false, config) }
}

/**
 * The effort a message gets, given the work under way.
 * - a follow-up to unfinished work keeps that work's effort, unless it moves the work on from thinking (plan, analyze) to
 *   building, which the rule sets anew (after a plan: the build effort);
 * - a question about the work (chat) takes its own effort and leaves the work under way in place: about a build, answering
 *   it builds nothing; about a plan or an analysis, its answer is in the work so far, while one that needs new reasoning
 *   comes as analyze and one that says the work fell short as faulted, and both keep the work's effort;
 * - a word to go on ("done", "ok", "continue": trivial) keeps the work's effort, a build's as a plan's: the agent goes on
 *   with that work;
 * - a side question or a closing word takes its own effort and leaves the work under way in place;
 * - a new task, or one that needs more, takes its own effort.
 */
export function carry(task: Task | null, pick: Route, text: string, config: Config = DEFAULTS): { route: Route; task: Task } {
  const fresh: Task = { phase: pick.phase, hard: pick.hard, effort: pick.effort, text, asked: pick.asked, build: pick.build }
  if (!task) return { route: pick, task: fresh }
  if (pick.release) task = unasked(task, config)
  // The person names the effort: it stands, and the work under way keeps it.
  if (pick.asked) return { route: pick, task: pick.continues ? { ...task, effort: pick.asked, asked: pick.asked, build: pick.build ?? task.build } : fresh }
  if (pick.continues && pick.build) task = { ...task, build: pick.build }
  // An effort the person asked for this work holds for its follow-ups.
  if (pick.continues && task.asked && !(THINK.includes(task.phase) && BUILD.includes(pick.phase))) {
    return { route: { ...pick, effort: task.asked, kept: true, asked: task.asked, why: `you asked for ${task.asked}` }, task }
  }
  // A question about building (implement, fix) takes its own light effort: answering it builds nothing. A word to go on
  // ("done", "continue") comes as trivial and keeps the build's effort below: the agent builds on.
  if (pick.continues && pick.phase === 'chat' && BUILD.includes(task.phase)) {
    return { route: { ...pick, why: `${pick.why} (a question about the build: its own effort)` }, task }
  }
  // A question about thinking work (plan, analyze) takes its own effort too: its answer is already in that work. A
  // follow-up that needs new reasoning comes as analyze, pushback on the work as faulted, and a word to go on
  // ("continue") as trivial: those keep the work's effort below.
  if (pick.continues && pick.phase === 'chat' && !pick.faulted && THINK.includes(task.phase)) {
    return { route: { ...pick, why: `${pick.why} (a question about the ${task.phase}: its own effort)` }, task }
  }
  const keep = (why: string) => ({
    route: { ...pick, phase: task.phase, hard: task.hard, effort: task.effort, kept: true, why },
    task,
  })
  // A side question or a closing word gets its own (talk) effort but does not end the work under way.
  if (!pick.continues) return { route: pick, task: TALK.includes(pick.phase) ? task : fresh }
  // Building what was planned takes the build effort, as an approved plan does: the hard thinking went into the plan.
  if (task.phase === 'plan' && BUILD.includes(pick.phase)) {
    const effort = task.build ?? effortFor(pick.phase, false, false, config)
    const built = { ...pick, hard: false, effort, ...(task.build ? { asked: task.build } : {}), why: `${pick.why} (carrying out the plan: ${task.build ? 'as you asked' : effort})` }
    return { route: built, task: { ...fresh, hard: false, effort, asked: task.build } }
  }
  if (THINK.includes(task.phase) && BUILD.includes(pick.phase)) return { route: pick, task: fresh }
  if (RANK[pick.effort] < RANK[task.effort]) return keep(`follow-up to ${task.phase}: keeps ${task.effort}`)
  return { route: pick, task: { ...task, phase: pick.phase, hard: pick.hard, effort: pick.effort } }
}

/**
 * What an approved plan sets: implementation at the build effort, never the hard-build one. The hard thinking went into
 * the plan; carrying it out does what it says. The plan is not judged for hardness: any real plan spans several modules,
 * so nearly every one would read as hard.
 */
export function afterPlan(plan: string, planning: Task | null = null, config: Config = DEFAULTS): { route: Route; task: Task } {
  // An effort the person asked for carrying out the plan stands over the build effort.
  const asked = planning?.build
  const effort = asked ?? effortFor('implement', false, false, config)
  const why = asked ? `plan approved: carrying it out at ${asked}, as you asked` : `plan approved: carrying it out (planned at ${config.plan})`
  return {
    route: { phase: 'implement', hard: false, effort, continues: true, why, ...(asked ? { asked } : {}) },
    task: { phase: 'implement', hard: false, effort, text: plan.slice(0, 600), ...(asked ? { asked } : {}) },
  }
}

/**
 * A message typed while a turn runs, read as it reaches the agent. A question, a correction or anything else about the
 * work under way changes nothing (null). A new task becomes the work under way; the turn's effort rises to it, and
 * never falls: the turn still finishes the work it was doing.
 */
export function midTurn(task: Task | null, current: Route | null, pick: Route, text: string, config: Config = DEFAULTS): { route: Route | null; task: Task } | null {
  if (pick.release && task?.asked) {
    const back = unasked(task, config)
    return { route: { ...(current ?? pick), effort: back.effort, asked: undefined, why: 'back to the rule, as you asked' }, task: back }
  }
  // The person names an effort for the work under way: it takes effect now, up or down.
  if (pick.asked && pick.continues && task) {
    return { route: { ...(current ?? pick), effort: pick.asked, asked: pick.asked, kept: false, why: `you asked for ${pick.asked}` }, task: { ...task, effort: pick.asked, asked: pick.asked } }
  }
  if (pick.continues && pick.build && task) return { route: null, task: { ...task, build: pick.build } }
  if (pick.continues || TALK.includes(pick.phase)) return null
  const fresh: Task = { phase: pick.phase, hard: pick.hard, effort: pick.effort, text }
  const now = current?.effort ?? task?.effort
  if (now && RANK[pick.effort] <= RANK[now]) return { route: null, task: fresh }
  return { route: { ...pick, why: `new task while working: ${pick.why}` }, task: fresh }
}

/**
 * A subagent thinks at least at the build effort: it works alone, no one catches a shallow answer, and its mistakes flow
 * into the main work.
 */
export function forAgent(pick: Route, config: Config = DEFAULTS): Route {
  const floor = config.build
  return RANK[pick.effort] < RANK[floor] ? { ...pick, effort: floor, why: `${pick.why} (subagent: at least ${floor})` } : pick
}

/**
 * What a notification's envelope says of the task it reports on, read from the fields the engine writes: whether a task
 * finished (the envelope has a status; a monitor's event has none), whether it failed, and whether it was a background
 * command (a shell, not an agent).
 */
export type Notice = { finished: boolean; failed: boolean; command: boolean }
export function noticeOf(text: string): Notice {
  // The envelope's own tags come first: a result quoted inside it comes after them.
  const status = /<status>\s*([a-z_]+)\s*<\/status>/.exec(text)?.[1]
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? ''
  return { finished: status !== undefined, failed: status === 'failed', command: /^\s*Background command\b/.test(summary) }
}

/**
 * A notification with work under way. It keeps the work's effort when the agent must think it through (the classifier
 * reads plan or analyze, or a hard build), when the task failed, when a background command finished (its output is the
 * work's own next step, read only by the agent), or when the work is a hard build (what an agent hands back there often
 * leads into its risky or tricky part, which its text does not show); with no pick, too. A hard build step goes at least at its own
 * effort, above a plain build's. Otherwise (an agent's result to relay or hand to the next agent) its own pick, never
 * above the work's effort and at least the build effort; a finished task's result during a plan or an analysis at
 * least the analyze effort (high), since it feeds that thinking. With no work known, the notification's own pick.
 */
export function forNotice(pick: Route | null, task: Task | null, notice: Notice = { finished: false, failed: false, command: false }, config: Config = DEFAULTS): Route | null {
  if (!task) return pick
  // A hard step the work under way did not need yet (a check failed in a plain build) goes at its own effort.
  const keep = (why: string): Route => pick?.hard && RANK[pick.effort] > RANK[task.effort]
    ? { ...pick, continues: true, why: `notification: ${pick.why} (hard ${pick.phase}: above the work's ${task.effort})` }
    : { phase: task.phase, hard: task.hard, effort: task.effort, continues: true, kept: true, why }
  if (!pick) return keep('notification: at the work under way')
  if (notice.failed) return keep('notification: the task failed: at the work under way')
  if (notice.command) return keep('a command finished: at the work under way')
  if (task.hard) return keep(`notification: ${pick.why} (in a hard build: at the work under way)`)
  if (THINK.includes(pick.phase) || pick.hard) return keep(`notification: ${pick.why} (${pick.hard ? `hard ${pick.phase}` : pick.phase}: at the work under way)`)
  // A finished task's result during a plan or an analysis feeds that thinking: at least the analyze effort.
  const least = THINK.includes(task.phase) && notice.finished ? config.analyze : config.build
  const floor = RANK[pick.effort] < RANK[least] ? least : pick.effort
  const effort = RANK[floor] > RANK[task.effort] ? task.effort : floor
  return { ...pick, effort, continues: true, why: `notification: ${pick.why} (${effort})` }
}

export function parse(reply: string, config: Config = DEFAULTS): Route | null {
  const match = reply.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const v = JSON.parse(match[0]) as Record<string, unknown>
    const phase = PHASES.find(x => x === v.phase)
    if (!phase) return null
    const hard = v.hard === true && (phase === 'implement' || phase === 'fix')
    const asked = EFFORTS.find(x => x === v.asked)
    const build = EFFORTS.find(x => x === v.build)
    const why = String(v.why ?? '').slice(0, 80)
    const release = v.asked === 'auto'
    const faulted = v.faulted === true
    return {
      phase, hard, effort: asked ?? effortFor(phase, hard, false, config),
      // Restating the last answer is light work of its own, not a step of the work under way.
      continues: v.continues === true && v.restate !== true,
      why: asked ? `you asked for ${asked}: ${why}` : why,
      ...(asked ? { asked } : {}), ...(build ? { build } : {}), ...(release ? { release } : {}), ...(faulted ? { faulted } : {}),
    }
  } catch {
    return null
  }
}

export const SHORT: Record<Effort, string> = { low: 'low', medium: 'med', high: 'high', xhigh: 'xhigh', max: 'max' }

// Measuring: compare turns of the same phase with and without the pilot, and count what the pilot itself costs.

// $ per million tokens at API prices — one unit to weigh Opus, Fable and Haiku tokens against each other
// (on a subscription the same weights spend the usage limit). Cache writes at the 1-hour rate, 2× input.
const PRICE = {
  opus: { input: 4, out: 20, cacheRead: 0.2, cacheWrite: 8 },
  fable: { input: 10, out: 50, cacheRead: 0.25, cacheWrite: 20 },
  haiku: { input: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.2 },
}
type Tokens = { input: number; out: number; cacheRead: number; cacheWrite: number }
const priced = (t: Tokens, p: Tokens) => (t.input * p.input + t.out * p.out + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) / 1e6
/** What a turn's main-loop requests cost: input, output and cache, so fewer steps at a lower effort count too. */
export const turnCost = (r: TurnRecord) => priced(r, r.model.includes('fable') ? PRICE.fable : PRICE.opus)
/** What classifying a turn's messages cost on Haiku. */
export const classifierCost = (c: Spend) => priced(c, PRICE.haiku)

const count = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)

/**
 * The turn records of one session file (JSONL). A line that does not parse (a write cut short) or lacks what a turn is
 * compared by (time, session, phase, arm) is skipped; a missing count reads as 0, a missing model as unknown.
 */
export function parseRecords(text: string): TurnRecord[] {
  const out: TurnRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let v: unknown
    try {
      v = JSON.parse(line)
    } catch {
      continue
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const r = v as Record<string, unknown>
    if (typeof r.t !== 'number' || typeof r.s !== 'string' || !PHASES.some(x => x === r.phase) || (r.arm !== 'auto' && r.arm !== 'control')) continue
    out.push({
      ...(r as unknown as TurnRecord),
      model: typeof r.model === 'string' ? r.model : '',
      steps: count(r.steps), out: count(r.out), input: count(r.input), cacheRead: count(r.cacheRead), cacheWrite: count(r.cacheWrite), ms: count(r.ms),
    })
  }
  return out
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}
const usd = (x: number) => `${x < 0 ? '−' : ''}$${Math.abs(x) < 0.01 && x !== 0 ? Math.abs(x).toFixed(4) : Math.abs(x).toFixed(2)}`
const kTok = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n))

/**
 * A turn fell short when it was aborted, or the person's answer to it says it did (faulted, read by the classifier).
 * A main-loop turn (the person's or a notification's) is answered only by the very next main-loop turn of its session,
 * and only when that one is the person's: a notification's turn in between means the person answered none of them,
 * so a complaint made later is not taken for theirs. A subagent's run is judged by the person's next prompt in the
 * session. A record with no model time (gen) carries no faulted flag either: for it, the prompt being a fix stands in.
 * A rough sign of quality: the person does not always say so, and says so of work that was never the turn's.
 */
export function short(records: readonly TurnRecord[]) {
  const out = new Map<TurnRecord, boolean>()
  const bySession = new Map<string, TurnRecord[]>()
  for (const r of records) bySession.set(r.s, [...(bySession.get(r.s) ?? []), r])
  const person = (x: TurnRecord) => (x.who ?? 'person') === 'person'
  for (const list of bySession.values()) {
    list.sort((a, b) => a.t - b.t)
    list.forEach((r, i) => {
      const later = list.slice(i + 1)
      const judge = r.who === 'agent' ? later.find(person) : later.find(x => x.who !== 'agent')
      const said = judge && person(judge) ? (judge.faulted ?? (judge.gen === undefined && judge.phase === 'fix')) : false
      out.set(r, r.reason === 'aborted' || said)
    })
  }
  return out
}

/** A seeded generator: the same records give the same range on every run. */
function seeded(seed: number) {
  let x = seed >>> 0
  return () => {
    x = (x + 0x6d2b79f5) >>> 0
    let t = Math.imul(x ^ (x >>> 15), 1 | x)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * How much less a pilot turn costs than a control turn, as a share of the control's cost, with the 90% range
 * of that share by resampling both arms (bootstrap): turns differ in size far more than efforts do, so a mean alone
 * says little until the range is narrow.
 */
export function saving(auto: readonly number[], control: readonly number[], rounds = 2000) {
  const share = (a: readonly number[], c: readonly number[]) => (mean([...c]) - mean([...a])) / (mean([...c]) || 1)
  const rand = seeded(auto.length * 7919 + control.length)
  const pick = (xs: readonly number[]) => Array.from(xs, () => xs[Math.floor(rand() * xs.length)]!)
  const shares = Array.from({ length: rounds }, () => share(pick(auto), pick(control))).sort((a, b) => a - b)
  return { share: share(auto, control), low: shares[Math.floor(rounds * 0.05)]!, high: shares[Math.floor(rounds * 0.95)]! }
}

/** The pilot's arm less the control's, in points of a 0/1 measure, with its 90% range (positive: fewer). */
export function gap(auto: readonly number[], control: readonly number[], rounds = 2000) {
  const diff = (a: readonly number[], c: readonly number[]) => mean([...c]) - mean([...a])
  const rand = seeded(auto.length * 104729 + control.length)
  const pick = (xs: readonly number[]) => Array.from(xs, () => xs[Math.floor(rand() * xs.length)]!)
  const diffs = Array.from({ length: rounds }, () => diff(pick(auto), pick(control))).sort((a, b) => a - b)
  return { share: diff(auto, control), low: diffs[Math.floor(rounds * 0.05)]!, high: diffs[Math.floor(rounds * 0.95)]! }
}

const percent = (x: number) => `${x >= 0 ? '−' : '+'}${Math.abs(Math.round(x * 100))}%`

/** The model's own time on a turn: its answering, without tools and subagents (a record with no gen: the whole turn). */
const speed = (r: TurnRecord) => r.gen ?? r.ms
const sec = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
const points = (x: number) => `${x >= 0 ? '−' : '+'}${Math.abs(Math.round(x * 100))} pts`
export const fmt = { usd, sec, percent, points, kTok }

export const GROUPS = [['person', 'your prompts'], ['notification', 'notifications'], ['agent', 'subagents']] as const
/** A group's title: a listed agent's by its type, else by whose turns it holds. */
export const groupTitle = (who: Who, agent?: string) => (agent ? `agent ${agent}` : GROUPS.find(([w]) => w === who)![1])
/** Turns each arm needs before a phase is compared. */
export const ENOUGH = 5

/** A measure's verdict, lower being better for each (cost, time, falling short), and while it is unclear the turns
 * each arm would still need, if the gap holds, for the range to leave zero (it narrows as one over the root of n). */
function measured(r: { share: number; low: number; high: number }, a: number, c: number): MeasureRead {
  const verdict = r.low > 0 ? 'better' : r.high < 0 ? 'worse' : 'unclear'
  let more: MeasureRead['more'] = null
  if (verdict === 'unclear' && r.share !== 0) {
    const grow = ((r.high - r.low) / 2 / Math.abs(r.share)) ** 2
    more = { pilot: Math.max(1, Math.ceil(a * grow - a)), control: Math.max(1, Math.ceil(c * grow - c)) }
  }
  return { ...r, verdict, more }
}
export const VERDICT = { better: 'better with Effort Pilot: clear', worse: 'worse with Effort Pilot: clear', unclear: 'not clear yet' } as const
/** The net's verdict in words, the text report's and the pane's. */
export function netWords(n: NonNullable<ReportData['net']>) {
  if (n.verdict === 'pays') return 'Effort Pilot pays for itself'
  if (n.verdict === 'costs') return 'Effort Pilot costs more than it saves'
  return `not clear yet: the cost range spans zero in ${n.unclear} of ${n.phases} compared phase${n.phases === 1 ? '' : 's'}`
}

/**
 * The measurement's read, always against high: the person's own effort high is the one baseline. Three measures per
 * phase: cost, speed (the model's time) and quality (how often the turn fell short). Only turns where the efforts
 * differ are compared: pilot turns that went at another effort than high, against control turns left at high where
 * the pilot would have sent another. Turns at another own effort, efforts asked for in words and turns marked as a
 * test are left out.
 */
export function reportData(all: readonly TurnRecord[]): ReportData {
  const records = all.filter(r => !r.test && r.reason !== 'error')
  const fell = short(records)
  const phases: PhaseRead[] = []
  let saved = 0
  let faster = 0
  let compared = 0
  let done = 0
  let unclear = 0
  const arm = (xs: TurnRecord[]): ArmRead | null => xs.length
    ? { turns: xs.length, cost: mean(xs.map(turnCost)), time: median(xs.map(speed)), short: mean(xs.map(x => (fell.get(x) ? 1 : 0))) }
    : null
  // A listed agent's runs (via) are a group of their own per agent type, apart from the groups by who.
  const listed = [...new Set(records.filter(r => r.via && r.agent).map(r => r.agent!))].sort()
  const groups = [
    ...GROUPS.map(([who]) => ({ who: who as Who, agent: undefined as string | undefined, has: (r: TurnRecord) => !(r.via && r.agent) && (r.who ?? 'person') === who })),
    ...listed.map(agent => ({ who: 'agent' as Who, agent, has: (r: TurnRecord) => !!r.via && r.agent === agent })),
  ]
  for (const { who, agent, has } of groups) for (const phase of PHASES) {
    const turns = records.filter(r => has(r) && r.phase === phase)
    if (!turns.length) continue
    // A pilot turn counts where its own pick went (an effort held over from before the turn is not its pick).
    const a = turns.filter(r => r.arm === 'auto' && !r.asked && r.base === 'high' && r.sent === r.chosen && r.sent !== 'high')
    const c = turns.filter(r => r.arm === 'control' && r.base === 'high' && r.sent === 'high' && r.chosen !== 'high')
    const read: PhaseRead = {
      who, ...(agent ? { agent } : {}), phase,
      efforts: [...new Set(a.map(x => x.sent).filter((x): x is Effort => Boolean(x)))],
      pilot: arm(a), control: arm(c),
      same: turns.length - a.length - c.length,
      need: { pilot: Math.max(0, ENOUGH - a.length), control: Math.max(0, ENOUGH - c.length) },
    }
    if (a.length >= ENOUGH && c.length >= ENOUGH) {
      done++
      saved += (mean(c.map(turnCost)) - mean(a.map(turnCost))) * a.length
      faster += (mean(c.map(speed)) - mean(a.map(speed))) * a.length
      compared += a.length
      const bit = (x: TurnRecord) => (fell.get(x) ? 1 : 0)
      read.measures = {
        cost: measured(saving(a.map(turnCost), c.map(turnCost)), a.length, c.length),
        time: measured(saving(a.map(speed), c.map(speed)), a.length, c.length),
        short: measured(gap(a.map(bit), c.map(bit)), a.length, c.length),
      }
      if (read.measures.cost.verdict === 'unclear') unclear++
    }
    phases.push(read)
  }
  const sent: ReportData['sent'] = {}
  for (const r of records) sent[r.sent ?? 'none'] = (sent[r.sent ?? 'none'] ?? 0) + 1
  // The classifier runs on every turn, control turns too (they need a phase to be compared by).
  const counted = records.filter(r => r.cls)
  const cls = counted.map(r => r.cls!)
  const spent = sum(cls.map(classifierCost))
  const perTurn = counted.length ? spent / counted.length : 0
  const calls = sum(cls.map(c => c.calls))
  return {
    turns: records.length,
    days: records.length ? (Math.max(...records.map(r => r.t)) - Math.min(...records.map(r => r.t))) / 86_400_000 : 0,
    sessions: new Set(records.map(r => r.s)).size,
    left: all.length - records.length,
    phases,
    sent,
    classifier: counted.length
      ? {
          calls, turns: counted.length, cost: spent, perTurn,
          input: sum(cls.map(c => c.input + c.cacheRead + c.cacheWrite)), out: sum(cls.map(c => c.out)),
          wait: sum(cls.map(c => c.ms)) / Math.max(1, calls) / 1000, missing: records.length - counted.length,
        }
      : null,
    net: compared
      ? {
          phases: done, turns: compared, saved: saved / compared, perTurn, faster: faster / compared, unclear,
          // The classifier's own cost is near-certain: once every phase's saving is clear, the sign decides.
          verdict: unclear ? 'unclear' : saved / compared - perTurn > 0 ? 'pays' : 'costs',
        }
      : null,
  }
}

/** The report as text: where no pane can be drawn (claude -p), and the pane's own words. */
export function report(all: readonly TurnRecord[]) {
  const d = reportData(all)
  if (!d.turns) return 'no turns recorded yet'
  const why = 'at high either way, another own effort, an effort you asked for, or one held over'
  const row = (x: ArmRead) =>
    `${x.turns} turns · ${usd(x.cost)} a turn · model time ${sec(x.time)} median · fell short ${Math.round(x.short * 100)}%`
  const judged = (name: string, m: MeasureRead, show: (x: number) => string) =>
    `${name} ${show(m.share)} (90% range ${show(m.low)} … ${show(m.high)}) → ${VERDICT[m.verdict]}`
  const lines = d.phases.map(p => {
    const title = groupTitle(p.who, p.agent)
    if (!p.pilot && !p.control) return `${title} · ${p.phase}: ${p.same} turns, none comparable (${why})`
    const head = `${title} · ${p.phase} (pilot ${p.efforts.join('/') || '—'} vs high)`
    const verdict = p.measures
      ? [judged('cost a turn', p.measures.cost, percent), judged('model time', p.measures.time, percent), judged('fell short', p.measures.short, points)].join('\n  ')
      : `too few turns to compare (need ${ENOUGH}+ in each; ${p.need.pilot} pilot and ${p.need.control} control to go)`
    return `${head}:\n  pilot:   ${p.pilot ? row(p.pilot) : 'none'}\n  control: ${p.control ? row(p.control) : 'none'}${p.same ? `\n  ${p.same} more not compared (${why})` : ''}\n  ${verdict}`
  })
  const c = d.classifier
  const own = c
    ? `Effort Pilot's own cost (Haiku classifier): ${c.calls} calls on ${c.turns} turns, ${kTok(c.input)} in / ${kTok(c.out)} out tokens ≈${usd(c.cost)} — ${usd(c.perTurn)} a turn; it waits ${c.wait.toFixed(1)}s before a prompt${c.missing ? ` (${c.missing} turns carry no classifier cost)` : ''}`
    : 'Effort Pilot\'s own cost: not recorded yet'
  const n = d.net
  const net = n
    ? `net over ${n.phases} compared phases (${n.turns} pilot turns): cost ${usd(n.saved)} a turn saved − classifier ${usd(n.perTurn)} = ${usd(n.saved - n.perTurn)} → ${netWords(n)}; model time ${sec(Math.abs(n.faster))} a turn ${n.faster >= 0 ? 'faster' : 'slower'}; quality: see "fell short" per phase`
    : `net: not known yet — no phase has ${ENOUGH}+ turns on each arm`
  return [
    `${d.turns} turns over ${d.days.toFixed(1)} days, ${d.sessions} sessions${d.left ? ` (${d.left} test or failed turns left out)` : ''} · costs at API prices (a common unit for Opus and Haiku tokens)`,
    ...lines,
    own,
    net,
  ].join('\n\n')
}
