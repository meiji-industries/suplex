# Working in Forge with Herdr

Herdr keeps Forge's concurrent work visible and inspectable. The development
stack runs in a pane, and every sub-agent job runs in its own sibling pane.
The orchestrator does not run hidden agents: it writes the brief, launches a
visible pane, waits in the background, verifies the result, and closes only
the pane it created.

The full operating rules are in
[sub-agent panes](docs/agents/subagents-in-herdr-panes.md). See also
[Forge operations](docs/agents/operations.md) for `forge task`, `doctor`, and
logs, and the [smoke-test guide](docs/agents/smoke-test.md).

## Helper scripts

These helpers currently live outside this repository in `~/.claude/scripts/`.
Copy them into `scripts/` as a follow-up so the team can version and discover
them with Forge.

- `codex-pane.sh <label> <prompt.md> <out-file>` splits the rightmost pane in
  the current row, names and rebalances it, then starts `codex exec`; its final
  response is written to `<out-file>`.
- `codex-pane-close.sh <pane-id>` closes that pane and rebalances its row.
- `omp-agent.sh <name> <brief.md> <report-file>` creates and names a sibling
  pane, starts an `omp` Herdr agent (Terra, medium thinking, yolo approvals),
  sends the brief, and prints the pane id. The report must be written to
  `<report-file>`.
- `herdr-rebalance.py` takes no arguments. It equalizes widths in the current
  pane's row after a split or close.
- `scripts/dev-restart.sh [--force] <dev-pane-id>` (in this repo) restarts `mise run dev`
  in the dev-stack pane, but only after `mise run dev:idle` confirms no Temporal
  activity is in flight. Exit 1 means busy and nothing was touched.

## Pane lifecycle

1. Split the **rightmost** pane in the row to the right; never split the
   orchestrator pane.
2. Rename the new pane with a short unique task name.
3. Start the agent and send a concise brief by file path.
4. Run `herdr agent wait <name>` in the background; keep the orchestrator
   responsive while it works.
5. Read the required report, then inspect recent pane output and run the
   promised checks yourself.
6. Close only the pane you created, then rebalance. Do not close the dev-stack
   or another agent's pane.

## `herdr agent` essentials

Start an agent in a known pane:

```sh
herdr agent start <name> --kind omp --pane <pane-id> -- <runner options>
herdr agent prompt <name> "Read and carry out <brief.md>; report to <report.md>."
herdr agent wait <name>
herdr agent read <name> --source recent-unwrapped --lines 120
```

`wait` settles at `idle`, `done`, or `blocked`. `done` is actionable. `idle`
is not automatically completion: accept it only once the requested report
exists; otherwise read the pane output and prompt the agent to continue.
Reports land at the explicit `<report.md>` path in the brief (the helper's
`<report-file>` argument); `codex-pane.sh` instead writes its final response to
`<out-file>`.

`blocked` means the agent is stopped at an approval or question dialog. Read
the pane with `herdr agent read`, tell the user what it needs, and wait for the
user's answer. Never answer that dialog on the user's behalf.

## Shared-checkout discipline

Every brief names the other live panes and their owned files. Never edit a
file with someone else's uncommitted change: poll `git status --short <file>`,
wait until it is clean, re-read it, then edit. Prefer new files, commit only
your own explicit paths, and never stash, reset, or rebase.

## Restarting the dev stack

`mise run dev` has no hot reload, so backend edits need a restart. Sub-agents
never restart it: they report **restart needed**. The orchestrator restarts it
with `scripts/dev-restart.sh <dev-pane-id>`, which refuses while
`mise run dev:idle` reports in-flight activities (agent turns, CI polls, GitHub
operations all run as Temporal activities, so "no pending activities" means
nothing is interrupted). When it reports busy, wait and retry. An operator may
use `scripts/dev-restart.sh --force <dev-pane-id>` only to restart through a
turn awaiting human input: Herdr turns safely re-adopt their panes after the
worker returns. Do not make force the default or use it for ordinary activity.
