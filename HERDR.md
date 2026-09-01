# Working with Herdr

Herdr keeps concurrent terminal work visible and inspectable. Work delegated
through Herdr runs in its own pane: the orchestrator writes a brief, launches
the agent in a visible sibling pane, monitors its state, verifies its output,
and closes only the pane it created.

This guide is intentionally repository-independent. Before acting, read the
repository's agent instructions and use its documented task runner, tests,
development processes, and publication workflow. Those project instructions
take precedence over examples here.

## Preconditions and discovery

Control Herdr only from a Herdr-managed pane:

```sh
test "${HERDR_ENV:-}" = 1
```

If that check fails, stop; do not inspect or control another Herdr session
from outside it. The installed CLI is the source of truth for syntax:

```sh
herdr --help
herdr --skill
herdr agent
herdr pane
```

Do not run bare `herdr` for discovery because it launches or attaches the
TUI. Most control commands return JSON. Treat workspace, tab, and pane IDs as
opaque values and read them from command results instead of deriving them
from layout order or examples.

Use native Herdr commands by default. Repository or user-level helper scripts
are optional conveniences: verify that a helper exists and understand its
behavior before relying on it. A portable workflow must not assume a
particular helper path, model, approval mode, task runner, or development
stack. Implementation delegation uses Codex.

## Prepare the work

Before launching an agent:

1. Read the repository instructions and inspect the current worktree state.
2. Choose a bounded task with a clear owner and minimal file overlap.
3. Write a concise brief that names the objective, allowed scope, owned files,
   relevant constraints, other active panes, expected deliverable, and checks
   to run.
4. State that other workers share the checkout and that unrelated changes
   must be preserved.

Default to a sibling pane in the current tab and the current working
directory. Create a different workspace, tab, worktree, or working directory
only when the user or repository workflow calls for that topology.

## Pane and agent lifecycle

Inspect the caller's layout before splitting:

```sh
herdr pane layout --pane "$HERDR_PANE_ID"
```

Split a wide pane to the right or a narrow/tall pane downward. Keep focus in
the caller's pane and preserve its working directory:

```sh
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

Use `--direction down` when that better fits the layout. Read the new pane ID
from `.result.pane.pane_id`, give the agent a short unique name, and start
Codex:

```sh
herdr agent start <name> --kind codex --pane <pane-id> -- <agent-options>
herdr agent prompt <name> "Read and carry out <brief.md>; report the result."
```

`agent start` requires an existing pane at an interactive shell prompt; it
does not create or split a pane. Agent options belong after `--`. Omit that
separator when there are no agent-specific options.

Monitor without taking focus away from the user:

```sh
herdr agent wait <name>
herdr agent get <name>
herdr agent read <name> --source recent-unwrapped --lines 120
```

Choose a finite `--timeout` when an indefinite wait is inappropriate. A wait
without `--until` settles at `idle`, `done`, or `blocked`:

- `done` means unseen background work reached an idle state. Inspect and
  verify the result.
- `idle` means the agent is ready for input, not necessarily that the assigned
  task is complete. Accept it only when the expected result or report exists.
- `blocked` means Herdr recognized an approval or question UI. Read the pane,
  tell the user what input is needed, and never answer on the user's behalf.
- `unknown` means Herdr cannot classify the agent confidently. It is not proof
  of completion.

If a wait fails or the expected deliverable is missing, inspect `agent get`
and recent unwrapped output, then prompt the same agent to continue. If an
alternate-screen UI has discarded earlier output, ask the agent to write its
complete report to a temporary Markdown file and return the path.

### Status reconciliation

Before reporting a tracked task's status, inspect every pane associated with
that task and reconcile their lifecycle with the task's authoritative status
source (for example, a workflow engine, issue tracker, or deployment system).
Report both facts: a stopped pane means its turn ended, not that the task is
complete; an active task does not mean a role pane is still running. Before
reporting delegated work complete, collect its deliverable, inspect recent pane
output, and run the promised verification.

## Shared-checkout discipline

Sibling panes normally share one checkout, so coordination matters:

- Give one agent ownership of a file at a time and tell every agent about
  overlapping live work.
- Before editing, inspect the target paths with `git status --short -- <paths>`.
  If another agent owns an uncommitted change, wait for it to finish and then
  re-read the file.
- Prefer disjoint files and small, reviewable changes. Re-read dependencies
  changed by another agent before building on them.
- Preserve unrelated changes. Never stash, reset, rebase, discard, or rewrite
  another worker's work.
- If commits are part of the task, commit only explicitly owned paths.

Use separate worktrees only when the user or repository workflow requires
isolation. Do not silently switch branches or create a worktree merely to
avoid coordinating a shared checkout.

## Verification and cleanup

The orchestrator owns final integration. Read the deliverable, inspect the
actual diff and recent pane output, and run the repository-prescribed checks
for the combined change. An agent's success message is evidence, not
verification.

Do not let a sub-agent restart, replace, or stop a long-running development
process unless its brief explicitly grants ownership. Otherwise it should
report that a restart is needed. The orchestrator follows the repository's
safe restart or idle-check procedure and never assumes hot reload is present.

After the work is captured and verified, close only the pane created for that
task:

```sh
herdr pane close <pane-id>
```

Never close the orchestrator pane, a development-process pane, another
agent's pane, or any workspace, tab, or session that this task did not create.
