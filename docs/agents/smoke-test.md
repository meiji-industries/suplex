# Dev-stack smoke test

Run `pnpm smoke` (or `mise run smoke`) against an already-running loopback Forge dev stack. It authenticates through development auto-login, creates a narrowly scoped task, starts planning, and polls every five seconds while asserting planning, auto-approval, Builder execution with a recorded PID, delivery review, release, and a draft pull-request URL.

It intentionally creates a real task and draft pull request. First validate connectivity without creating anything:

```sh
FORGE_SMOKE_DRY_RUN=1 pnpm smoke
```

Environment variables:

- `FORGE_PORT` — API port; defaults to `4111`.
- `FORGE_SMOKE_PROJECT_ID` — project to use; by default, the first project in the first visible company.
- `FORGE_SMOKE_TITLE` — task title; defaults to a timestamped smoke title.
- `FORGE_SMOKE_BRIEF` — task brief; defaults to adding a timestamped line to `docs/SMOKE.md`.
- `FORGE_SMOKE_DELIVERY` — delivery target; defaults to `pull_request_draft`.
- `FORGE_SMOKE_TIMEOUT_MINUTES` — overall limit; defaults to `30`.
- `FORGE_SMOKE_CLEANUP=1` — after success, cancels the task and runs `gh pr close` for the created draft PR.
- `FORGE_SMOKE_DRY_RUN=1` — validates auto-login, company/project lookup, and the task payload without creating a task.

On a failure or timeout, the script prints `TASK JSON` and `ACTIVITY (last 40 rows)`. The task state shows the failed phase, owner, and pending action; the activity section includes recent command rows to identify the failing agent command. A human-owned phase other than the expected approval gate is treated as a failure so the operator sees an intervention requirement immediately.
