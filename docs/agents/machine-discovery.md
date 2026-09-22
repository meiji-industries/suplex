# Machine discovery and the operator handoff

This document has two halves. The first half is public. Any agent can read it and
the artifacts it describes without a credential. The second half is the operator
handoff. It needs an administrator session in Suplex.

Suplex serves a remote Streamable HTTP MCP endpoint at `/mcp`. OAuth 2.1 browser
approval protects it. The local stdio bridge and the Agent API remain advanced
pairing options. See [the MCP guide](../agent-mcp.md).

## Public discovery

Suplex serves six artifacts without authentication. They describe the contract.
They never contain task data, company data, or a credential.

| Path | Type | Content |
| --- | --- | --- |
| `/llms.txt` | `text/plain` | A plain-text overview of the deployment. |
| `/.well-known/suplex/api-catalog.json` | `application/json` | Every public, pairing, and runtime path with its authentication. |
| `/.well-known/suplex/agent-skills.json` | `application/json` | The `suplex` agent skill, its clients, and the variables to set. |
| `/.well-known/oauth-protected-resource/mcp` | `application/json` | The canonical MCP resource and its authorization server. |
| `/.well-known/oauth-protected-resource` | `application/json` | The root compatibility form of the protected-resource metadata. |
| `/.well-known/oauth-authorization-server` | `application/json` | OAuth endpoints, grants, scopes, and PKCE methods. |

Read them in this order.

1. Read `/llms.txt` to learn what the deployment is.
2. Read `/.well-known/suplex/api-catalog.json` to find the MCP, pairing, and runtime paths.
3. Read `/.well-known/suplex/agent-skills.json` to choose a client.

`POST /mcp` stays closed until OAuth approval. Every Agent API runtime path stays closed until you pair. `GET /api/agent/openapi.json`,
`GET /api/agent/capabilities`, `GET /api/agent/me`, the workflow and template
discovery routes, and every task route answer
`401` with `credential_invalid` when the request carries no credential. The public
artifacts state this. They do not promise access.

The artifacts are a map. `GET /api/agent/openapi.json` is the contract. Read the
served document after you pair, and treat it as authoritative when the two differ.

## Connect through OAuth

1. Add the canonical `/mcp` resource to the MCP client.
2. Start the client login flow.
3. Sign in to Suplex when Suplex asks you to sign in.
4. Check the callback, and select the company and projects.
5. Select **Approve**.

Suplex creates or reuses one stable external-agent identity for the registered
client, the administrator, and the company. Refresh and reconnect keep that
identity. The Agents page controls its grants and revocation.

## Use advanced pairing

1. Install the skill in the client that will use it. Hermes users copy
   `skills/suplex` into the active Hermes profile. [The skill guide](../agent-skill.md)
   describes the files.
2. Ask an operator for a pairing code. Suplex prints the code once.
3. Exchange the code. Send `POST /api/agent/pairing/exchange` with the pairing
   code and your profile identifier. The response carries the credential. The
   code is single use.
4. Store the credential in the MCP server environment. The bridge reads
   `SUPLEX_BASE_URL` and `SUPLEX_AGENT_CREDENTIAL` from `process.env` only. Never
   pass the credential on a command line. Command line arguments are visible to
   every process on the host, and shell history keeps them.
5. Register the MCP bridge, or use the HTTP client. Prefer the bridge.

## Authenticated runtime operation

The credential is scoped. It names one company and the projects granted to the
agent. It grants nothing else.

- Read `GET /api/agent/me` to learn the granted projects. Do not guess a project
  identifier, and do not read a project list from anywhere else.
- Read `GET /api/agent/capabilities` to learn what this deployment accepts. The
  reported surface is the registered surface.
- List tasks with `suplex_list_tasks`. It defaults to a compact summary. Filter
  by pull request number, source branch, or case-insensitive title substring,
  and set `view` to `full` when the complete projection is needed.
- Create a task with `POST /api/agent/tasks`. An idempotency key is necessary. A
  replay of the same request returns the same task. Creation never starts the task.
- Poll a task with `GET /api/agent/tasks/{taskId}`. Send the `ETag` in
  `If-None-Match` to receive `304` when nothing changed.
- Send a lifecycle command with `POST /api/agent/tasks/{taskId}/commands`. The
  current revision and an idempotency key are both necessary.

Suplex conceals what you cannot reach. A task in another company, a task in a
project without a grant, and a task that does not exist all answer `404` with the
same body. A denial never tells you which case applied. Treat every `404` as
"not available to you" and stop. Reads include tasks that users or other agents
created in granted projects. Those tasks have no permitted commands. Task
commands and dependency changes remain limited to tasks this agent created.

Human answers are not available to paired agents. The runtime API exposes
delivery and merge commands only when `GET /api/agent/capabilities` reports
them. MCP exposes lifecycle task commands only. Suplex can perform a task's
configured delivery, including a merge after review, without an agent command.

[The runtime API guide](../agent-api.md) describes pagination, filters,
revisions, and error codes in full.

## Operator handoff

These steps need an administrator session. Open **Admin** and then **Agents**, or
call the routes directly. The routes are not part of the agent runtime contract.

### Issue a pairing

1. Create the agent. `POST /api/admin/external-agents` takes the name, the company,
   and the project identifiers to grant.
2. Read the pairing code from the response. Suplex shows it once.
3. Give the code to the agent operator over a channel you trust.
4. Confirm the exchange. The agent calls `POST /api/agent/pairing/exchange`. A
   second exchange of the same code fails.

To issue a further code for an existing agent, call
`POST /api/admin/external-agents/{agentId}/pairing-code`.

### Rotate a pairing

Rotate when a credential can have leaked, when the agent host changes, or on your
own schedule.

1. Call `POST /api/admin/external-agents/{agentId}/rotate`. Suplex returns a new
   pairing code and stops the current credential.
2. Give the new code to the agent operator.
3. Ask the operator to exchange it and to replace `SUPLEX_AGENT_CREDENTIAL` in the
   profile `.env` file.
4. Confirm that `GET /api/agent/me` answers `200` with the new credential.

The old credential answers `401` from the moment you rotate. Every route reads the
persisted credential on every request.

### Revoke a pairing

1. Call `POST /api/admin/external-agents/{agentId}/revoke`. Suplex answers `204`.
2. Confirm that the old credential answers `401` with `credential_invalid`.

Revocation stops the agent. It changes no task the agent created.

### Restrict project grants

`PUT /api/admin/external-agents/{agentId}/projects` replaces the whole grant list.
It does not add to it. Send every project the agent keeps.

1. Read the current grants from `GET /api/admin/external-agents?companyId=...`.
2. Send the reduced list.
3. Confirm the result. `GET /api/agent/me` with the agent credential must list
   only the projects you kept.
4. Confirm the removal. A task in a removed project must answer `404` with
   `resource_not_found`.

Grants stay inside one company. An agent cannot hold a grant in a second company.
Create a second agent instead.

### Verify an agent integration after an upgrade

Run this sequence after every Suplex upgrade, with the agent credential in hand.

1. Read `/llms.txt` and `/.well-known/suplex/api-catalog.json` without a
   credential. Both must answer `200`. Neither can contain a credential.
2. Read `GET /api/agent/openapi.json` with the credential. It must answer `200`.
   Compare its paths against the catalog `runtime` list. A path that the catalog
   names and the document omits is a break.
3. Read `GET /api/agent/capabilities`. Compare `autonomousCommands` and
   `unavailableCommands` against the previous run. A command that disappeared
   breaks any agent that sent it.
4. Read `GET /api/agent/me`. Confirm the agent identity and every granted
   project.
5. Read `GET /api/agent/workflows?projectId=...` and `GET
   /api/agent/templates?projectId=...`. Confirm that each result reports its
   current create permission.
6. Read `GET /api/agent/tasks`. Confirm that the tasks the agent created are
   still listed.
7. Create the acknowledgment task twice with the same idempotency key. Run
   `python3 smoke_test.py` from the skill directory, or send
   `POST /api/agent/tasks` twice. The second call must return the same task
   identifier. The task must stay in `backlog`.
8. Confirm that the runtime routes still refuse an anonymous request. Send
   `GET /api/agent/me` with no header. It must answer `401`.
9. Archive or cancel the acknowledgment task when you finish.

Report a failure at any step as a break in the agent contract, not as an agent
error.
