# What is Effort Pilot?

### The right reasoning effort for every turn in <img src="assets/claude-inline.svg" height="30" alt=""> Claude Code, set for you.

Effort Pilot switches the reasoning effort for every turn, automatically: plans get `high`, building gets `medium`, questions and trivial tasks — a git commit, a push, a rename — get `low`. Deep thinking goes where it counts, and a quick question no longer waits on it. Want another model or level? Just say it, typed or dictated: "plan this on Fable 5.2 at high, then build on Opus at medium".

[![version](https://img.shields.io/github/v/release/vadympetryshyn/effort-pilot?label=version&color=d97757)](https://github.com/vadympetryshyn/effort-pilot/releases)
[![CI](https://github.com/vadympetryshyn/effort-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/vadympetryshyn/effort-pilot/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/vadympetryshyn/effort-pilot?style=flat&color=d97757)](https://github.com/vadympetryshyn/effort-pilot/stargazers)
[![last commit](https://img.shields.io/github/last-commit/vadympetryshyn/effort-pilot)](https://github.com/vadympetryshyn/effort-pilot/commits/main)

<img src="assets/hero-5.svg" alt="Effort Pilot switching effort: high to plan and to investigate, medium to build, low to commit and push" width="820">

## What you get

Compared with leaving effort on `high` all the time, on the author's own turns:

<img src="assets/why-4.svg" alt="Effort Pilot vs. always-on high: quick questions answered up to twice as fast, up to 10% fewer tokens, effort set every turn without /effort" width="820">

- **Quick answers, up to twice as fast.** A question or a chat turn runs at `low`: its median model time is about half that at `high` (−50%, 90% range −13% … −69%).
- **Plans lose nothing.** Plans and plan mode run at `high`, the same depth as always-on `high`; set `planEffort` to `xhigh` or `max` for more.
- **Up to 10% fewer tokens.** Every turn that drops from `high` to `medium` or `low` thinks less, so it spends fewer tokens. How much you save depends on your settings: the more levels you set below `high`, the more you save.
- **Nothing to switch.** You never type `/effort`; the line above the prompt shows what it picked and why.
- **Switch models and effort by saying it.** In plain words, typed or dictated, in any language: "switch me to Sonnet at medium", "back to Opus", "plan it on Fable, then implement on Sonnet at high". No `/model`, no `/effort`; a model named for a subagent or in code switches nothing.

<sub>≈ From the author's own sessions with `/effort-pilot report`. Token savings vary with your settings and your work. Not proven yet: fewer turns that fall short. Every setup differs: measure yours.</sub>

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

Before each turn a small, fast model (Haiku, ≈ $0.0004 a turn) reads your message and picks the effort:

| You… | Phase | Effort |
|---|---|---|
| ask for a plan, or use plan mode | plan | `high` |
| ask a hard question, investigate a bug | analyze | `high` |
| ask to build or fix something | implement / fix | `medium` (`high` when hard) |
| approve a plan | implement | `medium` — the thinking went into the plan |
| ask a quick question, commit, push, run a command, a tiny edit | chat / trivial | `low` |

A band above the prompt shows the effort now, how it got there and why. Follow-ups that push the work on keep its effort (a word to go on, like "done" or "continue", too), and a side question doesn't drag it down; a plain question about the work (what was found, where it stands) runs at `low` — the answer is already there. A skill or prompt command you type (`/create-plan …`) is read like any message, and with nothing after it by what the command says it does; built-in commands (`/clear`, `/model`) are left alone.

## Features

- 🗣️ **Just say it.** "do this on max", "medium is enough", "plan it, then build on high" — in any language, typed or dictated. `ultrathink` runs that work at `xhigh`, as Claude Code does (with `CLAUDE_CODE_DISABLE_ULTRATHINK` set, the word asks for nothing). "back to auto" hands it back. Name a model the same way: "switch me to Sonnet at medium", "back to Opus", "plan it on Fable, then build on Sonnet at high". It holds for the rest of the session, until you name another, pick one with `/model`, or turn the pilot off; subagents keep their own model. On a model Effort Pilot does not manage (Sonnet, Haiku by default) the effort you named with it holds too. Talking about a model (for a subagent, a tool, in code, comparing them) switches nothing. Each switch costs one request that re-reads the conversation without the prompt cache.
- 🧭 **Plan mode** runs at `high`; the approved plan is built at `medium`. Want plans on another model? Set `planModeModel` (say `fable`): plan mode runs on it, and the approved plan is built on your session's model again (a model you name in words wins over the setting). Each switch costs one request that re-reads the conversation without the prompt cache.
- 🤖 **Subagents** get their own effort, on the session's model or another one (never below the build effort, `medium` by default). An effort the Agent call names, or `CLAUDE_CODE_SUBAGENT_EFFORT`, is left alone. Your own and plugin agents keep their own effort unless you list them (below). Each subagent's effort is shown: in its description, or in one transcript line at its first request.
- 🔔 **Background results** and messages from other sessions are read too: one the agent only relays or hands to the next agent goes at the build effort (at `high` while a plan or an analysis is under way); one that reports a failure, a background command's output, or a step in hard work keeps the effort of the work it serves.
- ✋ **You stay in charge.** `/effort <level>` pins it; `/effort-pilot on` resumes.
- 🔒 **Private.** Nothing leaves your machine but the Haiku call. Your effort setting is changed per message; the model is never changed unless you ask for one or set `planModeModel`, and the prompt cache stays intact (where a switch would rewrite it, Effort Pilot stands aside).

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
| `planEffort` | `high` | plans and plan mode |
| `planModeModel` | empty | a model for plan mode (an alias like `fable`, or a full id); the approved plan is built on the session's model. Empty: the model is never changed |
| `analyzeEffort` | `high` | hard questions, investigations |
| `buildEffort` | `medium` | building and fixing |
| `hardBuildEffort` | `high` | building that is hard (many files, tricky logic, a bug of unknown cause, push, deploy, deletes) |
| `talkEffort` | `low` | questions, chat, tiny edits |
| `managedModels` | `opus,fable` | models whose effort it sets (never where effort is one setting per request: see above) |
| `headless` | off | also steer `claude -p` and SDK runs |
| `agents` | empty | your own and plugin agents to steer like built-ins (see below) |
| `sessionAgent` | empty | the agent a headless `claude -p --agent <type>` session runs as, where Claude Code does not say it (see below) |
| `measure` | off | run the comparison below |
| `controlShare` | `30` | % of turns left at `high` while measuring |

## Your own and plugin agents

Built-in subagents (`general-purpose`, `Explore`, `Plan`, …) get an effort from their brief. An agent of your own (`~/.claude/agents`, `.claude/agents`) or from a plugin is left alone by default: it runs at the effort its definition sets, or the session's, since an effort its author set is a choice.

To steer some anyway, list them in `agents`, comma-separated, by exact name: `reviewer` (your own or your project's), `lab:builder` (a plugin's), `lab:*` (every agent of a plugin), or `*` (every agent that is not a built-in). A listed agent is then set by its brief like a built-in, never below the build effort. An effort the Agent call names, `CLAUDE_CODE_SUBAGENT_EFFORT`, a number budget, and a model Effort Pilot does not manage still win, as for built-ins; forks, teammates and workflow agents are left alone. In `claude -p` runs a listed agent is steered only with `headless` on, as built-ins are.

What you give up: the effort the author declared is overridden for the agents you list. With **measure** on, a share of their runs (`controlShare`) is still left at their own effort, so the report can show what listing them saved and whether those runs fell short more often.

**Headless agent sessions.** A launcher, a script or an Agent SDK host that runs `claude -p --agent <type>` with `headless` on gets the same: the session's first prompt is read as that agent's brief (never below the build effort), later prompts and notifications as usual. Claude Code tells the plugin which agent the session runs as; `sessionAgent` sets it where it does not. Without `headless`, nothing changes.

```sh
claude -p --agent reviewer --plugin-dir <path to effort-pilot/plugin> \
  --settings '{"pluginConfigs":{"effort-pilot":{"options":{"headless":true,"measure":true}}}}' \
  "Review the diff of the last commit for correctness bugs and report each with its file and line."
```

## Measure it yourself

Turn on **measure**. A share of turns where Effort Pilot would pick something other than `high` is left at `high` (control turns). `/effort-pilot report` then compares, per phase, **cost per turn**, **model time** and **turns that fell short** (aborted, or the message you send right after it says it was wrong), each with a 90% range, and nets out what the classifier itself cost. Each listed agent, and each headless agent session, gets groups of its own per agent type: a record of its run carries `agent` (the type) and `via` (`listed` for a listed subagent, `session` for a turn of a headless session run as the agent; its first turn, the brief, has `who: "agent"`). Records (turn statistics, no prompt text) live in the plugin's data folder, `~/.claude/plugins/data/effort-pilot-effort-pilot/turns/`, one file a day, and are kept for 90 days. `/effort-pilot reset` deletes them; uninstalling the plugin removes them too (unless you uninstall with `--keep-data`).

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Questions and ideas go to
[Discussions](https://github.com/vadympetryshyn/effort-pilot/discussions); a turn that got the wrong effort is the most
useful [issue](https://github.com/vadympetryshyn/effort-pilot/issues/new?template=misrouted.yml).

If it is useful to you, a ⭐ helps others find it.

## License

[MIT](LICENSE)
