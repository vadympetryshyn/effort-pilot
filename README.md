# What is Effort Pilot?

### Spend 20–50% fewer tokens and get responses ~1.5× faster in <img src="assets/claude-inline.svg" height="30" alt=""> Claude Code.

Effort Pilot switches the reasoning effort for every turn, automatically: plans get `xhigh`, building gets `medium`, questions and trivial tasks — a git commit, a push, a rename — get `low`. You stop paying for deep thinking where none is needed, and get more of it where it counts.

[![version](https://img.shields.io/github/v/release/vadympetryshyn/effort-pilot?label=version&color=d97757)](https://github.com/vadympetryshyn/effort-pilot/releases)
[![CI](https://github.com/vadympetryshyn/effort-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/vadympetryshyn/effort-pilot/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/vadympetryshyn/effort-pilot?style=flat&color=d97757)](https://github.com/vadympetryshyn/effort-pilot/stargazers)
[![last commit](https://img.shields.io/github/last-commit/vadympetryshyn/effort-pilot)](https://github.com/vadympetryshyn/effort-pilot/commits/main)

<img src="assets/hero-4.svg" alt="Effort Pilot switching effort: xhigh to plan, high to investigate, medium to build, low to commit and push" width="820">

## What you get

Same work, compared with leaving effort on `high` all the time: fewer tokens burned, faster responses, and fewer turns
you have to redo, because hard work gets more thinking, not less.

<img src="assets/why-2.svg" alt="Effort Pilot vs. always-on high: about 35% fewer tokens, 1.5x faster responses, 20% fewer turns that fall short" width="820">

<sub>≈ Approximate, from the author's own sessions; savings range from ~20% on hard work to ~50% and more on everyday turns. Every setup differs: measure yours with `/effort-pilot report`.</sub>

## Install

In Claude Code:

```
/plugin marketplace add vadympetryshyn/effort-pilot
/plugin install effort-pilot@effort-pilot
/reload-plugins
```

Or from your terminal, in one line (then start a new session):

```sh
claude plugin install effort-pilot --marketplace vadympetryshyn/effort-pilot
```

It is on as soon as it loads: from your next message, the line above the prompt shows `⏵ effort` with the effort it
picked and why. Nothing to configure — every setting has a default (the terminal install still says its options are
"not yet set": Claude Code counts any option you have not saved yourself, and the defaults apply). Works on Opus and Fable (Sonnet and Haiku are left to you). Needs a recent
Claude Code (tested on 2.1.318).

**Where it stands aside.** On the newer models (Opus 5 and 5.5, Fable 5.1) with an Anthropic login, effort is set per
message, and a switch costs no prompt cache. Elsewhere effort is one setting of the whole request, and every switch
would rewrite the conversation's prompt cache: on Claude 4.x and older, Fable 5, sessions on Bedrock, Vertex, Foundry or
a gateway, and an effort set as a number. There Effort Pilot leaves your own effort alone (no classifier call either),
and the band says so. On a model it does not know, it watches the cache: if a switch is seen to rewrite it, it stands
aside on that model for the rest of the session.

**Update:** `claude plugin marketplace update effort-pilot && claude plugin update effort-pilot@effort-pilot`, then
restart. **Pause:** `/effort-pilot off`. **Remove:** `/plugin uninstall effort-pilot@effort-pilot`.

## How it works

Before each turn a small, fast model (Haiku, ≈ $0.0002 a turn) reads your message and picks the effort:

| You… | Phase | Effort |
|---|---|---|
| ask for a plan, or use plan mode | plan | `xhigh` |
| ask a hard question, investigate a bug | analyze | `high` |
| ask to build or fix something | implement / fix | `medium` (`high` when hard) |
| approve a plan | implement | `medium` — the thinking went into the plan |
| ask a quick question, commit, push, run a command, a tiny edit | chat / trivial | `low` |

A band above the prompt shows the effort now, how it got there and why. Follow-ups that push the work on keep its effort (a word to go on, like "done" or "continue", too), and a side question doesn't drag it down; a plain question about the work (what was found, where it stands) runs at `low` — the answer is already there. A skill or prompt command you type with your request (`/create-plan …`) is read like any message; built-in commands (`/clear`, `/model`) are left alone.

## Features

- 🗣️ **Just say it.** "do this on max", "medium is enough", "plan it, then build on high" — in any language, typed or dictated. "back to auto" hands it back.
- 🧭 **Plan mode** runs at `xhigh`; the approved plan is built at `medium`.
- 🤖 **Subagents** get their own effort (never below the build effort, `medium` by default).
- 🔔 **Background results** continue at the effort of the work they serve.
- ✋ **You stay in charge.** `/effort <level>` pins it; `/effort-pilot on` resumes.
- 🔒 **Private.** Nothing leaves your machine but the Haiku call. Your effort setting is changed per message; the model is never changed, and the prompt cache stays intact (where a switch would rewrite it, Effort Pilot stands aside).

## Commands

| Command | |
|---|---|
| `/effort-pilot` | current state |
| `/effort-pilot on` · `off` · `shadow` | run · stop · only show what it would pick |
| `/effort-pilot stats` | this session's turns and efforts |
| `/effort-pilot classify <text>` | what it would pick for a message |
| `/effort-pilot report` | cost, speed and quality vs. `high` in a pane with charts beside the chat (as text under `claude -p`; needs **measure**) |
| `/effort-pilot reset` | delete the turn records **measure** kept |

## Settings

All in `/config` → **effort-pilot**.

| Setting | Default | |
|---|---|---|
| `planEffort` | `xhigh` | plans and plan mode |
| `analyzeEffort` | `high` | hard questions, investigations |
| `buildEffort` | `medium` | building and fixing |
| `hardBuildEffort` | `high` | building that is hard (many files, tricky logic) |
| `talkEffort` | `low` | questions, chat, tiny edits |
| `managedModels` | `opus,fable` | models whose effort it sets (never where effort is one setting per request: see above) |
| `headless` | off | also steer `claude -p` and SDK runs |
| `measure` | off | run the comparison below |
| `controlShare` | `30` | % of turns left at `high` while measuring |

## Measure it yourself

Turn on **measure**. A share of turns where Effort Pilot would pick something other than `high` is left at `high` (control turns). `/effort-pilot report` then compares, per phase, **cost per turn**, **model time** and **turns that fell short** (aborted, or your next message says it was wrong), each with a 90% range, and nets out what the classifier itself cost. Records (turn statistics, no prompt text) live in the plugin's data folder, `~/.claude/plugins/data/effort-pilot-effort-pilot/turns/`, one file a day, and are kept for 90 days. `/effort-pilot reset` deletes them; uninstalling the plugin removes them too (unless you uninstall with `--keep-data`).

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Questions and ideas go to
[Discussions](https://github.com/vadympetryshyn/effort-pilot/discussions); a turn that got the wrong effort is the most
useful [issue](https://github.com/vadympetryshyn/effort-pilot/issues/new?template=misrouted.yml).

If it saves you tokens, a ⭐ helps others find it.

## License

[MIT](LICENSE)
