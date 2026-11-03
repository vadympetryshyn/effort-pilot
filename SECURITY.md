# Security

Effort Pilot runs inside Claude Code on your machine. It reads your prompts to classify them (one Haiku call a turn
through Claude Code itself), changes the effort of requests, and — only with **measure** on — writes turn statistics
(no prompt text) to its data folder, `~/.claude/plugins/data/effort-pilot-effort-pilot/turns/`, kept 90 days.
`/effort-pilot reset` deletes them, and uninstalling the plugin removes them.

Found a vulnerability? Please don't open a public issue: use GitHub's
[private vulnerability reporting](https://github.com/vadympetryshyn/effort-pilot/security/advisories/new).
