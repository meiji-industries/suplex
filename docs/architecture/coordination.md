# Task and session coordination

For maintainers following a task from intake to delivery, this page explains
captured intent, role handoffs, and continuation. Sources:
[task creation](../../apps/server/src/tasks/creation.rs),
[task commands](../../apps/server/src/tasks/commands.rs),
[coordination](../../apps/server/src/coordination/root_controller.rs), and
[session persistence](../../apps/server/src/coordination/root_session_store.rs).

## Captured intent and live observations

Task creation captures the project settings, agent profiles, workflow, delivery
intent, and execution controls. Later project edits supply defaults for future
tasks; they do not silently rewrite a running task's captured configuration.
Supported task edits remain explicit commands. Git branches, native sessions,
and remote checks remain live observations, not frozen copies of the world at
creation time.

Queued tasks wait for prerequisites. Backlog tasks wait for an explicit start.
Preparation creates the worktree, supplies project context and skills outside
Git, and runs configured setup. Interrupted setup can run again, so setup must
be idempotent. A failed setup supplies repair information to Coordinator.
See [project execution](../project-execution.md) for environment and credential
boundaries.

Host budget and turn defaults are a separate case: tasks without explicit
limit overrides inherit them at admission time. See [settings and limits](settings-and-limits.md).

## Roles and handoffs

Coordinator owns investigation, delegation, review, and delivery requests.
Worker implements changes. Advisors provide the selected workflow's planning
or independent review. The [product guide](../product.md#workflows-and-delivery)
describes the six built-in workflows; task instructions customize their work without
creating an arbitrary workflow graph.

The ordinary delegation slot is shared by Worker and individual Advisors.
Combined planning reserves separate Plan A and Plan B slots on the same pinned
input. Both terminal reports must arrive before Coordinator receives the
combined result. Approve then build has no Advisor: Coordinator calls
`request_plan_approval`, the task waits for your answer, and Suplex records the
approved plan in the task's workflow state. The first Worker implementation
must carry that exact plan. This is distinct from running multiple implementation
candidates and choosing a winner, which remains a proposal.

Coordinator continues in its native conversation after a handoff. Persisted
session generations distinguish replacement assignments. They do not identify
Herdr panes. `root` is the implementation and wire name for Coordinator;
existing identifiers need not change to use the product term in prose.

## Continuation and human decisions

The selected provider owns prompt admission, tool execution, and turn results.
Suplex persists the intent to dispatch and observes the native result. A restart
must not replay admitted work. See [native providers](providers.md) and
[recovery](recovery.md) for the distinction between a prepared prompt and a turn
that the provider has accepted.

The operating principle is to return ordinary repair work to Coordinator.
Questions belong to concrete decisions, missing authority, or unavailable
access. A review disagreement or moving base branch does not create a new
requirement for a human checkpoint. Detailed arbitration and objection
mechanisms from older proposals are not established as implemented; see
[unresolved work](unknowns.md).

Delivery reads Git and the repository service again. It retains external edits
and merges and applies the operation's own authorization and review rules.
See [repository delivery](delivery.md).

[Architecture index](README.md)
