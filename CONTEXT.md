# Forge

Forge coordinates software delivery in owner-controlled repositories.

## Language

**Task**
A company-scoped objective with a project, description, optional images, and
delivery target. A task preserves its captured configuration while it runs.
_Avoid_: Phase execution, issue projection.

**Issue association**
The external issue linked to a task, identified within its issue tracker.
It is independent of the pull request, branch, or issue used to create the task.
_Avoid_: Task dependency, pull request association.

**Prerequisite**
A task in the same company that another task waits for, shown as "Blocked by".
A task can have several. `forge_task_dependencies` is the only store; APIs call
the ids `dependsOn` and the resolved tasks `blockedBy`. A task created to start
immediately waits in the backlog until every prerequisite is delivered.
_Avoid_: Blocked by reference, single blocker.

**Coordinator**
The continuing read-only agent that investigates the source, writes the plan
and acceptance criteria, independently reviews the Worker's changes and check
evidence, and requests delivery operations. Each delegation carries its plan,
acceptance criteria, and bounded implementation instructions.
_Avoid_: Planner, Lead, Integrator.

**Worker**
The agent assigned one scoped instruction from Coordinator. It edits, verifies, and
commits in the task worktree, then returns its result to Coordinator.
_Avoid_: Builder, Developer, nested agent.

**Workflow**
The selected sequence of agents and gates for one task: Standard, Direct build,
Second opinion, Combined planning, or Pull request repair. A task captures its
workflow and Advisor profiles at creation.
_Avoid_: Phase engine, custom pipeline.

**Advisor**
A read-only delegated session that reports to Coordinator and shares the one
delegated slot with Worker. Its product label is Reviewer, Plan A, Plan B, or Rater.
_Avoid_: Second Worker, writable reviewer.

**Reviewer**
The Advisor that independently inspects the complete current change in Second
opinion and approves or lists blocking findings.
_Avoid_: Integrator, approver relay.

**Plan A and Plan B**
The two Advisors in Combined planning that write separate plans from the same
objective and pinned input. Neither sees the other's report.
_Avoid_: Competing Workers.

**Rater**
The Advisor in Pull request repair that rates the current pull request from 1 to
10 and writes a surgical repair plan. Delivery needs a valid current-range 9.
_Avoid_: Score oracle, automatic approval.

**Native session**
The OpenCode or Claude Code conversation that owns admitted messages, tool
calls, and results. Forge selects the harness from the agent profile provider.
_Avoid_: Herdr session, completion receipt file.

Forge keeps one native session per task role: Coordinator, Worker, Reviewer,
Plan A, Plan B, and Rater. Each assignment is an immutable turn in that role's
conversation. Only one Worker or Advisor turn runs at a time, but switching
roles does not end the inactive conversation. Missing display attachment data
does not prevent Forge from resuming native work.

**Turn**
One prompt and its correlated native response within a session. A turn can
contain multiple tool calls and native compaction messages.
_Avoid_: Phase, terminal screen response.

**Display attachment**
A Herdr pane attached to an existing native session. Closing the display does
not cancel the task or prove that its work ended.
_Avoid_: Completion signal, progress gate.

**Task worktree**
The Git worktree and branch assigned to one task. Existing commits and
uncommitted changes remain work to inspect, not state to reset.
_Avoid_: Disposable progress mirror, shared task directory.

**Delivery target**
The requested endpoint, such as a local worktree, remote branch, draft pull
request, ready pull request, or merged pull request.
_Avoid_: Universal merge requirement, release phase.

**Delivery operation**
A Forge-owned Git or GitHub action requested by Coordinator. The operation observes
current external state before deciding whether a mutation is necessary.
_Avoid_: Integrator turn, mirrored release.

**Agent profile**
A named provider, model, reasoning level, and service tier selection. The
provider is the agent tool that runs the turn: `opencode`, `claude-code`,
`devin`, or `codex`. An OpenCode model names its vendor, as in
`openai/gpt-5.6-sol`; Forge splits it only when it calls OpenCode. Projects
choose Coordinator and Worker defaults. Tasks capture the chosen settings.
_Avoid_: Vendor as provider, separate Forge model catalog.

**Project provider policy**
The providers and login instances permitted for a project's agents. Every task
role, replacement, and resumed session uses an agent profile within this policy.
_Avoid_: Company provider policy, provider defaults as authorization.

**Configured provider**
An agent tool whose executable Forge resolved on the host. Its sign-in state is
reported separately. Neither proves that a model request succeeds.
_Avoid_: Verified inference, inherited Codex authentication.

**Human question**
A specific decision or external problem that prevents further safe work.
An answer addresses that question and returns to the existing Coordinator session.
_Avoid_: Generic automatic-loop blocker, phase approval.

**Execution cleanup confirmation**
Your explicit confirmation that old commands have stopped after a hard crash
left their execution uncertain. It permits continuation without replaying the
admitted prompt.
_Avoid_: Agent completion claim, automatic server-death inference.

**Forge user**
A passkey-authenticated person with explicit company membership. An instance
administrator also controls host setup and recovery.
_Avoid_: Anonymous operator, provider identity.

**Hermes agent**
A machine identity limited to its company, granted projects, and tasks it
created. It uses a revocable credential rather than a Forge user session.
_Avoid_: Coordinator, Worker, unscoped API key.

**Owner-controlled pilot**
An installation where the owner trusts the repositories and inherited local
tools. Native tool policies are not hostile-code isolation.
_Avoid_: Untrusted multi-tenant execution, OS sandbox guarantee.
