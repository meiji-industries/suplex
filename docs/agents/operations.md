# Operations

See [recovery hardening](../recovery-hardening.md) for convergence, attention, and reconciliation operations.

## Logs

`mise run logs` prints the latest 200 merged API and worker records from
`.suplex/logs/`, ordered by timestamp and formatted for scanning. The API and
worker retain structured JSON in `api.log` and `worker.log`; each rotates at
50 MB and keeps one `.log.1` predecessor.

Use `mise run logs -- --follow` to keep tailing, `--errors` for warnings and
errors, `--task <id>` to match task IDs, workflow IDs, and request URLs, or
`--since 10m` to restrict the time window. Filters can be combined.

## Remote development

For remote access over Tailscale, use `mise run dev:remote`. It builds the
frontend once with Vite and serves the resulting `dist/web` files directly
from Fastify, avoiding Vite's many development-module requests. It does not
provide frontend HMR; rerun it after frontend changes. `mise run dev` remains
the default local development mode with Vite HMR.

`scripts/dev-restart.sh` waits up to three minutes for the worker's polling
log signal, then confirms `/api/health`; its success output names the readiness
signal used. The worker is hosted in the API process, and `mise run dev:idle`
checks SQLite's in-flight engine activity ledger before allowing a restart.

## Claude Code provider

Create an agent with provider **Claude Code**, select a Claude model, then assign
that agent to the required role. The worker user must already be logged in
with `claude`. Suplex pre-accepts
`projects[realpath(cwd)].hasTrustDialogAccepted` and
`bypassPermissionsModeAccepted` in `~/.claude.json`.
