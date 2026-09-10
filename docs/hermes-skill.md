# Forge skill for Hermes

`hermes/skills/forge/` is the skill template a paired Hermes profile installs to
work with Forge tasks. It contains:

| File | Purpose |
| --- | --- |
| `SKILL.md` | The agent-facing instructions: guardrails, pairing and rotation, capability discovery, project selection, duplicate avoidance, idempotent creation, polling, lifecycle commands, and how to read blocked, waiting, and stale responses. |
| `forge_client.py` | A standard-library client over the `/api/hermes/*` routes, plus a server-free self-check. |
| `smoke_test.py` | The pairing verification, which is also the connectivity acknowledgment task. |

The template holds no Forge rules of its own. It calls the same routes as the
MCP bridge described in `docs/hermes-mcp-bridge.md`, and `SKILL.md` tells the
agent to prefer the MCP tools when that bridge is registered.

## Install

Copy the directory into the active Hermes profile:

```bash
cp -R hermes/skills/forge "$HERMES_HOME/skills/forge"
```

Set the two variables in that profile's `$HERMES_HOME/.env`, the same file the
pairing dialog writes:

- `FORGE_BASE_URL` — the Forge origin, for example `http://127.0.0.1:4111`.
- `FORGE_AGENT_CREDENTIAL` — the credential returned by
  `POST /api/hermes/pairing/exchange`.

Both are read from the process environment at call time. Neither is ever passed
on a command line, written into the skill, or committed: command-line arguments
are visible to every process on the host and are recorded in shell history.

The client needs Python 3.10 or later and no packages.

## Verify

Run both checks from `$HERMES_HOME/skills/forge`:

```bash
python3 forge_client.py --self-check   # redaction and idempotency keys; no server needed
python3 smoke_test.py                  # live check against Forge
```

`--self-check` asserts that the credential is replaced wherever it could reach
a transcript, that one payload always derives one idempotency key while a
changed payload derives a different one, and that missing configuration fails
without printing a value.

`smoke_test.py` reports only that each variable is set and the base URL host,
reads the agent identity with `GET /api/hermes/me`, then creates the
acknowledgment task twice with the idempotency key
`forge-connectivity-<agentId>` and asserts Forge returns the same task ID.
It exits non-zero with a plain message when configuration is missing (`2`) or
when Forge, project access, or idempotency fails (`1`). It never starts the
task; the task stays in `backlog` until a person selects **Start** in Forge.

## Keeping it honest

Every route the template references exists in `src/http/routes/hermes-tasks.ts`
and `src/http/routes/hermes-pairing.ts`, and every request shape comes from
`src/http/contracts/hermes.ts`. Capabilities the agent does not have — answering
a human question, delivering a task, and merging when the deployment leaves the
agent delivery surface off — are named in `SKILL.md` as unavailable rather than
approximated. When the contracts change, update `SKILL.md` in the same change.
