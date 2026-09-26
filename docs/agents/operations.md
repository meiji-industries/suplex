# Operations

See [recovery](../recovery-hardening.md) for native session recovery and authoritative observations.

## Logs

The Rust host writes structured lifecycle events to `system.log` in the installation's logs directory. A development checkout uses `.suplex-rust/logs`; an installed checkout uses `.suplex/logs`. Native agent transcripts remain in the provider's own storage.

`pnpm run suplex logs` reads the current log and retained `system-*.log` archives. Add `--follow` to tail, `--errors` for warnings and errors, `--task <id>` to filter a task, or `--since 10m` for a time window. Filters can be combined. See [system logging](../system-logging.md) for event fields and retention.

## Development

Run `mise run dev:status` before starting or restarting the stack. `mise run dev` runs the native host with Vite HMR; `mise run dev:watch` also rebuilds the Rust host on changes. Stop only this checkout's owned development processes with `mise run down`. A source checkout is not the installed host, and changing its server does not require stopping native agent sessions.

## Claude Code provider

Create an agent with provider **Claude Code**, select a Claude model, then assign that agent to the required role. The worker user must already be logged in with `claude`. Suplex pre-accepts `projects[realpath(cwd)].hasTrustDialogAccepted` and `bypassPermissionsModeAccepted` in `~/.claude.json`.
