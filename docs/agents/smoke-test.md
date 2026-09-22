# Herdr execution-substrate smoke test

This is a manual, operator-only real-Herdr check. It is not CI. Run it only
against sacrificial tasks with Adam attached to the relevant panes; do not use
it to interrupt a live issue, restart the shared development stack, or publish
from a smoke worktree.

1. Run `mise run dev:status` and reuse the listening stack. Confirm
   `herdr --version` reports `0.8.2` and `codex --version` reports a
   `0.149.0`-compatible CLI.
2. Create a sacrificial Suplex task with an intentionally ambiguous brief and
   start planning.
3. Run `herdr workspace list`, `herdr tab list`, `herdr pane list`, and
   `herdr agent list`/`herdr agent get <lead-agent>`. Verify the project-slug
   workspace, issue-key tab, an unguarded `shell` pane in Suplex's exact issue
   worktree, and a ready `lead` agent. Confirm Suplex did not create a Herdr
   worktree.
4. Attach with `herdr agent attach <lead-agent>` and give a scope correction
   while Lead is working. Confirm the Codex rollout records the user message,
   Chat renders it once, and the resulting plan reflects the correction.
5. Submit **Tell the Planner** while Lead is working. Confirm the task phase
   and revision do not change until its structured result lands, and that the
   note is queued once in the Lead TUI.
6. Cause a Lead question or approval dialog. Confirm Suplex attention says
   `Agent needs you in <pane-id>`. Answer only in the attached pane; Suplex
   must not send an automatic answer, and attention must clear afterward.
7. Interrupt the Lead pane process, then wake or retry the turn. Confirm Suplex
   makes a replacement pane with `codex resume` using the same durable Codex
   session ID and sends the recovery interruption prompt once for that pane
   generation.
8. Approve and start development. Verify the `developer` pane uses the issue
   worktree and persisted Developer session. In that pane, verify `git push`
   and destructive Git commands exit `125`. In `shell`, verify `command -v
   git` selects normal Git and `git status` works. Do not mutate or publish.
9. Attach to Developer and steer it mid-turn. Confirm the rollout and Chat
   record the steer, the role-owned result JSON file validates, and SQLite has
   exactly one Developer result claim with no conflict.
10. During a second sacrificial turn, use `scripts/dev-restart.sh --force
    <dev-pane-id>` to restart only the Suplex worker when it is awaiting human
    input. Do not stop Herdr. Confirm the
    retry rediscovers the live agent and resumes at its persisted rollout
    offset without duplicate prompt dispatches or events.
11. In an explicitly isolated smoke window, stop and restart the Herdr server.
    Confirm the next retry replaces the pane and resumes the same Codex
    session.
12. Complete one task as `done` or `cancelled`; confirm a final sanitized
    layout/rollout snapshot artifact is present before Suplex closes its tab.
    Fail a different sacrificial task; its tab must stay open until one manual
    `herdr tab close <tab-id>`.
13. Download and reassemble the sanitized rollout artifact manifest. Verify
    its manifest hash and that it contains only the approved sanitized evidence
    ranges—not raw prompts, result content, tool I/O, or encrypted reasoning.
    Confirm those contents are absent from Temporal history and heartbeat
    details.
14. Run the focused checks plus `pnpm run typecheck`, `pnpm run test:replay`,
    `pnpm run suplex -- doctor`, and `mise run dev:status`; record exact test
    counts and replay `N/N`.

The legacy `pnpm smoke` command is not a substitute for this procedure: it
cannot prove interactive steering, session recovery, pane guards, or terminal
lifecycle behavior.
