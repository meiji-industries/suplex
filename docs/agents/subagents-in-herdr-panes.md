# Delegating implementation work to sub-agents in Herdr panes

All implementation work is delegated to a coding-agent CLI running **visibly in
its own Herdr pane**, driven through Herdr's agent API. The orchestrator (Claude
Code in the main pane) diagnoses, writes the brief, launches, waits in the
background, verifies, relays, and closes the pane.

Default sub-agent: **omp** (`oh-my-pi`) with `gpt-5.6-terra`, thinking
`medium`, service tier `priority` (OpenAI "fast"), approvals bypassed.
Codex CLI (`codex exec … --model gpt-5.6-terra -c model_reasoning_effort=medium
-c service_tier=fast`) remains a supported fallback via `herdr pane run`.

## The flow (Herdr agent API)

```bash
# 1. a sibling pane (never the calling Claude pane; split the rightmost pane of the row)
pane=$(herdr pane split --pane <rightmost-pane> --direction right --cwd "$PWD" --no-focus \
       | jq -r .result.pane.pane_id)
herdr pane rename "$pane" "<short task name>"

# 2. start the agent in it — returns once Herdr sees omp ready for input
herdr agent start <name> --kind omp --pane "$pane" -- \
  --model gpt-5.6-terra --thinking medium --service-tier priority \
  --approval-mode yolo --auto-approve --cwd "$PWD"

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
`idle` before the report file exists means the agent stopped early — read its
last output and `herdr agent prompt <name> "Continue …"` the same session.

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

When sub-agents must touch the same file, serialise them.

## Brief checklist

Verification commands with the bar ("0 failures"; replay must stay N/N; never
delete an existing `ctx.patched(...)` call — removed behaviours keep their
markers as ignored calls), the owner directive in one line, the concrete
deletion list, the rule ("no state may land owner=human because …"), commit
message(s), and the final-report contents (verbatim test counts per project,
commit hashes, what was left and why, "restart needed").

## Orchestrator duties after the report

Re-run `pnpm typecheck` yourself; spot-check the claimed test counts; confirm
"pre-existing failures" really are pre-existing before accepting them; close
the pane; restart nothing — ask the user.
