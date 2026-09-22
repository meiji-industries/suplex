# Connect an MCP client to Suplex

Suplex serves a Streamable HTTP MCP endpoint at `/mcp`. OAuth 2.1 protects the endpoint. The client gets access only after an administrator approves a company and one or more projects.

## Connect Claude Code

Run these commands with the canonical Suplex origin:

```bash
claude mcp add --transport http suplex https://suplex.example.com/mcp
claude mcp login suplex
```

You can also run `/mcp` in Claude Code and select **Authenticate**. Suplex opens the sign-in page when necessary. Suplex then shows the client name, callback, company, permission, and project selection.

The client name comes from dynamic client registration. Suplex does not verify that name. Check the callback before you select **Approve**.

Remote web clients need a reachable HTTPS Suplex origin. Loopback HTTP works for local development. Suplex does not enable OAuth on a remote HTTP origin.

See the [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) and the [MCP authorization specification](https://modelcontextprotocol.io/specification/latest/basic/authorization).

## Tools

Both the HTTP and stdio transports expose the same tools:

| Tool | Purpose |
| --- | --- |
| `suplex_whoami` | Read the agent identity, projects, and task policy. |
| `suplex_capabilities` | Read autonomous and unavailable commands. |
| `suplex_list_workflows` | List workflows for a granted project. |
| `suplex_list_templates` | List templates for a granted project. |
| `suplex_list_tasks` | List tasks in currently granted projects. It defaults to the compact `summary` view. Use `view: "full"` for the complete projection. It accepts `pullRequestNumber`, `sourceBranch`, and case-insensitive `titleContains` filters. |
| `suplex_get_task` | Read a task in a granted project or report that a known revision is unchanged. |
| `suplex_get_task_delivery` | Read the delivery and blocker projection. |
| `suplex_create_task` | Create a backlog or queued task with an idempotency key. |
| `suplex_set_task_dependencies` | Replace the prerequisites of a task. |
| `suplex_command_task` | Apply a lifecycle command with the current revision. |

Suplex re-reads the agent, administrator authority, company access, and project grants for each access or refresh. Revocation takes effect without restarting Suplex. Access tokens apply only to `/mcp`.

Task reads cover every task in the approved projects. A task created by another actor has an empty `permittedCommands` array. Lifecycle commands and dependency changes remain limited to tasks that the connected agent created.

MCP exposes lifecycle task commands only. It does not expose runtime delivery or merge commands. Human answers remain unavailable to paired agents. Suplex can perform a task's configured delivery, including a merge after review, without an agent command.

## Use the advanced stdio setup

Use stdio when the MCP client runs on the Suplex host or when you need the legacy pairing workflow. Create an external agent in Suplex, exchange its pairing code, and set these variables in the client process:

```text
SUPLEX_BASE_URL=http://127.0.0.1:4111
SUPLEX_AGENT_CREDENTIAL=<replace locally>
```

Never pass the credential as a command-line argument. Register the local bridge in the private client configuration:

```json
{
  "mcpServers": {
    "suplex": {
      "command": "suplex",
      "args": ["mcp"],
      "env": {
        "SUPLEX_BASE_URL": "${SUPLEX_BASE_URL}",
        "SUPLEX_AGENT_CREDENTIAL": "${SUPLEX_AGENT_CREDENTIAL}"
      }
    }
  }
}
```

From a source checkout, use `pnpm` as the command. Set the arguments to `["--dir", "/absolute/path/to/suplex", "run", "suplex", "mcp"]`.

The stdio bridge maps tools to `/api/agent/*`. Suplex keeps task rules, project grants, idempotency, and revisions in `TaskService` for both transports.
