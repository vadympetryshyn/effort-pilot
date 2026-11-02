# Contributing

Thanks for helping make Effort Pilot better. Bug reports, misrouted turns and PRs are all welcome.

## Report a misrouted turn

The most useful issue: a message that got the wrong effort. Run `/effort-pilot classify <your message>` and paste
what it shows, plus what you expected and why. Rewrite the message if it holds anything private — the gist is enough.

## Develop

```sh
git clone https://github.com/vadympetryshyn/effort-pilot && cd effort-pilot
claude --plugin-dir plugin          # loads your working copy; edits reload when a turn ends
```

The first load writes the engine's types to `plugin/.claude-plugin/types/` (git-ignored), so your editor and
`npx tsc -p plugin` can type-check the module.

- `plugin/hooks/route.ts` — the routing rules and the classifier prompt (pure functions, unit-tested).
- `plugin/hooks/register.tsx` — the hooks: prompts, plan mode, subagents, the band, commands, settings.
- `plugin/types/index.d.ts` — the plugin's session state.

## Check before a PR

```sh
claude plugin test plugin                       # unit tests
claude plugin validate . --strict               # marketplace + plugin
npx -y -p typescript@5.6 tsc -p plugin          # types (after one load, above)
```

CI runs the first two on every PR.

## Pull requests

- One change per PR; say what it fixes and how you checked it.
- A change to the classifier prompt (`SYSTEM` in `route.ts`) needs before/after results on a set of messages:
  prompt wording moves a small model a lot.
- English everywhere: code, comments, tests, commits.
- Don't bump the version: the maintainer does at release.

## Releases

Semantic versioning. A release bumps `plugin/.claude-plugin/plugin.json`, adds a `CHANGELOG.md` entry, tags
`vX.Y.Z` and publishes a GitHub release. Installed copies pick it up with `claude plugin update effort-pilot@effort-pilot`.
