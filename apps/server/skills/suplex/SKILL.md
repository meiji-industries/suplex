---
name: suplex
version: 1
description: Work with Suplex tasks as a paired external agent. Use when the person you work for asks to create, find, check, change, or command a task in Suplex, or to confirm this client's Suplex pairing.
---

# Suplex

Suplex owns task intent and authorization. This skill only asks Suplex to do
things; it never decides task rules locally, and it never reads Suplex's
storage.

Two transports, same API:

- **Prefer the Suplex MCP tools** when the bridge is registered (`suplex mcp`,
  or `pnpm --dir /absolute/path/to/suplex run suplex mcp` from a source checkout).
  Check for tools named
  `suplex_whoami`, `suplex_capabilities`, `suplex_list_workflows`,
  `suplex_list_templates`, `suplex_list_tasks`, `suplex_get_task`,
  `suplex_get_task_delivery`, `suplex_create_task`, `suplex_update_task`,
  `suplex_set_task_dependencies`, `suplex_command_task`, `suplex_list_moves`,
  `suplex_get_move`, `suplex_create_move`, `suplex_update_move`,
  `suplex_delete_move`, `suplex_start_move`, `suplex_list_move_runs`,
  `suplex_get_move_run`, `suplex_get_move_run_transcript`,
  `suplex_stop_move_run`, `suplex_archive_move_run`.
- **Otherwise use `suplex_client.py`** in this directory. It is standard
  library only and speaks the same routes.

```python
from suplex_client import SuplexClient, SuplexError, SuplexCredentialInvalid
client = SuplexClient()            # reads the environment at call time
identity = client.whoami()
```

## Guardrails

- A task you create stays in `backlog` unless you send `"queue": true`. Queue
  a task or send `start_task` only when the person you work for explicitly
  asks to start it. A queued task starts by itself when its prerequisites are
  complete; `disarm_task` returns it to the backlog.
- Never approve, release, merge, cancel, archive, or make any other
  consequential commitment unless Suplex reports the command as permitted **and**
  the requesting person approved that exact action. `start_task`,
  `cancel_task`, and `archive_task` are not reversible by this agent.
- Never scrape the Suplex web UI, and never read the Suplex SQLite database,
  worktrees, logs, or artifact files. The HTTP API and the MCP tools are the
  only supported reads.
- Never print, log, store, or repeat the credential or a pairing code. Report
  outcomes, not secrets.

## Configuration

Two variables are read from the client process environment at runtime:

- `SUPLEX_BASE_URL`, the Suplex origin, for example `http://127.0.0.1:4111`.
- `SUPLEX_AGENT_CREDENTIAL`, the paired-agent credential.

The client does not load a `.env` file. Never pass either value on a command
line. Every Suplex request carries
`Authorization: Bearer <credential>`; `suplex_client.py` adds it for you.

## Pairing and credential rotation

An administrator creates the agent in Suplex admin and hands over a one-time
pairing code. To pair, or to re-pair after a rotation:

1. `POST {SUPLEX_BASE_URL}/api/agent/pairing/exchange` with
   `{"pairingCode": "…", "profileId": "<optional client profile metadata>"}`.
   This is the
   only unauthenticated route the skill uses.
2. Store `credential` from the response as `SUPLEX_AGENT_CREDENTIAL` in the
   private client configuration, replacing any existing value. Keep the
   configuration readable by the current user only. Hermes users may use the
   active profile's `$HERMES_HOME/.env` when their Hermes setup loads it.
3. Verify with `python3 smoke_test.py` in this directory.

Do not echo the pairing code, the raw exchange response, or the credential.

**Rotation.** When any call fails with HTTP 401 and code `credential_invalid`,
the credential is revoked or replaced. Do not retry it. Tell the person you
work for that Suplex rejected the credential and that an administrator must
issue a new pairing code (Suplex admin, "rotate" on this agent), then repeat the
exchange above with the new code. The optional `profileId` is descriptive
metadata and may change during rotation. It does not authorize the request.
`suplex_client.py`
raises `SuplexCredentialInvalid` with exactly that instruction. There is no
agent-side rotation endpoint: issuing codes is an administrator action.

## Capability discovery

Call `suplex_capabilities` (`GET /api/agent/capabilities`) before assuming any
command exists. It reports `apiVersion`, `capabilities`, `autonomousCommands`,
`unavailableCommands`, and `humanOnlyRecords`. A deployment can leave the agent
delivery surface off, in which case `capabilities.delivery` and
`capabilities.merge` are `false` and the delivery routes are not registered at
all. Treat the served list as authoritative and never call a command it omits.

When `suplex_whoami` reports `capabilities.humanAnswers: true`, you may answer
a task's plain Coordinator question for the administrator in `answerGrant`.
Read the task, then send `answer_human_question` with the current `revision`,
`questionId` from `question.id`, and exactly one of `optionId` from
`question.options` or free-text `answer`. Answer only what the person you work
for would answer; otherwise surface the question to them.

`GET /api/agent/openapi.json` returns the authenticated runtime contract if
you need the exact request shapes.

**Not available to this agent, in any transport:**

- Answering a human question without the answer grant. `answer_human_question`
  works only when an administrator lets this agent answer on their behalf.
  Without it the command returns `answer_grant_required`; surface the question
  to the person you work for and let them answer in Suplex.
- Task limit decisions and questions that need confirmation that commands
  stopped. These return `human_decision_required` even with the grant.
- `deliver_task`: delivery is not an agent command.
- Merging, when `capabilities.merge` is `false`.
- Editing a task's title or description after creation, deleting a task, and
  reading session transcripts or artifacts: no route exists. Do not attempt a
  workaround.
- `capabilities.pagination` reports `supported: true` and `cursor: true`.
  `GET /api/agent/tasks` accepts `cursor` and returns `nextCursor`; follow the
  cursor if a listing is truncated.

## Project selection

`suplex_whoami` (`GET /api/agent/me`) returns the agent identity and the
`projects` this agent was granted, each with its project delivery defaults in
`deliveryDefaults` (`deliveryTargets`, `runProjectTests`, `visualEvidence`). A
task takes these values when it names no other values. `agentTaskPolicy` is a
deprecated alias with the same shape; read `deliveryDefaults`. Suplex's persisted grants are authoritative:

- One granted project: use it.
- Several: ask the person you work for which one. Do not guess.
- None: stop and report that project access is required. Do not create a task.

`projectId` is always explicit in a create request. Suplex rejects a project
this agent was not granted with a non-enumerating `404`.

## Workflow and template selection

Call `suplex_list_workflows(projectId)` and `suplex_list_templates(projectId)`
before you set `workflowId` or `templateId`. Each result has `id`, `name`,
`description`, and `permittedForAgentTaskCreation` (always `true`: any listed
record can be used). A workflow is shared by projects. A template belongs to the project in the request.

## Before you create: list first

Duplicate tasks are expensive. Before creating, list existing tasks for the
project and check for one that already covers the request:

```python
existing = client.list_tasks(projectId=project_id, limit=50)["tasks"]
```

Useful filters: `status` (`backlog`, `queued`, `active`, `waiting_human`,
`cancelled`, `delivered`), `archived`, `attention`, `blocker`, `updatedSince`, and `filter`
(`stale_delivery`, `conflicting_pull_request`, `failed_checks`,
`pending_review`, `blocked_by_dependency`, `not_integrated`). If a matching
task exists, report it instead of creating another.

## Creating a task

`POST /api/agent/tasks` creates a **backlog** task. It never starts by itself
unless you send `"queue": true`; see [Queued tasks](#queued-tasks).

```python
task = client.create_task(project_id, "Add saved searches", "Users want …")
```

`idempotencyKey` is required. `suplex_client.py` derives it from the payload, so
a retry of the same request reuses the key and a changed payload gets a new
one. Keep that property whichever transport you use:

- Same request, retried after a timeout or a `5xx` → **same key**. Suplex
  returns `200` with the task it already created.
- Different title, description, or project → **new key**. Reusing a key for a
  different payload fails with `409 idempotency_conflict`, which means your key
  is wrong, not that the task is wrong.

Optional fields Suplex accepts: `queue`, `dependsOn`, `images`, `source`, `workflowId` or
`templateId` (never both), `rootProfileId`, `workerProfileId`,
`advisorProfileIds`, `deliveryTarget`, `runProjectTests`, `visualEvidence`.
Omitting both a workflow and a template selects Standard. Omitted
`deliveryTarget`, `runProjectTests`, and `visualEvidence` come from the template
or workflow, then the project; the created task reports the applied values back. Omit `description` to keep a template's
description; sending it, even as `""`, overrides it. Never send local paths,
URLs, credentials, or file references.

An unknown or archived workflow returns `422 workflow_not_found`. A template
that is not in the project returns `422 template_not_found`.
The created task reports the applied `workflow` object, `templateId`, and
`deliveryTarget`.

## Prerequisites (Blocked by)

`dependsOn` lists the task IDs a task waits for, and `blockedByPullRequests`
lists GitHub pull requests (`[{"number": 42}]`) that must merge first. Suplex
shows both as **Blocked by**. Set them at creation, or replace the whole set
later with `PUT /api/agent/tasks/{taskId}/dependencies` (MCP:
`suplex_set_task_dependencies`, client: `client.set_dependencies(task_id,
[...])`). Send the complete set: an omitted ID or number is removed, and `[]`
removes every prerequisite. `"dryRun": true` validates a create or a
replacement and returns the projected result without writing anything.

```python
task = client.set_dependencies(task_id, [first_id, second_id], blocked_by_pull_requests=[{"number": 42}])
```

Each prerequisite must be a task in a granted project.
Suplex rejects a self-reference or a cycle with `422 task_unavailable`, and an
unavailable task with `422 dependency_not_found`; the current set stays
unchanged. Unknown fields, such as `blockedByTaskId`, fail with
`400 request_invalid`.

Every read reports the same stored set: `dependsOn` has the IDs and
`blockedBy` has `id`, `title`, and `status` for each prerequisite.

## Queued tasks

A queued task has status `queued`. Suplex starts it by itself when every
prerequisite is complete and a project or plan slot is free. It has no sessions
or turns until then. Queue it at creation with `"queue": true`, or send
`start_task` to a backlog task. `start_task` never bypasses a prerequisite.
`disarm_task` returns a queued task to the backlog. `force_start` starts a
queued task now, without waiting for prerequisites or a project slot; it is
**Start anyway**. Send it only when the person you work for asked for that
exact action.

To prioritize a queued task in a granted project, read its current `revision`
and send `move_to_front` through `suplex_command_task` or `client.command_task`.
When the person asks you to prioritize work, inspect the queued tasks and
promote those that match their direction. Each later call
takes the front position. Suplex still waits for prerequisites and a project
or plan slot. The task stays queued; `queuePriority` in task reads shows its
priority. The Board and Tasks list show the resulting order. This also works
for tasks created by a GitHub label trigger.
To set a specific front order, promote the selected tasks in reverse order.

```python
task = client.get_task(task_id)
if "move_to_front" in task["permittedCommands"]:
    client.command_task(task_id, "move_to_front", task["revision"])
```

Every read reports `status` and `queue`: `projectConcurrencyLimited` and
`planConcurrencyLimited` (the project task limit or the plan's running-task
limit holds the task back), and `waitingOn`, one entry per incomplete
prerequisite with `kind` (`task` or `pull_request`), `id`, `title`, `status`,
`deliveryTarget`, `reason`, and `summary`; a `pull_request` entry adds
`number`, `state`, and `url`. A task prerequisite is complete when it is
delivered at its own delivery target; the pull request targets also need the
merged pull request that Suplex observed from GitHub. A pull request
prerequisite is complete when that pull request merges. Act on the `summary`:
for example, a `prerequisite_cancelled` reason means remove that prerequisite
or disarm the task.

## Status polling

`GET /api/agent/tasks/{taskId}` returns the task with `status`, `revision`,
`permittedCommands`, `queue`, `dependsOn`, `blockedBy`, `blocker`, `humanQuestion`, `workflowStage`,
`deliveryTarget`, `runProjectTests`, `visualEvidence`, `delivery`,
`integration`, and `actionRequired`.

Poll with backoff, not in a tight loop. `client.poll_task(task_id, until=…)`
doubles its delay up to 60 seconds. Over MCP, pass `knownRevision` to
`suplex_get_task`: an unchanged task answers `{"unchanged": true, "revision":
"…"}` and costs nothing.

## Lifecycle commands

`POST /api/agent/tasks/{taskId}/commands` with `command`, the task's current
`revision`, an `idempotencyKey`, and `note` only for `send_task_note`.

Commands: `start_task`, `move_to_front`, `force_start`, `disarm_task`, `cancel_task`, `archive_task`, `unarchive_task`,
`duplicate_task`, `send_task_note`, `recheck_delivery_wait`. Send only what the
task's `permittedCommands` lists.

```python
task = client.get_task(task_id)
if "send_task_note" in task["permittedCommands"]:
    client.command_task(task_id, "send_task_note", task["revision"], note="…")
```

Failures worth handling:

- `412 revision_stale`: someone changed the task. Read it again and retry with
  the current `revision`. Never invent one.
- `409 command_in_progress`: a command is running. Wait and re-read.
- `409 illegal_command` / `409 task_unavailable`: the command does not apply
  to this task now. Report it; do not force it.

## Updating a task

`PATCH /api/agent/tasks/{taskId}` (MCP `suplex_update_task`) changes a task in
the backlog or the queue. An active or delivered task accepts only a later
`deliveryTarget`, sent alone: the Coordinator continues toward it, and a
delivered task reopens. Send the current `revision`, an `idempotencyKey`,
and only the fields to change: `title`, `description`, `workflowId`,
`rootProfileId`, `workerProfileId`, `advisorProfileIds`, `deliveryTarget`,
`runProjectTests`, or `visualEvidence`. An omitted field keeps its value. The
response is the task with its new revision.

`advisorProfileIds` is the complete Advisor selection. `{}` returns each role
(`reviewer`, `planner_a`, `planner_b`, `rater`) to its default. Name only roles
that the task's resulting workflow has, and only Coordinator profiles.

A queued task stays queued with the same prerequisites. To hold it while it
changes, send `disarm_task`, update it, then send `start_task` to queue it
again. Send `start_task` only when the person you work for asked for the task
to be queued.

```python
task = client.get_task(task_id)
task = client.update_task(task_id, task["revision"], advisorProfileIds={"rater": profile_id})
```

Any other change to an active, delivered, or cancelled task returns
`409 illegal_command`. A rejected profile or workflow
returns `422` with `field`, `value`, and `reason`, and keeps the revision.

## Reading approval, blocked, waiting_human, and stale answers

- **`status: "waiting_human"`**: Suplex is waiting for a person, not for you.
  Read `humanQuestion` and `blocker`. If `blocker.kind` is `"human_question"`,
  relay the question to the person you work for. You cannot answer it.
- **`blocker.kind: "delivery_wait"`**: Suplex is waiting on delivery.
  `blocker.reason` is `checks`, `mergeability`, `merge_queue`, or
  `observation`. `recheck_delivery_wait` asks Suplex to look again; it is safe
  and does not commit anything.
- **`actionRequired`**: the authoritative read of who must act next. `owner`
  is `agent`, `human`, `suplex`, or `upstream`. Act only when `owner` is
  `agent`, and even then stop and ask first if `humanApprovalRequired` is
  `true`. `suggestedCommands` are suggestions, not authorization.
- **`reasonCode`** values: `conflicting_pull_request`, `failed_checks`,
  `pending_checks`, `pending_review`, `stale_delivery`, `pull_request_missing`,
  `blocked_by_dependency`, `waiting_human`, `observation_unavailable`.
- **Stale.** `stale_delivery` means the delivered branch fell behind its base;
  it is routine and is repaired inside Suplex, not by this agent.
  `observation_unavailable` (`integration.observation == "unavailable"`, with
  `observationReason`) means Suplex could not read GitHub. The state is
  unknown, not bad. Report the reason and re-read later. `revision_stale` on a
  command is a different thing: it means your copy of the task is old.
- **`blockedBy` / `blocked_by_dependency`**: the task waits on other tasks.
  Report the blocking tasks; do not cancel or force anything.

## Moves

Moves are saved, reusable actions in a project: a `prompt` for an agent, a
`script`, `pull_request_tasks`, or a `task`. They are available only when an
administrator granted this agent Move access **and** the agent holds a grant to
the Move's project. Check `capabilities.read.moves` from `suplex_capabilities`
first; without the grant every Move route returns a non-enumerating `404`.
Do not ask for the grant yourself; tell the person you work for.

Routes (MCP tool, client method):

- `GET /api/agent/moves?projectId=…` (`suplex_list_moves`, `client.list_moves`) and
  `GET /api/agent/moves/{moveId}` (`suplex_get_move`, `client.get_move`).
- `POST /api/agent/moves` (`suplex_create_move`, `client.create_move`) with
  `projectId`, `name`, `prompt`, `runner`, `confirm`, and an `idempotencyKey`.
  Optional: `profileId`, `workflow`, `deliveryTarget`, `runProjectTests`,
  `visualEvidence`. The same idempotency rule as task creation applies.
- `PUT /api/agent/moves/{moveId}` (`suplex_update_move`, `client.update_move`)
  sends the complete Move body plus the Move's current `updatedAt`.
  `DELETE /api/agent/moves/{moveId}?updatedAt=…` (`suplex_delete_move`,
  `client.delete_move`) also needs `updatedAt`. A stale `updatedAt` is
  rejected: read the Move again and retry. **Deleting a Move deletes its run
  records.**
- `POST /api/agent/moves/{moveId}/runs` (`suplex_start_move`,
  `client.start_move`) with `inputs`, `excludedPullRequests`, and an
  `idempotencyKey`; `GET …/runs` lists runs. `GET /api/agent/move-runs/{runId}`
  and `…/transcript` read a run. `DELETE …/terminal` stops a live run
  (`suplex_stop_move_run`). `POST …/archive` archives it
  (`suplex_archive_move_run`).

```python
run = client.start_move(move_id, inputs={"branch": "main"})
transcript = client.get_move_run_transcript(run["id"])
```

Starting a Move executes work. `confirm: true` makes the Suplex UI ask a person
before a start; the API does not enforce it, so you must. Start, stop, delete,
or archive only when the person you work for asked for that exact action. A `prompt` Move may need a person at its
interactive terminal; neither transport offers remote terminal interaction, so
report a run that waits on a terminal instead of trying to drive it.

## Reporting back

Report the agent name and ID, the profile ID, the granted project IDs, the task
issue key or ID, and the status. Never the pairing code or the credential.

## Verify this skill

```bash
python3 suplex_client.py --self-check   # redaction and idempotency keys, no server
python3 smoke_test.py                  # live pairing check against Suplex
```
