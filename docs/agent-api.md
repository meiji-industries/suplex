# External agent API

External agent credentials use bearer authentication. Every request reads the current
persisted credential and project grants. A revoked credential returns `401`.
Task reads cover every task in the caller's currently granted projects and
company. Missing tasks and tasks outside those grants remain concealed with
`404`. Mutations remain limited to tasks the caller created.

The bearer credential and persisted project grants authorize every request.
`profileId` is optional client metadata. It can be absent, shared by more than
one agent, or changed during credential rotation without changing access. The
identity projection returns it as `null` when it is absent.

## Compatibility paths

The canonical paths are `/api/agent/*` and `/api/admin/external-agents/*`.
Suplex keeps `/api/hermes/*` and `/api/admin/hermes-agents/*` as narrow path
aliases that use the same handlers and authorization. Existing credentials,
grants, tasks, and idempotency receipts continue to work. The aliases return
the canonical external-agent response shape; they do not preserve old
provider-specific field names or identity kinds.

Two private storage names remain provider-specific for data compatibility:
task configuration stores its existing `hermesSelection` key, and command
idempotency receipts remain in `suplex_hermes_task_command_receipts`. They are
not public API names. Keeping them avoids rewriting saved task configuration
and receipts or losing replay protection during this rename.

## Discovery

`GET /api/agent/me` returns the authenticated agent identity, actual supported
capabilities, and `{ id, name, agentTaskPolicy }` metadata for currently granted
projects. `agentTaskPolicy` reports the project's delivery defaults:
`deliveryTargets` (the default delivery target), `runProjectTests`, and
`visualEvidence`. A task that names none of these takes them.

`GET /api/agent/capabilities` reports the deployment-wide surface. Its
`capabilities.create.deliveryTargets` is the full set of delivery targets the
route accepts; each project narrows that to the single value its policy fixes.
Its `capabilities.read.workflows` and `capabilities.read.templates` flags
advertise project-scoped creation discovery.

`GET /api/agent/workflows?projectId=...` lists every non-archived workflow
with `id`, `name`, `description`, and `permittedForAgentTaskCreation`. `GET
/api/agent/templates?projectId=...` returns the same fields for templates in
that project. Both routes require a current project grant. The permission flag
comes from the project's agent task policy.

`GET /api/agent/tasks` returns every task in the caller's currently granted
projects. It accepts these query
parameters: `projectId`, `status`, `pullRequestNumber`, `sourceBranch`,
`titleContains`, `archived`, `attention`, `blocker`, `updatedSince`
(ISO-8601 timestamp), `limit` (1 through 100, default 50), `cursor`, `filter`,
and `view`. `pullRequestNumber` matches a pull request source or a stored
delivery pull request. `sourceBranch` matches a branch source. `titleContains`
is a case-insensitive substring. Results are ordered by `updatedAt` descending
and task ID ascending. `updatedSince` is inclusive. HTTP defaults to `full`.
`summary` returns only the task id, title, status, archive flag,
workflow name, source, delivery pull request number, dependencies, and update
time. The response has `tasks` and `nextCursor`.

The cursor binds the authenticated agent and all filters. It is opaque:
malformed, modified, cross-agent, and filter-mismatched cursors return `400`
with `{ "code": "cursor_invalid" }`. Cursors remain valid across an ordinary
application restart while the credential and persisted task state are unchanged.
Pagination is a forward scan rather than a snapshot; callers should combine a
completed scan with an inclusive `updatedSince` poll and de-duplicate by task
ID and revision.

`attention` selects tasks with a current human question. `blocker` selects a
current human question or a persisted delivery wait. A task projection includes
only safe task, project, workflow progress, question, and delivery observations.
`humanQuestion` is the text of the current question. `question` has its `id`,
its `kind` (`question` or `task_limit`), `requiresCommandCleanup`, and its
offered `options`, each with an `id` such as `option-1`, or it is `null`.
`permittedCommands` lists the lifecycle commands that
`POST /api/agent/tasks/:taskId/commands` accepts for the task right now.
It is empty when another agent or a user created the task.
`checks` is `null`, which means Suplex has no persisted check observation to
report. `deliveryTarget`, `runProjectTests`, and `visualEvidence` report the
configuration applied to the task.

Read responses (`GET` and `POST /api/agent/tasks`) also carry `implementation`,
`integration`, and `actionRequired`. `integration` is what GitHub reported about
the task's pull request when the request was served, with `observation` set to
`unavailable` and `integrated` left `false` when GitHub could not answer. Suplex
never observes deployed runtimes, so `integration.deployed.included` is always
`null`. `actionRequired` describes the observed owner and reason when work is
outstanding. It does not grant command authority. `permittedCommands` is the
authority signal. Human, Suplex, and upstream owners remain descriptive. Command replies omit these three
fields because a command reports stored task state and reads no provider.

`filter` selects on that observed health: `stale_delivery`,
`conflicting_pull_request`, `failed_checks`, `pending_review`,
`blocked_by_dependency`, or `not_integrated`. GitHub is read after the page is
drawn, so `filter` narrows the returned page rather than the scan; keep
following `nextCursor` to see every matching task.

Missing, out-of-grant, and cross-company tasks all return `404` with
`{ "code": "resource_not_found" }`. This conceals which condition applied.

## Conditional task polling

`GET /api/agent/tasks/:taskId` returns an `ETag` derived from the full safe
projection, including `permittedCommands`. Send that exact value in
`If-None-Match` to receive `304` without a
body when unchanged. Authorization always happens before the conditional
response. The opaque `revision` and ETag change when any exposed task, question,
workflow, project, or delivery field changes. To require a known revision for a
read, send its exact ETag in `If-Match`; a different current revision returns
`412` with `{ "code": "revision_stale" }`. A stale revision otherwise returns
the current projection.

All successful Agent API responses use `Cache-Control: private, no-store`.

## Task commands

`POST /api/agent/tasks/:taskId/commands` applies one lifecycle command. The
body takes `command`, the task's current `revision`, an `idempotencyKey`, and
`note` for `send_task_note` only. A stale revision returns `412` with
`{ "code": "revision_stale" }`; a command outside `permittedCommands` returns
`409` with `{ "code": "illegal_command" }`. Only the paired agent that created
the task can send a command. A command for another task returns the same `404`
as an unavailable task. `taskCommands` from `GET /api/agent/me` lists exactly
these lifecycle commands. `autonomousCommands` from
`GET /api/agent/capabilities` also includes task creation and, when enabled,
the runtime delivery commands. `answer_human_question` appears in these lists
only when an administrator lets the agent answer questions; see
[Answering a Coordinator question](#answering-a-coordinator-question). The
runtime API exposes delivery and merge commands only when capabilities reports
them. Suplex can perform a task's configured delivery, including a merge after
review, without an agent command.

## Answering a Coordinator question

An administrator can let an external agent answer questions on their behalf.
The setting is **May answer questions on my behalf** in the agent's actions on
the Agents page. It is off for every new, existing, and OAuth agent. Suplex
reads it on each request, so a change applies to the agent's next request.

`GET /api/agent/me` reports `capabilities.humanAnswers` and `answerGrant`, with
the `userId` and `userName` of the administrator who granted it. When the grant
is on, `taskCommands` and `autonomousCommands` include `answer_human_question`,
`capabilities.humanDecisions` is `true`, and `permittedCommands` includes it
for a task that waits on a plain Coordinator question. When the grant is off,
`unavailableCommands` includes `answer_human_question`.

Send `command: "answer_human_question"` with the current `revision`, an
`idempotencyKey`, the `questionId` from `question.id`, and exactly one of
`optionId` (an offered option ID) or `answer` (free text). An option answer
sends the option label and description to the Coordinator, as the board does.
The Coordinator prompt and the board show the answer as given by the agent for
the administrator who granted it. The audit event `task_answered` has the agent
as actor and `answeredForUserId` in its metadata.

| Status | Code | Condition |
| --- | --- | --- |
| `403` | `answer_grant_required` | No administrator lets this agent answer questions. |
| `409` | `question_stale` | `questionId` is not the current question. |
| `409` | `task_not_waiting` | The task has no current question. |
| `409` | `human_decision_required` | The question is a task limit decision or needs confirmation that commands stopped. Only a person can answer it. |
| `422` | `option_not_offered` | `optionId` is not an option of the current question. |

None of these refusals changes the task. A repeated request with the same
`idempotencyKey` returns the stored result and does not answer again.

## Creating a task

`POST /api/agent/tasks` creates a backlog task. Send `"queue": true` to queue
it; see [Queued tasks](#queued-tasks). `deliveryTarget`,
`runProjectTests`, and `visualEvidence` are optional. A value you omit comes
from the template or workflow, then the project; Pull request repair always
merges. Omitting both `workflowId` and `templateId`
selects Standard. The created task
reports the applied `workflow`, `templateId`, `deliveryTarget`,
`runProjectTests`, and `visualEvidence`. `workflow` has the selected record ID
and name when Suplex selected a workflow record, plus the engine that the task
runs. A template task has a null workflow record ID and name.

Send `"dryRun": true` to validate a create request and receive its projected
result without writing a task, receipt, dependency, queue state, audit event,
or image.

## Queued tasks

A task has `backlog` status until someone starts it. A queued task has no
sessions or turns. Suplex starts it when every prerequisite is complete. Every
task read reports `status` and `queue.waitingOn`. Each incomplete prerequisite
has an `id`, `title`, `status`, `deliveryTarget`, `reason`, and `summary`.

A prerequisite is complete when it is delivered at its own delivery target.
The `merged` target also needs the merged pull request state that Suplex
observed from GitHub. A prerequisite delivered at `pull_request_draft`,
`pull_request_ready`, `remote_branch`, or `local_worktree` is complete without
a merge, because that target is what its delivery promised. Wait reasons:

| `reason` | Meaning |
| --- | --- |
| `prerequisite_not_started` | The prerequisite is in the backlog or queued. |
| `prerequisite_running` | The prerequisite is active. |
| `prerequisite_needs_human` | The prerequisite waits for a human answer. |
| `prerequisite_cancelled` | The prerequisite is cancelled. Remove it or disarm the task. |
| `prerequisite_archived` | The prerequisite is archived and not delivered. |
| `prerequisite_merge_unobserved` | The prerequisite is delivered at `merged`, but Suplex did not observe the merge. Suplex checks GitHub again. |

Queue at creation with `"queue": true`, or send `start_task` to a manual
backlog task. Both start the task now when every prerequisite is complete and
never bypass one. `disarm_task` returns a queued task to the manual backlog.
Suplex re-evaluates a queued task when a prerequisite completes, when Suplex
observes a merged pull request, when the prerequisites change, and on every
scheduler tick after a restart. Cancelling a queued task prevents admission.

Rejected create inputs include `field`, `value`, and `reason`. Project IDs use
`project_not_found`. Dependencies use `dependency_not_found`. Profile IDs use
`root_profile_not_found`, `worker_profile_not_found`, or
`advisor_profile_not_found`. Source issues, pull requests, and branches
use `source_issue_rejected`, `source_pull_request_rejected`, and
`source_branch_rejected`.

An unknown or archived workflow returns `422 workflow_not_found`. A template
that is not in the project returns `422 template_not_found`.

## Task prerequisites

A task's prerequisites are the tasks it waits for. The board shows them as
**Blocked by**. `suplex_task_dependencies` is their only store. Every task read
reports them twice from the same edges: `dependsOn` has the IDs, and
`blockedBy` has `id`, `title`, and `status` for each one.

Set them at creation with `dependsOn`, or replace the whole set with
`PUT /api/agent/tasks/:taskId/dependencies` and `{ "dependsOn": [...] }`. The
body is the complete set: an omitted ID is removed, and `[]` removes every
prerequisite. A prerequisite can be any task the agent can read in a granted
project. The task waits for the prerequisite. Reading a prerequisite gives no
commands on it. A self-reference or a cycle returns `422 task_unavailable`.
An unavailable prerequisite returns `422 dependency_not_found`. Both include
`field`, `value`, and `reason`, and the current set stays unchanged. Send
`"dryRun": true` to validate a replacement and receive the projected
dependencies and queue state without writing edges, queue state, or audits.
Unknown fields, such as `blockedByTaskId`, return `400 request_invalid`.

`docs/agent-mcp.md` describes the stdio MCP bridge that exposes these
routes as tools.

The MCP bridge intentionally exposes a smaller surface than the HTTP API. It
covers identity, capability and creation discovery, task reads and creation,
dependencies, and lifecycle commands. Delivery refresh, repair, decisions,
approvals, merge-train operations, merge, provenance, and administration stay
HTTP-only. MCP exposes lifecycle task commands only. It does not expose runtime
delivery or merge commands. Suplex can perform a task's configured delivery,
including a merge after review, without an agent command. Suplex does not provide
a generic MCP tool for arbitrary HTTP requests.

## Paired-agent delivery approval

When delivery capabilities are enabled, the HTTP API offers delivery observation,
repair, merge-train inspection, and a separate merge-approval exchange. Approval
issuance checks the current PR, head, prerequisites, and accepted review, then
returns a single-use, expiring receipt bound to that task and agent. Merge
consumes the receipt and rechecks eligibility. This is an API authorization
exchange, not a universal human approval step in every task workflow. Human
question answers remain unavailable to paired agents. See
[the delivery implementation](../rust/src/delivery/agent_delivery.rs).
