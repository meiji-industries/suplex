# Suplex external-agent skill

`apps/server/skills/suplex/` is the provider-neutral skill template for an external agent
that works with Suplex tasks. It contains:

| File | Purpose |
| --- | --- |
| `SKILL.md` | Agent-facing guardrails, pairing, capability discovery, project selection, duplicate avoidance, idempotent creation, polling, and lifecycle commands. |
| `suplex_client.py` | A standard-library client over the canonical `/api/agent/*` routes, plus a server-free self-check. |
| `smoke_test.py` | A live pairing and idempotency check. |

The template holds no Suplex rules of its own. It calls the same routes as the
MCP tools described in [the MCP guide](agent-mcp.md). Pairing and daily use
never need the `suplex` CLI. See [Tool access](#tool-access) for the order the
skill uses.

## Install

The public `meiji-industries/suplex-skills` repository holds a copy of
`apps/server/skills/`. `.github/workflows/sync-skills.yml` updates it on each push to
`main` that changes `apps/server/skills/`. Install the skill from there:

```bash
npx skills add meiji-industries/suplex-skills --skill suplex --global
```

Or copy `skills/suplex/` into the skill directory for your agent host. After
the install, find the installed folder and report the path that holds
`SKILL.md`, `suplex_client.py`, and `smoke_test.py`. If the install fails or a
file is missing, stop and report the failure. The client
needs Python 3.10 or later and no packages. Set these values in the client
process environment:

- `SUPLEX_BASE_URL`, the Suplex origin, for example `http://127.0.0.1:4111`.
- `SUPLEX_AGENT_CREDENTIAL`, the credential returned by
  `POST /api/agent/pairing/exchange`.

The Python client and MCP bridge read the process environment at call time.
They do not load a `.env` file. Do not pass a credential on a command line,
write it into the skill, or commit it.

For Hermes, copy the directory into the active profile instead:

```bash
cp -R skills/suplex "$HERMES_HOME/skills/suplex"
```

Hermes can supply the two variables through its existing profile-specific
environment configuration. This is a Hermes host instruction, not behavior
implemented by the skill or bridge.

### Grok Bot

Grok Bot runs shell commands on a persistent Linux machine. It has no
`$HERMES_HOME` and no local MCP configuration file. Use the Python client
through the shell.

1. Exchange the pairing code. Use `curl` and read the JSON body from a heredoc.
   This keeps the code off the command line and out of shell history.
   Replace the origin with your Suplex origin:

   ```bash
   umask 077
   curl -sS --fail -X POST https://suplex.example.com/api/agent/pairing/exchange \
     -H 'Content-Type: application/json' \
     --data-binary @- -o pairing-response.json <<'JSON'
   {"pairingCode": "PAIRING-CODE"}
   JSON
   ```

2. Write the two values to an environment file, set its mode to 600, and
   delete the raw response:

   ```bash
   mkdir -p ~/.config/suplex
   python3 - <<'PY'
   import json, os, pathlib
   response = json.loads(pathlib.Path("pairing-response.json").read_text())
   path = pathlib.Path.home() / ".config/suplex/agent.env"
   fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
   with os.fdopen(fd, "w") as env_file:
       env_file.write("export SUPLEX_BASE_URL=https://suplex.example.com\n")
       env_file.write(f"export SUPLEX_AGENT_CREDENTIAL={response['credential']}\n")
   PY
   chmod 600 ~/.config/suplex/agent.env
   rm -f pairing-response.json
   ```

   Source the file only in the process that calls Suplex. Do not source it in
   a shell profile.

3. Install the skill with the command in [Install](#install). Find the
   folder that holds `SKILL.md`, `suplex_client.py`, and `smoke_test.py`.

4. Run the checks in [Verify](#verify) from that folder:

   ```bash
   cd /path/to/installed/suplex
   (. ~/.config/suplex/agent.env && python3 suplex_client.py --self-check && python3 smoke_test.py)
   ```

Grok Bot can also register a remote HTTP MCP connector. Thus the Streamable
HTTP `/mcp` endpoint with OAuth in [the MCP guide](agent-mcp.md) is an option.
This path is not verified for Grok Bot.

## Verify

Run both checks from the installed skill directory. They need Python 3.10 or
later and the standard library only. They do not need the `suplex` CLI.

```bash
python3 suplex_client.py --self-check && python3 smoke_test.py
```

The self-check verifies redaction, stable idempotency keys, and safe missing
configuration errors without contacting a server. The smoke test reads the
agent identity, creates one backlog acknowledgment task twice with the same
idempotency key, and verifies that Suplex returns the same task ID. It never
starts the task.

## Tool access

The skill uses the first transport that is available:

1. Registered Suplex MCP tools, such as `suplex_whoami`.
2. The hosted Streamable HTTP MCP endpoint with OAuth. Read
   `<origin>/.well-known/oauth-protected-resource/mcp`. When its `resource` is
   `<origin>/mcp`, register that endpoint, for example
   `claude mcp add --transport http suplex <origin>/mcp`. An administrator
   approves the company and projects. See [the MCP guide](agent-mcp.md).
3. `suplex_client.py` over the Agent API with the paired credential.

The `suplex` CLI is not required. Do not install it to pair or use the skill,
and do not get a Suplex checkout for it. The npm package named `suplex` is
unrelated to Suplex. The local stdio bridge `suplex mcp` is optional. Use it
only when the Suplex app or a checkout is already present; check with
`suplex --version`.

## Contract maintenance

Every route the template references exists in `apps/server/src/http/routes/agent_api.rs`
or `apps/server/src/http/routes/agent_pairing.rs`. Request shapes come from
`apps/server/src/http/contracts/typed/agent_api.rs`. Keep `SKILL.md` aligned with those contracts.
Do not approximate capabilities that the served contract omits.
