# Changelog

All notable changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions: [SemVer](https://semver.org/).

## [1.5.2] — 2026-11-06

- A notification or a subagent's hand-back that arrives while a subagent is still working gets its own effort. Claude Code hands such a message the subagent's turn, so the pilot took it for one delivered into a running turn: it was never classified, and the turn ran at whatever effort the last one had. A prompt you send while only a subagent works is routed as you send it, once.
- The report's "fell short" counts a turn only when the very next message is yours and says it fell short. A turn followed by a notification's turn is no longer charged with a complaint you made later about other work. A subagent's run is still judged by your next message.
- With `CLAUDE_CODE_DISABLE_ULTRATHINK` set, the word `ultrathink` no longer raises the turn to `xhigh`: the classifier is told the keyword is off.

## [1.5.1] — 2026-11-05

- The report's net line no longer says the pilot pays for itself (or costs more than it saves) from the point estimate alone. While any compared phase's cost range still spans zero, it keeps the numbers and says "not clear yet", with how many compared phases are still unclear. Once every compared phase's cost verdict is clear, the sign of the saving less the classifier's cost decides, as before. The report pane says the same.

## [1.5.0] — 2026-11-05

- Notifications while work is under way are classified instead of always keeping the work's effort. An agent's result the agent only relays or hands to the next agent runs at its own effort: at least `medium`, never above the work's. The work's effort is kept when the result needs thinking (a plan, an analysis, a hard step), reports a failure, is a background command's output, or arrives in a hard build. During a plan or an analysis, a finished task's result never goes below `high`.
- A message from another Claude session is routed as a notification. It used to run at the session's own effort.
- `hard` follows what the agent itself does in the turn: briefing or relaying is not hard; a risky operation is. An order to act (deploy, push, pay, delete) is a build step, never chat. "Why is this slow", "how does it work under the hood" and "should we…" are analysis.
- A subagent brief that only finds, lists or collects runs at `medium`; one that weighs what it finds (a cause, a design, a recommendation) at the analysis effort; one that acts on the world (sends, posts, writes production data) at the hard build effort.
- Turn records keep the classifier's own pick (`pick`) and whether the work's effort was kept (`kept`).
- On a labelled set of 420 messages, turns that need `high` get it in about 84% of runs (was 76%), and turns that need less get less more often.

## [1.4.1] — 2026-11-05

- On a model the pilot does not know, a switch that rewrites the prompt cache on a short conversation is now caught, and the pilot stands aside on that model. It used to look for a cache read under half of the prompt before, which the system prompt and tools alone pass on a short conversation; it now looks at how much of that prompt was not read back.

## [1.4.0] — 2026-11-05

- `ultrathink` runs its turn at `xhigh`, as Claude Code does. The classifier used to read the keyword as asking for `max`, and the pilot then sent `max` in place of Claude Code's `xhigh`. A message that only quotes or talks about the keyword asks for nothing.
- A built-in subagent on another model than the session's is set by its brief again. Since Claude Code 2.1.317 such a subagent starts at that model's saved effort or its default, which the pilot took for an effort chosen for that agent and left alone. On the session's own model, an effort other than the session's is still the agent's own, as is a number.
- With `CLAUDE_CODE_SUBAGENT_EFFORT` set, subagents run at the effort it names: the pilot makes no classifier call for them and leaves them as they start.

## [1.3.1] — 2026-11-05

- A word to go on during a build ("done", "ok", "continue") keeps the build's effort. It used to take the talk effort, and the agent then carried on building at `low`. A question about the build still runs at the talk effort, as it builds nothing.
- A skill or prompt command you type (`/some-plugin:create-plan <what you want>`, or a built-in one such as `/init`) is classified like any typed message, from its line as typed. Typed with no request after it, it is classified by what the command says it does (its description, else the start of its instructions). It used to be skipped, so the turn ran at the effort of the turn before and its record was not marked as yours. Built-in commands that run on their own (`/clear`, `/compact`, `/model`, `/effort`, `/effort-pilot`) are still left alone, and a turn the pilot did not read is no longer recorded under the previous turn's label.

## [1.3.0] — 2026-11-04

- `/effort-pilot report` opens a pane beside the chat with charts: per phase, bars for pilot vs control (cost a turn, model time, fell short) with their 90% ranges and a verdict in words, turns by effort sent, the classifier's cost and wait, and the net. While a phase has too few turns, the pane says so and claims no verdict. A Refresh button (`r`) reads the records again. Under `claude -p`, or where no pane can be shown, the command returns the text report as before.
- "Fell short" counts fewer false failures: the classifier no longer reads a new request, a change of taste (another colour, layout or order), a decision the person makes otherwise, or a problem in something the agent did not make as a sign that the previous turn failed.

## [1.2.1] — 2026-11-04

- A plain question about a plan or an analysis (asking what was found, to explain it again, where it stands) now runs at the talk effort instead of keeping the plan's or the analysis's. Its answer is already in that work. A follow-up that needs new reasoning (a doubt, a new case), or says the work was wrong, keeps the work's effort, as does a word to go on ("continue"). The plan or analysis stays the work under way.

## [1.2.0] — 2026-11-04

- Effort Pilot stands aside where effort is one setting of the whole request, since there every switch rewrites the conversation's prompt cache: Claude 4.x and older, Fable 5 (not 5.1), sessions without an Anthropic login (Bedrock, Vertex, Foundry, a gateway), and an effort set as a number. Your own effort goes untouched, nothing is classified (no Haiku call), no control turns or records are made, and subagents keep the session's effort. The newer models with an Anthropic login (Opus 5 and 5.5, Fable 5.1) switch as before: there effort goes per message and the cache holds.
- On a model it does not know, it watches the cache: a switch that reads less than half of the prompt before it from the cache (same model, the conversation only grown, within five minutes) marks the model, and from the next request your own effort stands, for the rest of the session. One toast says so.
- The band, the status line, `/effort-pilot` and `/effort-pilot stats` say when and why it stands aside.

## [1.1.2] — 2026-11-04

- An approved plan is built at the build effort from the very next request, and plan mode entered mid-turn runs at the plan effort at once. Claude Code applies a new per-message effort only on a request with new input, and a plan's approval arrives as a tool result, so the rest of that turn used to stay at `xhigh` until your next message. The pilot now adds one short line to the conversation after the approval, which counts as new input. The "running at xhigh for now" warning is gone.

## [1.1.1] — 2026-11-04

- The first prompt after `/clear` is classified again. `/clear` starts a conversation with empty plugin state, so that prompt (and the work it started) ran at the session's own effort and left no turn record.
- `/effort-pilot off` or `shadow`, and an effort set by hand with `/effort <level>`, now last across `/clear` (one or several in a row), as Claude Code's own effort does. Before, the pilot came back at auto and overrode them. A new session still starts at auto.
- Subagent turn records (with **measure** on) mark an effort the brief asked for, so `/effort-pilot report` leaves those runs out of the comparison, as it does for the main loop.

## [1.1.0] — 2026-11-03

- Turn records (with **measure** on) move to the plugin's data folder, `~/.claude/plugins/data/effort-pilot-effort-pilot/turns/`, so uninstalling the plugin removes them (unless `--keep-data`). Records from the old folder, `~/.claude/effort-pilot/turns/`, move there on the first turn or report; the old files are left empty.
- Records are bounded: one file a day, 90 days kept, at most 90 files, each under 3 MiB.
- `/effort-pilot reset` deletes every turn record and says how many it cleared.

## [1.0.0] — 2026-11-02

First public release.

- Effort per turn from a Haiku classifier: plan `xhigh`, analyze `high`, build `medium` (`high` when hard), talk `low`.
- Follow-ups keep the effort of the work they belong to; side questions take their own.
- Efforts asked for in words, in any language; "back to auto" releases them.
- Plan mode at `xhigh`; an approved plan is built at `medium`.
- Subagents (at least `medium`) and background notifications.
- Band above the prompt, status line and toasts.
- Settings in `/config`: efforts per phase, managed models, headless runs, measuring.
- Optional measuring against `high`: cost, model time and turns that fell short, with `/effort-pilot report`.
