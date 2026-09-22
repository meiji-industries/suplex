# Connect an MCP client to Forge

Forge serves a Streamable HTTP MCP endpoint at `/mcp`. OAuth 2.1 protects the endpoint. The client gets access only after an administrator approves a company and one or more projects.

## Connect Claude Code

Run these commands with the canonical Forge origin:

```bash
claude mcp add --transport http forge https://forge.example.com/mcp
claude mcp login forge
```

You can also run `/mcp` in Claude Code and select **Authenticate**. Forge opens the sign-in page when necessary. Forge then shows the client name, callback, company, permission, and project selection.

The client name comes from dynamic client registration. Forge does not verify that name. Check the callback before you select **Approve**.

Remote web clients need a reachable HTTPS Forge origin. Loopback HTTP works for local development. Forge does not enable OAuth on a remote HTTP origin.

See the [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) and the [MCP authorization specification](https://modelcontextprotocol.io/specification/latest/basic/authorization).

## Tools

Both the HTTP and stdio transports expose the same tools:

| Tool | Purpose |
| --- | --- |
| `forge_whoami` | Read the agent identity, projects, and task policy. |
| `forge_capabilities` | Read autonomous and unavailable commands. |
| `forge_list_workflows` | List workflows for a granted project. |
| `forge_list_templates` | List templates for a granted project. |
| `forge_list_tasks` | List tasks in currently granted projects. It defaults to the compact `summary` view. Use `view: "full"` for the complete projection. It accepts `pullRequestNumber`, `sourceBranch`, and case-insensitive `titleContains` filters. |
| `forge_get_task` | Read a task in a granted project or report that a known revision is unchanged. |
| `forge_get_task_delivery` | Read the delivery and blocker projection. |
| `forge_create_task` | Create a backlog or queued task with an idempotency key. |
| `forge_set_task_dependencies` | Replace the prerequisites of a task. |
| `forge_command_task` | Apply a lifecycle command with the current revision. |

Forge re-reads the agent, administrator authority, company access, and project grants for each access or refresh. Revocation takes effect without restarting Forge. Access tokens apply only to `/mcp`.

Task reads cover every task in the approved projects. A task created by another actor has an empty `permittedCommands` array. Lifecycle commands and dependency changes remain limited to tasks that the connected agent created.

MCP exposes lifecycle task commands only. It does not expose runtime delivery or merge commands. Human answers remain unavailable to paired agents. Forge can perform a task's configured delivery, including a merge after review, without an agent command.

## Use the advanced stdio setup

Use stdio when the MCP client runs on the Forge host or when you need the legacy pairing workflow. Create an external agent in Forge, exchange its pairing code, and set these variables in the client process:

```text
FORGE_BASE_URL=http://127.0.0.1:4111
FORGE_AGENT_CREDENTIAL=<replace locally>
```

Never pass the credential as a command-line argument. Register the local bridge in the private client configuration:

```json
{
  "mcpServers": {
    "forge": {
      "command": "forge",
      "args": ["mcp"],
      "env": {
        "FORGE_BASE_URL": "${FORGE_BASE_URL}",
        "FORGE_AGENT_CREDENTIAL": "${FORGE_AGENT_CREDENTIAL}"
      }
    }
  }
}
```

From a source checkout, use `pnpm` as the command. Set the arguments to `["--dir", "/absolute/path/to/forge", "run", "forge", "mcp"]`.

The stdio bridge maps tools to `/api/agent/*`. Forge keeps task rules, project grants, idempotency, and revisions in `TaskService` for both transports.
