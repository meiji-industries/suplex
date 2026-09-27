# Operations

See [recovery](../recovery-hardening.md) for native session recovery and authoritative observations.

## Logs

The native host writes structured lifecycle events to `system.log` in the installation's logs directory, `.suplex/logs`. Native agent transcripts remain in the provider's own storage.

`pnpm run suplex logs` reads the current log and retained `system-*.log` archives. Add `--follow` to tail, `--errors` for warnings and errors, `--task <id>` to filter a task, or `--since 10m` for a time window. Filters can be combined. See [system logging](../system-logging.md) for event fields and retention.

## Development

Run `mise run dev:status` before starting or restarting the stack. `mise run dev` runs the native host with Vite HMR; `mise run dev:watch` also rebuilds the native host on changes. Stop only this checkout's owned development processes with `mise run down`. A source checkout is not the installed host, and changing its server does not require stopping native agent sessions.

## Claude Code provider

Create an agent profile with provider **Claude Code**, select its model, and
assign it to the required role. Authenticate the host account or the selected
dedicated Claude login before starting work. Dedicated instances use separate
configuration directories. See [project execution](../project-execution.md) for
credential policies and MCP grants.
