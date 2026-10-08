# Suplex external-agent skill

`apps/server/skills/suplex/` is the provider-neutral skill template for an external agent
that works with Suplex tasks. It contains:

| File | Purpose |
| --- | --- |
| `SKILL.md` | Agent-facing guardrails, pairing, capability discovery, project selection, duplicate avoidance, idempotent creation, polling, and lifecycle commands. |
| `suplex_client.py` | A standard-library client over the canonical `/api/agent/*` routes, plus a server-free self-check. |
| `smoke_test.py` | A live pairing and idempotency check. |

The template holds no Suplex rules of its own. It calls the same routes as the
MCP bridge described in [the MCP guide](agent-mcp.md). The skill tells the
agent to prefer the MCP tools when the bridge is registered.

## Install

The public `meiji-industries/suplex-skills` repository holds a copy of
`apps/server/skills/`. `.github/workflows/sync-skills.yml` updates it on each push to
`main` that changes `apps/server/skills/`. Install the skill from there:

```bash
npx skills add meiji-industries/suplex-skills --skill suplex --global
```

Or copy `apps/server/skills/suplex/` into the skill directory for your agent host. The client
needs Python 3.10 or later and no packages. Set these values in the client
process environment:

- `SUPLEX_BASE_URL`, the Suplex origin, for example `http://127.0.0.1:4111`.
- `SUPLEX_AGENT_CREDENTIAL`, the credential returned by
  `POST /api/agent/pairing/exchange`.

The Python client and MCP bridge read the process environment at call time.
They do not load a `.env` file. Do not pass a credential on a command line,
write it into the skill, or commit it.

For Hermes, copy the directory into the active profile:

```bash
cp -R apps/server/skills/suplex "$HERMES_HOME/skills/suplex"
```

Hermes can supply the two variables through its existing profile-specific
environment configuration. This is a Hermes host instruction, not behavior
implemented by the skill or bridge.

## Verify

Run both checks from the installed skill directory:

```bash
python3 suplex_client.py --self-check
python3 smoke_test.py
```

The self-check verifies redaction, stable idempotency keys, and safe missing
configuration errors without contacting a server. The smoke test reads the
agent identity, creates one backlog acknowledgment task twice with the same
idempotency key, and verifies that Suplex returns the same task ID. It never
starts the task.

## Contract maintenance

Every route the template references exists in `apps/server/src/http/routes/agent_api.rs`
or `apps/server/src/http/routes/agent_pairing.rs`. Request shapes come from
`apps/server/src/http/contracts/typed/agent_api.rs`. Keep `SKILL.md` aligned with those contracts.
Do not approximate capabilities that the served contract omits.
