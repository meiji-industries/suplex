# Operations

## Logs

`mise run logs` prints the latest 200 merged API and worker records from
`.forge/logs/`, ordered by timestamp and formatted for scanning. The API and
worker retain structured JSON in `api.log` and `worker.log`; each rotates at
50 MB and keeps one `.log.1` predecessor.

Use `mise run logs -- --follow` to keep tailing, `--errors` for warnings and
errors, `--task <id>` to match task IDs, workflow IDs, and request URLs, or
`--since 10m` to restrict the time window. Filters can be combined.

## Claude Code provider

Create a profile with provider **Claude Code**, select a Claude model, then bind
that profile to the required role. The worker user must already be logged in
with `claude`. Forge pre-accepts
`projects[realpath(cwd)].hasTrustDialogAccepted` and
`bypassPermissionsModeAccepted` in `~/.claude.json`.
