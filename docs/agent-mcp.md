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

Remote web clients need a reachable HTTPS Suplex origin. Loopback HTTP works for local development. Suplex does not enable OAuth on a remote HTTP origin. When a reverse proxy serves Suplex, set the HTTPS address in Settings > Remote Access. Suplex uses that address as the OAuth issuer and the MCP address.

See the [Claude Code MCP guide](https://code.claude.com/docs/en/mcp) and the [MCP authorization specification](https://modelcontextprotocol.io/specification/latest/basic/authorization).

## Tools

Both the HTTP and stdio transports expose the same tools:

| Tool | Purpose |
| --- | --- |
| `suplex_whoami` | Read the agent identity, projects, and project delivery defaults (`deliveryDefaults`; `agentTaskPolicy` is a deprecated alias). |
| `suplex_capabilities` | Read autonomous and unavailable commands. |
| `suplex_list_workflows` | List workflows for a granted project. |
| `suplex_list_templates` | List templates for a granted project. |
| `suplex_list_tasks` | List tasks in currently granted projects. It defaults to the compact `summary` view. Use `view: "full"` for the complete projection. It accepts `pullRequestNumber`, `sourceBranch`, and case-insensitive `titleContains` filters. |
| `suplex_get_task` | Read a task in a granted project or report that a known revision is unchanged. |
| `suplex_get_task_delivery` | Read the delivery and blocker projection. |
| `suplex_create_task` | Create a backlog or queued task with an idempotency key. |
| `suplex_update_task` | Change the details and Advisor profiles of a backlog or queued task with the current revision. |
| `suplex_set_task_dependencies` | Replace the prerequisites of a task. A prerequisite task with a pull request delivery target is complete when its pull request merges. |
| `suplex_command_task` | Apply a lifecycle command with a task revision, including `move_to_front` for queued tasks. A change to only `updatedAt` or `delivery` does not make the revision stale. |
| `suplex_list_moves`, `suplex_get_move` | List and read saved Moves in a granted project. |
| `suplex_create_move`, `suplex_update_move`, `suplex_delete_move` | Create idempotently, revise with `updatedAt`, or delete a Move. Deleting a Move deletes its run records. |
| `suplex_start_move`, `suplex_list_move_runs`, `suplex_get_move_run` | Start idempotently and inspect Move runs. |
| `suplex_get_move_run_transcript`, `suplex_stop_move_run`, `suplex_archive_move_run` | Inspect, stop, or archive a run. |

Suplex re-reads the agent, administrator authority, company access, and project grants for each access or refresh. Revocation takes effect without restarting Suplex. Access tokens apply only to `/mcp`.

Moves require both the administrator's Move grant and a current grant to the Move's project. A prompt Move may still require a person at its interactive terminal; MCP and the Agent API do not provide remote terminal interaction.

`suplex_update_task` changes a backlog or queued task directly. A queued task stays queued with the same prerequisites. To hold a queued task while it changes, send `disarm_task` with `suplex_command_task`, update the task, then send `start_task` to queue it again. An empty `advisorProfileIds` object returns each Advisor role to its default. An active or delivered task accepts only a later `deliveryTarget`: the Coordinator continues toward the new target, and a delivered task reopens. Other task states return `illegal_command`.

Task reads and lifecycle commands cover tasks in the agent's granted projects, including tasks created by GitHub label triggers.
`force_start` starts a queued task now, without waiting for its prerequisites or a project slot. `move_to_front` puts a queued task ahead of other queued tasks without bypassing prerequisites or concurrency limits. Each later promotion takes the front position.

MCP exposes lifecycle task commands only. It does not expose runtime delivery or merge commands. A paired agent can answer a task's Coordinator question with `answer_human_question` in `suplex_command_task` only after an administrator lets it answer on their behalf. Send `questionId` from `suplex_get_task` `question.id` and exactly one of `optionId` or `answer`. Task limit decisions and command cleanup confirmations stay with a person. See [the runtime API guide](agent-api.md#answering-a-coordinator-question). Suplex can perform a task's configured delivery, including a merge after review, without an agent command.

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

The stdio bridge maps tools to `/api/agent/*`. The native task and agent routes enforce task rules, project grants, idempotency, and revisions for both transports.
