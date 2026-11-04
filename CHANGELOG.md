# Changelog

All notable changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions: [SemVer](https://semver.org/).

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
