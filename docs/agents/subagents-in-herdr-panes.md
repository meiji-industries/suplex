# Delegating implementation work to sub-agents in Herdr panes

All implementation work is delegated to a coding-agent CLI running **visibly in
its own Herdr pane**, driven through Herdr's agent API. The orchestrator (Claude
Code in the main pane) diagnoses, writes the brief, launches, waits in the
background, verifies, relays, and closes the pane.

Default sub-agent: **omp** (`oh-my-pi`) with `gpt-5.6-terra`, thinking
`medium`, approvals bypassed.
Codex CLI (`codex exec … --model gpt-5.6-terra -c model_reasoning_effort=medium
`) remains a supported fallback via `herdr pane run`.

## Choose the runner to fit the job

Use **omp** for bounded work (roughly ten files or fewer): its visible TUI is
excellent for observing every edit and tool call. Its per-turn output limit can
turn a large refactor into a misleading `Partial` handoff, though. For work
that must take a red tree all the way to green, use `codex exec` in a pane.
Do not build resume loops: `codex exec resume` has no `-C` option. Start a
fresh pane instead.

## The flow (Herdr agent API)

```bash
# 1. a sibling pane (never the calling Claude pane; split the rightmost pane of the row)
pane=$(herdr pane split --pane <rightmost-pane> --direction right --cwd "$PWD" --no-focus \
       | jq -r .result.pane.pane_id)
herdr pane rename "$pane" "<short task name>"

# 2. start the agent in it — returns once Herdr sees omp ready for input
herdr agent start <name> --kind omp --pane "$pane" -- \
  --model gpt-5.6-terra --thinking medium --approval-mode yolo --auto-approve --cwd "$PWD"

# 3. submit the brief by path; ask for the report as a file
herdr agent prompt <name> "Read and carry out the brief in <brief.md> exactly. When completely \
finished, write your final report as Markdown to <report.md> and reply with only that file path."

# 4. wait IN THE BACKGROUND (settles on idle | done | blocked)
herdr agent wait <name>                 # run via Bash run_in_background

# 5. collect
cat <report.md>
herdr agent read <name> --source recent-unwrapped --lines 120

# 6. close only the pane you created
herdr pane close "$pane"
```

Helper: `~/.claude/scripts/omp-agent.sh <name> <brief.md> <report.md>` does 1–3
and prints the pane id; `~/.claude/scripts/codex-pane-close.sh <pane>` does 6
(and rebalances pane widths). Names must match `[a-z][a-z0-9_-]{0,31}` and be
unique among live agents.

Why the agent API rather than `herdr pane run`: Herdr validates that the
expected agent is actually running, and gives real lifecycle states.
`blocked` means the agent is sitting at an approval/question dialog — read the
screen (`herdr agent read`) and ask the user; never answer the dialog yourself.
`agent wait` can settle at `idle` simply because the user looked at the pane;
it is not a completion signal by itself. Treat only `idle` with the required
report, `done`, or `blocked` as actionable. An `idle` agent without its report
stopped early — read its last output and prompt it to continue.

Why not `omp -p`: print mode shows only the final answer; the TUI streams every
tool call and edit, which is the point of the pane.

## Don't block on sub-agents

Launching returns immediately. Never wait synchronously in the foreground (no
`until [ -s out ]; do sleep; done` in a blocking call). Wait with a background
task (`herdr agent wait` via Bash `run_in_background`) so the session stays
responsive to the user; act on the completion notification (relay, verify,
close the pane). Foreground tool calls between launch and completion are fine.

## Sub-agents are not alone in the repo

Every brief must state, explicitly:

- which OTHER agents (other panes, Claude, the running dev stack) are working in
  the same checkout right now, and which files each one owns or has
  uncommitted edits in (`git status --short`);
- "do not edit a file while `git status --short <file>` shows someone else's
  uncommitted change; phase your work — your own files first, shared files
  after the sibling commits (poll `git status`, re-read fresh, then edit)";
- commit only your own files, by explicit path (`git add <paths>`; never
  `git add -A` / `git commit -a`); before adding a shared file, `git diff` it
  and confirm only your hunks are in it; never stash, reset, checkout, rebase;
  never touch package.json / lockfiles unless assigned;
- unexpected `git status` changes belong to a sibling — leave them alone;
- the dev stack may be running from this checkout: do not restart, kill, or
  run `mise run dev/down`; say "restart needed" in the final report instead.

Shared core files (`tasks.ts`, `codex-lead.ts`, contracts, and comparable
integration hubs) are serial work. Parallelise only disjoint file sets, and
put the ownership map in every brief.

## Migrations are append-only

A migration's identity is its timestamp. Never edit or delete a migration once saved; add a new one. Application code must match the database the migrations create.

## Brief checklist

Include all of the following:

- a one-line owner directive: "you are the only agent / here are the other
  agents and their files"; the ownership principles; and the current
  `git status --short` map;
- the concrete scope/deletion list, acceptance rule, commit message, and bars:
  `pnpm typecheck` must be zero and the required unit run must finish with its
  exact counts; replay must remain N/N;
- "a `Partial` report will be sent back" and the required report contents:
  exact test counts, commits, remaining work and reason, and `restart needed`.

## Orchestrator duties after the report

Reports lie by omission. Re-run `pnpm typecheck` yourself and run the required
unit command through completion before accepting a report; spot-check its
claimed counts. Do not accept "pre-existing failures" from an agent that owns
the whole tree. Close the pane when verified; restart nothing — ask the user.
