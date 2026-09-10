# Hermes agent API

Hermes credentials use bearer authentication. Every request reads the current
persisted credential and project grants. A revoked credential returns `401`.
Tasks remain concealed with `404` unless the caller is their creator and has a
current grant for the task project in the agent's company.

## Discovery

`GET /api/hermes/me` returns the authenticated agent identity, actual supported
capabilities, and `{ id, name }` metadata for currently granted projects.

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
report.

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

`docs/hermes-mcp-bridge.md` describes the stdio MCP bridge that exposes these
routes as tools.
