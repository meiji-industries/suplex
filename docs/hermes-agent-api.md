# Hermes agent API

Hermes credentials use bearer authentication. Every request reads the current
persisted credential and project grants. A revoked credential returns `401`.
Tasks remain concealed with `404` unless the caller is their creator and has a
current grant for the task project in the agent's company.

## Discovery

`GET /api/hermes/me` returns the authenticated agent identity, actual supported
capabilities, and `{ id, name, agentTaskPolicy }` metadata for currently granted
projects. `agentTaskPolicy` reports the create-time configuration the project
permits: `deliveryTargets` (the delivery targets a create request may ask for),
`runProjectTests`, and `visualEvidence`. Read it before creating a task; a
create request that asks for anything else is rejected.

`GET /api/hermes/capabilities` reports the deployment-wide surface. Its
`capabilities.create.deliveryTargets` is the full set of delivery targets the
route accepts; each project narrows that to the single value its policy fixes.
Its `capabilities.read.workflows` and `capabilities.read.templates` flags
advertise project-scoped creation discovery.

`GET /api/hermes/workflows?projectId=...` lists every non-archived workflow
with `id`, `name`, `description`, and `permittedForAgentTaskCreation`. `GET
/api/hermes/templates?projectId=...` returns the same fields for templates in
that project. Both routes require a current project grant. The permission flag
comes from the project's agent task policy.

`GET /api/hermes/tasks` returns only the caller's tasks. It accepts these query
parameters: `projectId`, `status`, `archived`, `attention`, `blocker`,
`updatedSince` (ISO-8601 timestamp), `limit` (1 through 100, default 50),
`cursor`, and `filter`. Results are ordered by `updatedAt` descending and task
ID ascending. `updatedSince` is inclusive. The response has `tasks` and
`nextCursor`.

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
`permittedCommands` lists the lifecycle commands that
`POST /api/hermes/tasks/:taskId/commands` accepts for the task right now.
`checks` is `null`, which means Forge has no persisted check observation to
report. `deliveryTarget`, `runProjectTests`, and `visualEvidence` report the
configuration the project policy applied to the task.

Read responses (`GET` and `POST /api/hermes/tasks`) also carry `implementation`,
`integration`, and `actionRequired`. `integration` is what GitHub reported about
the task's pull request when the request was served, with `observation` set to
`unavailable` and `integrated` left `false` when GitHub could not answer. Forge
never observes deployed runtimes, so `integration.deployed.included` is always
`null`. `actionRequired` names the owner and the reason the task is not
integrated, or is `null` when nothing is outstanding. Command replies omit these
three fields: a command reports stored task state and reads no provider.

`filter` selects on that observed health: `stale_delivery`,
`conflicting_pull_request`, `failed_checks`, `pending_review`,
`blocked_by_dependency`, or `not_integrated`. GitHub is read after the page is
drawn, so `filter` narrows the returned page rather than the scan; keep
following `nextCursor` to see every matching task.

Missing, out-of-grant, cross-company, and other-creator tasks all return `404`
with `{ "code": "resource_not_found" }`. This intentionally conceals which
condition applied.

## Conditional task polling

`GET /api/hermes/tasks/:taskId` returns an `ETag` derived from the full safe
projection. Send that exact value in `If-None-Match` to receive `304` without a
body when unchanged. Authorization always happens before the conditional
response. The opaque `revision` and ETag change when any exposed task, question,
workflow, project, or delivery field changes. To require a known revision for a
read, send its exact ETag in `If-Match`; a different current revision returns
`412` with `{ "code": "revision_stale" }`. A stale revision otherwise returns
the current projection.

All successful Hermes responses use `Cache-Control: private, no-store`.

## Task commands

`POST /api/hermes/tasks/:taskId/commands` applies one lifecycle command. The
body takes `command`, the task's current `revision`, an `idempotencyKey`, and
`note` for `send_task_note` only. A stale revision returns `412` with
`{ "code": "revision_stale" }`; a command outside `permittedCommands` returns
`409` with `{ "code": "illegal_command" }`. Human answers, delivery, and merges
have no command and stay human authority.

## Creating a task

`POST /api/hermes/tasks` creates a backlog task. Send `"queue": true` to queue
it; see [Queued tasks](#queued-tasks). `deliveryTarget`,
`runProjectTests`, and `visualEvidence` are optional; sending a value the
project policy does not permit returns `422` with
`{ "code": "delivery_policy_rejected" }` and a message naming the permitted
values. Read `agentTaskPolicy` from `GET /api/hermes/me` to avoid the round
trip, or omit the fields and let the policy default apply. The created task
reports the applied `workflow`, `templateId`, `deliveryTarget`,
`runProjectTests`, and `visualEvidence`. `workflow` has the selected record ID
and name when Forge selected a workflow record, plus the engine that the task
runs. A template task has a null workflow record ID and name.

An unknown or archived workflow returns `422 workflow_not_found`. A workflow
that exists but is outside the project policy returns `422
workflow_not_permitted`. Both error bodies include `permittedWorkflowIds`.
Templates use `template_not_found` and `template_not_permitted`, with
`permittedTemplateIds`.

## Task prerequisites

A task's prerequisites are the tasks it waits for. The board shows them as
**Blocked by**. `forge_task_dependencies` is their only store. Every task read
reports them twice from the same edges: `dependsOn` has the IDs, and
`blockedBy` has `id`, `title`, and `status` for each one.

Set them at creation with `dependsOn`, or replace the whole set with
`PUT /api/hermes/tasks/:taskId/dependencies` and `{ "dependsOn": [...] }`. The
body is the complete set: an omitted ID is removed, and `[]` removes every
prerequisite. Each prerequisite must be a task this agent created in the same
company. A self-reference or a cycle returns `422 task_unavailable`, an
unavailable task returns `404`, and the current set stays unchanged. Unknown
fields, such as `blockedByTaskId`, return `400 request_invalid`.

## Queued tasks

A backlog task is either manual or queued. A manual task never starts by
itself. A queued task stays in `backlog`, with no sessions or turns, and Forge
starts it when every prerequisite is complete. Every task read reports `queue`:

- `startIntent`: `manual` or `queued`. This is the persisted start intent.
- `state`: `backlog` (manual), `queued`, `running`, `needs_attention`,
  `delivered`, or `cancelled`.
- `waitingOn`: each incomplete prerequisite with `id`, `title`, `status`,
  `deliveryTarget`, `reason`, and a `summary` that tells you what to do.

A prerequisite is complete when it is delivered at its own delivery target.
The `merged` target also needs the merged pull request state that Forge
observed from GitHub. A prerequisite delivered at `pull_request_draft`,
`pull_request_ready`, `remote_branch`, or `local_worktree` is complete without
a merge, because that target is what its delivery promised. Wait reasons:

| `reason` | Meaning |
| --- | --- |
| `prerequisite_not_started` | The prerequisite is in the backlog. |
| `prerequisite_running` | The prerequisite is active. |
| `prerequisite_needs_human` | The prerequisite waits for a human answer. |
| `prerequisite_cancelled` | The prerequisite is cancelled. Remove it or disarm the task. |
| `prerequisite_archived` | The prerequisite is archived and not delivered. |
| `prerequisite_merge_unobserved` | The prerequisite is delivered at `merged`, but Forge did not observe the merge. Forge checks GitHub again. |

Queue at creation with `"queue": true`, or send `start_task` to a manual
backlog task. Both start the task now when every prerequisite is complete and
never bypass one. `disarm_task` returns a queued task to the manual backlog.
Forge re-evaluates a queued task when a prerequisite completes, when Forge
observes a merged pull request, when the prerequisites change, and on every
scheduler tick after a restart. Cancelling a queued task clears its intent.

`docs/hermes-mcp-bridge.md` describes the stdio MCP bridge that exposes these
routes as tools.
