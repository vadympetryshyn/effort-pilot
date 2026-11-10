# Changelog

All notable changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions: [SemVer](https://semver.org/).

## [1.10.0] — 2026-11-10

- A model for plan mode: set `planModeModel` in `/config` → **effort-pilot** to an alias (`fable`, `opus`) or a full model id, and while plan mode is on the main conversation's requests go on that model, at the plan effort. Once the plan is approved, or plan mode is left, they go on the session's own model again, at the effort the pilot picks (the build effort for an approved plan). Only plan mode switches the model, never a plan the classifier reads from a message: every switch costs one request that re-reads the conversation without the prompt cache, so it follows a setting you turn on yourself. Subagents keep the model they run on. It applies while Effort Pilot is on and the session's model is one it manages; on a plan-mode model where effort is one setting of the whole request (such as Fable 5), the model still switches and your own effort is left on it. The status line and the band name the model (`effort: high plan · fable-5-2`), the line added when plan mode starts or ends mid-turn says where the requests now go, and a turn in plan mode is recorded on the model its requests went on. A switch of model is never taken for an effort switch that rewrote the cache. Empty (the default): the model is never changed, as before.
- The first prompt after you leave plan mode with Shift+Tab is classified like any other. It used to run at the plan effort, with the band still saying `plan mode … until you leave it`, until the prompt after it.

## [1.9.0] — 2026-11-10

- Plans and plan mode now run at `high` by default instead of `xhigh`: the same depth as leaving effort on `high`, at less cost and time per planning turn. If you prefer the deeper plans, set `planEffort` to `xhigh` (or `max`) in `/config` → **effort-pilot**; a value you saved yourself is kept. Asking for a level in words ("plan it on xhigh") and `ultrathink` work as before.

## [1.8.2] — 2026-11-10

- A level you name for another AI or tool to run at ("have Codex write the articles at high effort") is no longer taken as the effort you asked Claude to think at. It was read as your ask, and since an asked level holds for the whole piece of work, the plan it came with and the turns after it ran at that level. Such a level now counts as a setting, like a level named as a default or a rule; a level you name for Claude's own work holds as before.

## [1.8.1] — 2026-11-09

- A turn the classifier gives no answer for (a timeout, an outage) runs at your own effort instead of the effort the turn before it picked: a hard request right after a light chat turn no longer goes at `low`. The status line says `effort: your own · the classifier gave no answer`, and the band shows your own effort with the same reason. It holds for that turn only; the next turn is classified as usual. Such a turn is not recorded. A turn in plan mode, and a message typed mid-turn, work as before; a notification that arrives during work under way still goes at that work's effort.
- The report no longer compares plan-mode turns. Plan mode never runs a control turn, so its turns filled the pilot side of the plan phase against only the plan requests made outside plan mode. A turn in plan mode is now recorded with `planMode: true` and counted as not compared. Records written before this release cannot be told apart and still count until they age out (90 days); `/effort-pilot reset` clears them.
- Each model is priced at its own rate in the report: Fable 5.2, Fable 5.1, Fable 5, Opus 5.5 and Opus 5 by Anthropic's current price list, where every Fable model used to be priced as Fable 5.1 and every other model as Opus 5.5. A version not on the list takes its family's newest price.

## [1.8.0] — 2026-11-09

- Subagents are no longer sent at `high` for work that does not need it. A brief that finds, maps or lists code, collects facts or makes an inventory is light work, however thorough it asks the agent to be; `high` goes to briefs that ask the agent itself for a conclusion: a cause, a verdict, a judgement of cases, the defects of a change, a recommendation, a design. Routine steps (commit, run the tests, the usual deploy, report back) no longer make a build hard: a fix whose cause the brief names, a scoped change, layout, copy or config goes at the build effort. Measured on a few hundred labelled real briefs: work that needs only `medium` was recognised in 47% of reads instead of 37%, with `high` work missed about as rarely as before.
- A long brief is read up to 12,000 characters instead of 4,000, so a scheduled job's session is classified with its check's output in view.

## [1.7.2] — 2026-11-09

- An effort level the classifier reads from your message is read twice, and only a level both reads agree on is taken: the lower one, or none when only one read names a level. Now and then the classifier read a level you never named (such as `max` from "think it through well"), and since an asked level holds for the whole piece of work, one misread could run several turns at `max`. A level you really name is read the same both times and holds as before; if the second read gets no answer, the first stands. The extra Haiku call happens only on a turn whose first read names a level (or takes one back), so most turns still make one call.

## [1.7.1] — 2026-11-07

- A steered subagent woken again after `/reload-plugins` (or after the plugin was turned on mid-run) keeps the effort it runs at. The pilot had forgotten its brief, so it read the message that woke the agent, such as a background task's notification, as the whole brief and could lower the rest of a hard build. It now leaves such a run at its own effort; its transcript line says `left as is: resumed before the pilot saw its brief`. The same holds for an agent whose brief got no classifier answer at its first spawn: when it is woken again, it stays at its own effort.

## [1.7.0] — 2026-11-07

- You see the effort of every subagent. Where it is known at spawn (set by the pilot, named in the Agent call, or `CLAUDE_CODE_SUBAGENT_EFFORT`), the agent's description ends in `· effort <level>`: it shows in the agents panel and in the agent's "finished" line. Where it is known only at the agent's first request (an agent running at the effort its own definition sets, a control run, a model the pilot does not manage, an agent started by another subagent), one dim line in the transcript says it, e.g. `effort-pilot: reviewer «Check the login flow» — effort high (its own)`. One line per agent run, not sent to the model.
- The band and `/effort-pilot stats` show each subagent's real level and who set it (`high (own)`, `low (call)`, `med (not managed)`) instead of "its own"; the band lists the agents running, then the most recent finished ones.
- A subagent's brief can no longer raise its effort as if you had asked for a level: the classifier sometimes read a brief such as "thoroughness: very thorough" as an ask for `max`. A brief now sets the effort by the kind of work only; to name a level for a subagent, use the Agent call's effort.

## [1.6.1] — 2026-11-07

- A test for the report pane's per-agent groups. No change in behaviour.

## [1.6.0] — 2026-11-07

- Your own and plugin agents can be steered too. A new option, `agents`, lists agent types the pilot sets by their brief, like the built-in ones, even when the agent's file declares an effort: a plugin's agent (`lab:builder`), every agent of a plugin (`lab:*`), your own or a project's agent by its name (`reviewer`), or `*` for every agent that is not built in. Empty by default: nothing changes until you list one. An effort named in the Agent call, `CLAUDE_CODE_SUBAGENT_EFFORT`, a number budget and a model the pilot does not manage still win; forks, teammates and workflow agents are left alone.
- A headless session started as an agent (`claude -p --agent <type>`) with `headless` on reads its first prompt as that agent's brief: never below the build effort. The agent is detected from Claude Code; a launcher can name it with the new `sessionAgent` option. If you already run `headless` with `--agent`, your first prompt is now read as a brief.
- Records of these runs carry `agent` and `via` (`listed` for a listed subagent, `session` for a headless agent session), and the report has its own groups per agent type, pilot against control.
- A fresh session no longer stops steering on a false cache alarm: Claude Code re-sends part of the first request on the second, which the cache check took for a rewrite caused by the effort switch.

## [1.5.3] — 2026-11-07

- In plan mode, an effort you ask for in the prompt ("plan it on max") now shows as asked on the band and the status line, and the turn is recorded as asked, so the report keeps it out of its comparisons instead of counting it as the pilot's own plan turn.
- A planned turn records the effort it actually planned at, also when the plan was approved and the build went on in the same turn. It used to record the plan setting whatever went out.

## [1.5.2] — 2026-11-06

- A subagent's hand-back (the message that returns a background agent's result) was skipped: its turn ran at whatever effort the last one had, and the report counted it as one of your prompts. It is now read like any background result: during a plan or an analysis at least `high`, otherwise at its own effort.
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
