# Machine discovery and the operator handoff

This document has two halves. The first half is public. Any agent can read it and
the artifacts it describes without a credential. The second half is the operator
handoff. It needs an administrator session in Forge.

Forge serves no remote MCP endpoint. The only MCP transport is a local stdio
bridge. See [the bridge guide](../hermes-mcp-bridge.md).

## Public discovery

Forge serves three artifacts without authentication. They describe the contract.
They never contain task data, company data, or a credential.

| Path | Type | Content |
| --- | --- | --- |
| `/llms.txt` | `text/plain` | A plain-text overview of the deployment. |
| `/.well-known/forge/api-catalog.json` | `application/json` | Every public, pairing, and runtime path with its authentication. |
| `/.well-known/forge/agent-skills.json` | `application/json` | The `forge` agent skill, its clients, and the variables to set. |

Read them in this order.

1. Read `/llms.txt` to learn what the deployment is.
2. Read `/.well-known/forge/api-catalog.json` to find the pairing path and the
   runtime paths.
3. Read `/.well-known/forge/agent-skills.json` to choose a client.

Every runtime path stays closed until you pair. `GET /api/hermes/openapi.json`,
`GET /api/hermes/capabilities`, `GET /api/hermes/me`, the workflow and template
discovery routes, and every task route answer
`401` with `credential_invalid` when the request carries no credential. The public
artifacts state this. They do not promise access.

The artifacts are a map. `GET /api/hermes/openapi.json` is the contract. Read the
served document after you pair, and treat it as authoritative when the two differ.

## Install and pair

1. Install the skill. Copy `hermes/skills/forge` into the active Hermes profile.
   [The skill guide](../hermes-skill.md) describes the files.
2. Ask an operator for a pairing code. Forge prints the code once.
3. Exchange the code. Send `POST /api/hermes/pairing/exchange` with the pairing
   code and your profile identifier. The response carries the credential. The
   code is single use.
4. Store the credential. Write `FORGE_BASE_URL` and `FORGE_AGENT_CREDENTIAL` into
   the profile `.env` file. Never pass the credential on a command line. Command
   line arguments are visible to every process on the host, and shell history
   keeps them.
5. Register the MCP bridge, or use the HTTP client. Prefer the bridge.

## Authenticated runtime operation

The credential is scoped. It names one company and the projects granted to the
agent. It grants nothing else.

- Read `GET /api/hermes/me` to learn the granted projects. Do not guess a project
  identifier, and do not read a project list from anywhere else.
- Read `GET /api/hermes/capabilities` to learn what this deployment accepts. The
  reported surface is the registered surface.
- Create a task with `POST /api/hermes/tasks`. An idempotency key is necessary. A
  replay of the same request returns the same task. Creation never starts the task.
- Poll a task with `GET /api/hermes/tasks/{taskId}`. Send the `ETag` in
  `If-None-Match` to receive `304` when nothing changed.
- Send a lifecycle command with `POST /api/hermes/tasks/{taskId}/commands`. The
  current revision and an idempotency key are both necessary.

Forge conceals what you cannot reach. A task in another company, a task in a
project without a grant, a task created by another agent, and a task that does not
exist all answer `404` with the same body. A denial never tells you which case
applied. Treat every `404` as "not available to you" and stop.

Human answers, delivery, and merges are not available to an agent unless
`GET /api/hermes/capabilities` reports them. No tool and no command exists for a
capability the deployment withholds.

[The runtime API guide](../hermes-agent-api.md) describes pagination, filters,
revisions, and error codes in full.

## Operator handoff

These steps need an administrator session. Open **Admin** and then **Agents**, or
call the routes directly. The routes are not part of the agent runtime contract.

### Issue a pairing

1. Create the agent. `POST /api/admin/hermes-agents` takes the name, the company,
   and the project identifiers to grant.
2. Read the pairing code from the response. Forge shows it once.
3. Give the code to the agent operator over a channel you trust.
4. Confirm the exchange. The agent calls `POST /api/hermes/pairing/exchange`. A
   second exchange of the same code fails.

To issue a further code for an existing agent, call
`POST /api/admin/hermes-agents/{agentId}/pairing-code`.

### Rotate a pairing

Rotate when a credential can have leaked, when the agent host changes, or on your
own schedule.

1. Call `POST /api/admin/hermes-agents/{agentId}/rotate`. Forge returns a new
   pairing code and stops the current credential.
2. Give the new code to the agent operator.
3. Ask the operator to exchange it and to replace `FORGE_AGENT_CREDENTIAL` in the
   profile `.env` file.
4. Confirm that `GET /api/hermes/me` answers `200` with the new credential.

The old credential answers `401` from the moment you rotate. Every route reads the
persisted credential on every request.

### Revoke a pairing

1. Call `POST /api/admin/hermes-agents/{agentId}/revoke`. Forge answers `204`.
2. Confirm that the old credential answers `401` with `credential_invalid`.

Revocation stops the agent. It changes no task the agent created.

### Restrict project grants

`PUT /api/admin/hermes-agents/{agentId}/projects` replaces the whole grant list.
It does not add to it. Send every project the agent keeps.

1. Read the current grants from `GET /api/admin/hermes-agents?companyId=...`.
2. Send the reduced list.
3. Confirm the result. `GET /api/hermes/me` with the agent credential must list
   only the projects you kept.
4. Confirm the removal. A task in a removed project must answer `404` with
   `resource_not_found`.

Grants stay inside one company. An agent cannot hold a grant in a second company.
Create a second agent instead.

### Verify an agent integration after an upgrade

Run this sequence after every Forge upgrade, with the agent credential in hand.

1. Read `/llms.txt` and `/.well-known/forge/api-catalog.json` without a
   credential. Both must answer `200`. Neither can contain a credential.
2. Read `GET /api/hermes/openapi.json` with the credential. It must answer `200`.
   Compare its paths against the catalog `runtime` list. A path that the catalog
   names and the document omits is a break.
3. Read `GET /api/hermes/capabilities`. Compare `autonomousCommands` and
   `unavailableCommands` against the previous run. A command that disappeared
   breaks any agent that sent it.
4. Read `GET /api/hermes/me`. Confirm the agent identity and every granted
   project.
5. Read `GET /api/hermes/workflows?projectId=...` and `GET
   /api/hermes/templates?projectId=...`. Confirm that each result reports its
   current create permission.
6. Read `GET /api/hermes/tasks`. Confirm that the tasks the agent created are
   still listed.
7. Create the acknowledgment task twice with the same idempotency key. Run
   `python3 smoke_test.py` from the skill directory, or send
   `POST /api/hermes/tasks` twice. The second call must return the same task
   identifier. The task must stay in `backlog`.
8. Confirm that the runtime routes still refuse an anonymous request. Send
   `GET /api/hermes/me` with no header. It must answer `401`.
9. Archive or cancel the acknowledgment task when you finish.

Report a failure at any step as a break in the agent contract, not as an agent
error.
