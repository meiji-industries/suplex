# Delegating work to Codex CLI in Herdr panes

Whenever you delegate work to Codex CLI, DO NOT spawn Codex as a child process
in your own terminal. Run every Codex sub-agent in a new sibling Herdr pane:

1. Create: `herdr pane split --current --direction right --cwd "$PWD" --no-focus`
   Parse the pane ID from `.result.pane.pane_id`.
2. Rename it to a short description of the delegated task.
3. Run Codex there: `herdr pane run <pane-id> "<codex command>"`. The process must
   be visible and stream its normal terminal output in that pane.
4. Collect the result, then close ONLY the pane you created: `herdr pane close <pane-id>`.
   Never close, replace, or reuse the calling Claude pane.

Parallel sub-agents: one pane each, independently visible, closed as soon as
that sub-agent's result is collected. Prefer Herdr's agent APIs when they fit
(`herdr agent start <name> --kind codex --pane <pane-id> -- <args>`, then
`herdr agent prompt` / `wait` / `read`). Never run hidden Codex processes when
Herdr is available.

## Don't block on Codex

Launching a pane must return immediately. Never wait for Codex synchronously
in the foreground (no `until [ -s out ]; do sleep; done` in a blocking Bash
call). Wait in a background task (Bash `run_in_background`, or `herdr agent
wait` in the background) so the session stays responsive to the user; act on
the result when the completion notification arrives (relay it, close the
pane). Foreground tool calls between launch and completion are fine and
expected.

## Codex is not alone in the repo

Every Codex brief must state, explicitly:

- which OTHER agents (Codex panes, Claude, the running dev stack) are working in
  the same checkout right now, and which files/directories each one owns;
- "do not edit files outside your assignment; if you must, stop and report";
- commit only your own files, by explicit path (`git add <paths>`; never
  `git add -A` / `git commit -a`); never stash, reset, checkout, or rebase;
  never touch package.json / lockfiles unless assigned;
- if `git status` shows unexpected changes, leave them alone — they belong to
  a sibling agent;
- the dev stack may be running from this checkout: do not restart, kill, or
  run `mise run dev/down`; say "restart needed" in the final message instead.

When sub-agents must touch the same file, serialise them (one after the
other) rather than running in parallel.

## Invocation used in this repo

```
codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  --model gpt-5.6-terra -c model_reasoning_effort=medium -c service_tier=fast \
  -C <repo> --output-last-message <out-file> - < <brief.md>
```

Helpers: `~/.claude/scripts/codex-pane.sh "<label>" <brief.md> <out-file>` (prints
pane id; splits the rightmost pane and equalises widths) and
`~/.claude/scripts/codex-pane-close.sh <pane-id>`.
