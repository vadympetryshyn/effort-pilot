# Changelog

All notable changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions: [SemVer](https://semver.org/).

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
