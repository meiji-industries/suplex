# Forge MCP bridge

The bridge is a stdio MCP server that exposes the Agent API as typed tools.
It maps each tool onto an existing `/api/agent/*` route.
It holds no task rules of its own: Forge stays the sole authority on grants,
permitted commands, idempotency, and revisions.

The paired-agent skill that uses these tools, and its HTTP fallback client,
ship in `skills/forge/`. See `docs/agent-skill.md`.

## Local stdio configuration

The bridge reads two variables from its process environment and nothing else.
It does not load a `.env` file:

- `FORGE_BASE_URL`, the Forge origin, for example `http://127.0.0.1:4111`.
- `FORGE_AGENT_CREDENTIAL`, the scoped external-agent credential from the pairing
  exchange.

Never pass the credential as a command-line argument: arguments are visible to
every process on the host and are recorded in shell history. No tool accepts a
credential parameter.

Register the server with a local stdio MCP client. Put both variables in the
private server entry. Do not assume a desktop client inherits the variables
from your shell:

```json
{
  "mcpServers": {
    "forge": {
      "command": "forge",
      "args": ["mcp"],
      "env": {
        "FORGE_BASE_URL": "http://127.0.0.1:4111",
        "FORGE_AGENT_CREDENTIAL": "<replace locally>"
      }
    }
  }
}
```

Preserve other server entries when you edit the client configuration. From a
source checkout, use `"command": "pnpm"` with
`"args": ["--dir", "/absolute/path/to/forge", "run", "forge", "mcp"]`.
The absolute path makes the command independent of the host's working
directory. The bridge speaks
JSON-RPC on stdin and stdout. It does not start a Forge server; start Forge
separately.

Claude Code supports `${VAR}` references in the `env` object of a private
`.mcp.json` entry. Claude Desktop does not reliably inherit shell variables,
so replace the example values in its private `claude_desktop_config.json`.
Claude.ai and ChatGPT web require a remotely reachable MCP server. Forge ships
no remote MCP endpoint, so the local stdio setup applies only to desktop and
CLI hosts.

## Tools

| Tool | Route | Notes |
| --- | --- | --- |
| `forge_whoami` | `GET /api/agent/me` | Agent identity, capabilities, and granted projects with the create-time policy each one permits. |
| `forge_capabilities` | `GET /api/agent/capabilities` | Autonomous commands and unavailable commands. |
| `forge_list_workflows` | `GET /api/agent/workflows` | Non-archived workflows for one granted project and the creation permission for each one. |
| `forge_list_templates` | `GET /api/agent/templates` | Templates for one granted project and the creation permission for each one. |
| `forge_list_tasks` | `GET /api/agent/tasks` | Filters and the opaque cursor come from the runtime contract. |
| `forge_get_task` | `GET /api/agent/tasks/{taskId}` | Pass `knownRevision` to poll conditionally. An unchanged task returns `{ "unchanged": true, "revision": "…" }`. |
| `forge_get_task_delivery` | `GET /api/agent/tasks/{taskId}` | The delivery, blocker, and completion observation of the same projection. |
| `forge_create_task` | `POST /api/agent/tasks` | `idempotencyKey` is required. Creates a backlog task. With `queue: true` the task is queued and starts by itself when every prerequisite is complete. |
| `forge_set_task_dependencies` | `PUT /api/agent/tasks/{taskId}/dependencies` | Replaces the prerequisites (`dependsOn`, shown as Blocked by) with the complete set given. `forge_get_task` reads them back as `dependsOn` and `blockedBy`. |
| `forge_command_task` | `POST /api/agent/tasks/{taskId}/commands` | Requires the current `revision` and an `idempotencyKey`. |

Every tool input schema is generated from the zod contract in
`src/http/contracts/agent-api.ts`, so the tools cannot drift from the served
`/api/agent/openapi.json` document.

### Approval and irreversibility

- `forge_create_task` is idempotent for one `idempotencyKey`. An identical
  replay returns the same task with status `200`. Reusing the key for a
  different request fails with `idempotency_conflict`.
- `forge_command_task` needs the task's current `revision`. A stale revision
  fails with `revision_stale`; read the task again and retry with the current
  value. The `note` field is only accepted by `send_task_note`.
- `start_task` queues the task: it starts now when every prerequisite is
  complete and never bypasses one. `disarm_task` returns a queued task to the
  manual backlog. `forge_get_task` and `forge_get_task_delivery` report
  `queue` with the start intent, the state, and each wait reason.
- `cancel_task` and `archive_task` are not reversible by the agent. Confirm
  intent with the person you work for before you send `start_task`,
  `cancel_task`, or `archive_task`.
- Human answers and delivery completion are unavailable through MCP. Delivery
  refresh, repair, decisions, approvals, merge-train operations, merge, and
  provenance remain API-only when the deployment exposes them. There is no
  generic "call any endpoint" tool.

### Failures and redaction

A route that fails returns the server's safe error body, `code`, `error`, and
any `findings`, together with its HTTP status, and the tool result is marked
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
- Authenticate every MCP session against a scoped external-agent credential, and hold
  that credential server-side. Never accept it as a tool argument or a URL
  parameter.
- Bind one MCP session to one paired agent, and re-read the persisted
  credential and project grants on every request so a revoked credential stops
  working immediately, as the local routes already do.
- Validate the `Origin` header and require an explicit allow list of clients.
- Bind the listener to a private interface or a private network overlay.
- Keep the same redaction rules: no credential in responses, logs, or traces.
