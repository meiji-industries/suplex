# Forge MCP bridge

The bridge is a stdio MCP server that exposes the paired-agent Hermes runtime
API as typed tools. It maps each tool onto an existing `/api/hermes/*` route.
It holds no task rules of its own: Forge stays the sole authority on grants,
permitted commands, idempotency, and revisions.

## Local stdio configuration

The bridge reads two variables from the process environment and nothing else.
Keep them in the active profile's `$HERMES_HOME/.env`, the same file the Forge
pairing instructions write:

- `FORGE_BASE_URL` — the Forge origin, for example `http://127.0.0.1:4111`.
- `FORGE_AGENT_CREDENTIAL` — the paired-agent credential from the pairing
  exchange.

Never pass the credential as a command-line argument: arguments are visible to
every process on the host and are recorded in shell history. No tool accepts a
credential parameter.

Register the server with the Hermes MCP client:

```json
{
  "mcpServers": {
    "forge": {
      "command": "forge",
      "args": ["mcp"]
    }
  }
}
```

From a source checkout, use `pnpm run forge mcp` instead. The bridge speaks
JSON-RPC on stdin and stdout. It does not start a Forge server; start Forge
separately.

## Tools

| Tool | Route | Notes |
| --- | --- | --- |
| `forge_whoami` | `GET /api/hermes/me` | Agent identity, capabilities, and granted projects. |
| `forge_capabilities` | `GET /api/hermes/capabilities` | Autonomous commands and unavailable commands. |
| `forge_list_tasks` | `GET /api/hermes/tasks` | Filters and the opaque cursor come from the runtime contract. |
| `forge_get_task` | `GET /api/hermes/tasks/{taskId}` | Pass `knownRevision` to poll conditionally. An unchanged task returns `{ "unchanged": true, "revision": "…" }`. |
| `forge_get_task_delivery` | `GET /api/hermes/tasks/{taskId}` | The delivery, blocker, and completion observation of the same projection. |
| `forge_create_task` | `POST /api/hermes/tasks` | `idempotencyKey` is required. Creates a backlog task and never starts execution. |
| `forge_command_task` | `POST /api/hermes/tasks/{taskId}/commands` | Requires the current `revision` and an `idempotencyKey`. |

Every tool input schema is generated from the zod contract in
`src/http/contracts/hermes.ts`, so the tools cannot drift from the served
`/api/hermes/openapi.json` document.

### Approval and irreversibility

- `forge_create_task` is idempotent for one `idempotencyKey`. An identical
  replay returns the same task with status `200`. Reusing the key for a
  different request fails with `idempotency_conflict`.
- `forge_command_task` needs the task's current `revision`. A stale revision
  fails with `revision_stale`; read the task again and retry with the current
  value. The `note` field is only accepted by `send_task_note`.
- `start_task`, `cancel_task`, and `archive_task` are not reversible by the
  agent. Confirm intent with the person you work for before you send them.
- Human answers, delivery, releases, and merges are unavailable. There is no
  tool for them, and no generic "call any endpoint" tool exists.

### Failures and redaction

A route that fails returns the server's safe error body — `code`, `error`, and
any `findings` — together with its HTTP status, and the tool result is marked
as an error. The bridge never writes the `Authorization` header, the
credential, or raw environment values into results, thrown messages, or logs,
and it replaces the credential string with `[redacted credential]` if it ever
appears in one. A missing variable reports which variable to set and prints no
values.

## Optional remote Streamable HTTP deployment

This repository ships the stdio transport only. A remote deployment over MCP
Streamable HTTP is possible but is not part of Forge today. If you build one,
it must keep the same safeguards:

- Terminate TLS and refuse plaintext transports.
- Authenticate every MCP session against a paired-agent credential, and hold
  that credential server-side. Never accept it as a tool argument or a URL
  parameter.
- Bind one MCP session to one paired agent, and re-read the persisted
  credential and project grants on every request so a revoked credential stops
  working immediately, as the local routes already do.
- Validate the `Origin` header and require an explicit allow list of clients.
- Bind the listener to a private interface or a private network overlay.
- Keep the same redaction rules: no credential in responses, logs, or traces.
