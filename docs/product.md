# Suplex product guide

Suplex keeps repository work visible without requiring a second delivery process
beside OpenCode, Git, and GitHub. The task is the place to describe the objective,
observe work, answer questions, and inspect the delivery result.

## One continuing Root

Root plans and reviews within one native conversation. It delegates a scoped
Worker when edits are necessary. Worker returns its native result to Root,
which inspects the change and decides what comes next. Repairs follow this same
path. There is no separate planner, reviewer, or integrator relay.

Suplex owns mechanical delivery operations. Root requests them with the current
commit where appropriate. GitHub owns pull request and merge policy. A matching
external push, pull request, or merge can satisfy the task without an extra
Suplex receipt.

## Workflows

Every task selects one workflow at creation. Standard is the default and keeps the
Coordinator-plans, Worker-builds, Coordinator-reviews sequence above. Direct build
lets Worker choose the approach from your instructions; Coordinator still reviews.
Second opinion adds a read-only Reviewer that must approve the complete current
change before delivery. Combined planning asks Plan A and Plan B for separate
plans, which Coordinator combines before Worker builds. Pull request repair takes
an existing open pull request: Rater scores it from 1 to 10 with a surgical repair
plan, Worker repairs it, and a fresh Rater scores the result until a valid rating
is at least 9 with no blocking findings. Suplex then pushes, waits for the checks,
and merges the same pull request when GitHub reports it ready. The 9 threshold is
fixed and cannot be waived.

Advisors are read-only sessions that reuse Coordinator profiles. The task captures
each Advisor profile at creation. Review history in the task shows every Reviewer
or Rater round with its reviewed revision, including invalid reports.

## Task controls

**Start immediately** starts Root when the task is created. Otherwise, the task
stays in Backlog until you select **Start task**. Backlog tasks support direct
title and description edits. Active tasks accept notes to Root.

A task shows Active while Suplex pursues its objective, Answer necessary when
it needs your input, and Delivered when its delivery target is reached.
Cancellation preserves the worktree and published GitHub state. Archive controls
keep finished or deferred work out of the normal list.

Task detail shows the objective, selected profiles, branch, native sessions,
turn observations, questions, images, and delivery result. A live Herdr display
attaches to the same session that owns the work. Display failures do not stop it.

## Configuration

Projects choose repository paths, worktree roots, verification commands,
delivery targets, and Root and Worker defaults. Templates reuse task intent.
An agent profile picks one of the four agent tools and one of its models.
OpenCode models name their vendor, as in `openai/gpt-5.6-sol`.

Claude Code profiles can use the global configuration or a local Suplex-owned
instance. A local instance has its own sign-in. The provider page shows the
exact `CLAUDE_CONFIG_DIR='<directory>' claude auth login` command for it.

Each agent tool owns its own model authentication. Suplex's provider page reports
configuration and sign-in, not a successful inference request. GitHub operations
use the host's existing GitHub CLI authentication.

External agents can create tasks within explicitly granted project scopes.
Passkey users manage companies, projects, and work through the web application.

## Recovery and boundaries

Suplex observes the current worktree and external delivery state after a restart.
It preserves out-of-band work and does not repeat admitted prompts. Unavailable
evidence remains unknown until Suplex can read it again.

A hard OpenCode crash during a tool call can leave a command active outside
the server process group. Suplex then retains the assignment and asks you to
stop those commands before confirming cleanup. This is an execution-safety
boundary, not a second progress record that GitHub must satisfy.

Root's read-only policy and Worker's mutation restrictions are native tool
policies. They do not isolate hostile code. The current operating boundary is
owner-controlled repositories and trusted local tools.

See the [README](../README.md) for setup and operations, [CONTEXT.md](../CONTEXT.md)
for terminology, and [interface principles](interface-principles.md) for UI rules.
