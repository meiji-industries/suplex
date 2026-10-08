# Parallel work and task dependencies

For contributors coordinating several tasks, this page explains file isolation
and the conditions that release queued work. Sources:
[worktrees](../../apps/server/src/tasks/worktree.rs),
[task dependencies](../../apps/server/src/tasks/dependencies.rs),
[queue admission](../../apps/server/src/tasks/repository.rs), and
[PR prerequisite observation](../../apps/server/src/tasks/pull_request_dependencies.rs).

## Separate working trees

Each task has its own Git worktree and branch. Agents can edit independent tasks
without sharing the same checked-out files. A worktree still belongs to a Git
repository and runs on the same host. It does not isolate credentials, network
access, databases, ports, or other shared services. See
[project execution](../project-execution.md#shared-verification-resources) for
coordinating verification commands that use the same resource.

Parallel tasks can still change the same code. Their changes must eventually
be integrated and reviewed against the repository's actual state. Separate
worktrees do not promise conflict-free merges or automatic branch stacking.
The [delivery record](delivery.md) explains how manual changes and moving base
branches fit into that process.

## Ordering prerequisites

A task prerequisite refers to another Suplex task in the same company. Self
references and dependency cycles are rejected when the dependency graph is
written. Admission waits for the prerequisite to be delivered. If that task's
target is merged, admission also requires its stored PR observation to show a
merge. A cancelled prerequisite does not count as delivered.

A pull request prerequisite refers to a GitHub PR. Suplex observes it before
saving the prerequisite and refreshes queued tasks' PR observations. It requires
a merge; closing a PR without merging does not satisfy it. A failed refresh
keeps the previous observation and retries later rather than inventing success.

These conditions distinguish two useful cases:

- If task A targets a draft PR, task B depending on A can become eligible after
  that draft is delivered. A dependency is not proof that A's changes are on
  the base branch.
- If B needs a particular PR merged first, a PR prerequisite expresses that
  condition directly. Integration still needs to observe the actual Git state.

Prerequisites control when Suplex admits queued work. Backlog tasks still need
an explicit start. Releasing a prerequisite does not itself copy another
worktree's files, select commits, or specify how the dependent change should
build on earlier work. Capture that intent in the task and source selection.

Start anyway admits a queued task before its prerequisites are met and before
a project slot is free. The task records `manualStart` in its workflow state,
and its unfinished task prerequisites then no longer hold native dispatch. The
Coordinator prompt states that the user started the task early. The plan's
running-task limit and pull request ownership still reject Start anyway, and
turn and budget limits still apply
([`force_start`](../../apps/server/src/tasks/repository.rs),
[`dispatch_blocked`](../../apps/server/src/tasks/dependencies.rs)).

The scheduler takes promoted queued tasks first, then other queued tasks by
queue time. Moving a task to the front changes its order in the Board and Tasks
list, but still waits for its prerequisites and a project or plan slot. Each
later promotion takes the front position. Already active tasks continue.

## Parallel roles within a task

The project task limit counts active tasks and tasks that await a human answer.
Archived tasks do not hold a slot. The task response reports when this limit
keeps a queued task from starting, using the current project limit and task
count. The task view shows this reason alongside incomplete prerequisites.

Combined planning runs two independent planning Advisors and returns both
results to Coordinator before implementation. That is separate from several
tasks running concurrently. Worker and individual Advisors otherwise share
one delegation slot. See [coordination](coordination.md#roles-and-handoffs).

Running several competing implementations for one task, comparing their diffs,
and choosing a winner remains a [proposal](../proposals.md#parallel-implementations-and-triggers).
Do not infer that feature from worktree support or Combined planning.

[Architecture index](README.md)
