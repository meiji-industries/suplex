# 15. OMP CLI provider

This decision records dated provider probes. Consult the [product guide](../product.md)
for current claims and the [Pi runtime](../../apps/server/src/runtimes/pi/) for the
implemented invocation and recovery behavior. Probe results are not a current
release or account verification.

Date: 2026-10-20

## Status

Accepted

## Context

OMP (`omp`, from `@oh-my-pi/pi-coding-agent`, <https://github.com/can1357/oh-my-pi>)
is a fork of Pi. Suplex needs it as a sixth local agent provider. Probes against
omp 18.12.3, installed with `curl -fsSL https://omp.sh/install | sh -s -- --binary`,
compared its flags, events, session file, bridge mechanism, and model listing
with Pi ([ADR 14](0014-pi-cli-provider.md)). A local fake OpenAI-compatible
server in a throwaway `PI_CODING_AGENT_DIR` stood in for a model provider, and
a fake stdio MCP server stood in for the Suplex bridge.

## Decision

omp shares the Pi runtime. `runtimes/pi/cli.rs` describes each CLI: executable,
provider id `omp`, session directory `omp-sessions`, routing prefix `omp-`,
session identity, bridge registration, read-only tools, model listing, display
subcommand `omp-display`, and the install and sign-in commands. The registry
selects the omp instance for provider `omp` and for native session ids that
start with `omp-`. No Pi module is copied.

Each turn runs
`omp --mode json --model <provider/id> --thinking <level> --session-dir <runtime>/omp-sessions [--resume <file>] --no-title`.
The prompt comes from standard input. omp has no `--session-id`, so the Suplex
id only routes the session. The first turn creates the session in the private
directory, and each later turn resumes the latest session file there. The
reader takes the conversation from that file. `--no-title` stops a second model
request that would only name the session.

A Coordinator or Advisor turn adds `--tools read,grep,glob -e <runtime>/suplex-bridge`.
That directory holds one `.mcp.json` that declares `suplex_root` or
`suplex_advisor`. Its `env` names each bridge variable as `${NAME}`; omp expands
the values from its own environment, so the file holds no secret. The timeout is
3,600,000 milliseconds. A Worker turn keeps omp's default tools.

## Evidence

- `omp --help` lists `-p/--print`, `--mode text|json|rpc|rpc-ui`, `-c/--continue`,
  `-r/--resume <id prefix|path>`, `--session-dir`, `--no-session`, `--model`,
  `--thinking off|minimal|low|medium|high|xhigh|max|auto`, `--system-prompt`,
  `--append-system-prompt`, `--cwd`, `--profile`, `--tools`, `-e/--extension`,
  and `--no-title`. It has no `--session-id`. ACP is the `omp acp` command.
- With `--mode json`, omp reads a piped prompt from standard input. The turn log
  starts with a `session` header (version 3, a UUIDv7 `id`) and then prints Pi's
  agent, message, and tool execution events. It prints no `agent_settled`, and
  its `agent_end` has no `willRetry`. A retry starts with `auto_retry_start`
  after the failed `agent_end`, and `auto_retry_end` ends it. omp exits 1 when
  the final response failed or stopped.
- `--session-dir` keeps sessions flat in that directory as
  `<timestamp>_<id>.jsonl`, with an artifact directory of the same stem. The file
  starts with a fixed-width 256-byte `title` record, then the `session` header,
  then tree entries: `model_change`, `thinking_level_change`, `message` (roles
  `user`, `developer`, `assistant`, and `toolResult`; usage, cost, provider, and
  model on assistant messages), `custom`, `compaction`, and others.
  `--resume <file>` appends to the same file.
- omp has no `registerMcpServer` extension API. `-e <directory>` makes the
  directory an extension root, and its `.mcp.json` registers the server under
  its own name. omp mounts MCP tools as `xd://mcp__<server>_<tool>` devices. The
  model calls one with `write`, path `xd://<tool>`, and the JSON arguments in
  `content`. The result `details.xdev` names the server, the tool, the arguments,
  and the server's own result. The reader shows such a call as
  `mcp__<server>__<tool>` with that result, so the Advisor report reader accepts
  it as it does for Pi.
- `--tools read,grep,glob` keeps `write` for devices only. A `write` to a file
  path fails with "limited to the xd:// device transport and local:// session
  scratch". omp has no `ls`, and `find` is not available in that session.
- `omp models --json` prints `{"models":[{"selector":"provider/id",...}]}` for
  the models with credentials, including `models.yml` providers, and
  `{"models":[]}` without credentials. It never prints a key. `omp login`
  signs in to a provider.
- `PI_CONFIG_DIR` (default `.omp`), `PI_CODING_AGENT_DIR` (default
  `~/.omp/agent`), `PI_CODING_AGENT_SESSION_DIR`, and `OMP_PROFILE` move omp
  state. Suplex sets none of them; `--session-dir` moves only the sessions.

## Sign-in probe

Settings runs `omp models --json` with the shared five-second probe. An empty
list is signed out, a listed model is signed in, and other output shows that omp
is present. As with every provider, a listing does not prove model access.

## Consequences

- omp sessions, tool evidence, usage, and Advisor reports read from the same
  code as Pi. A change to that code covers both CLIs.
- omp also mounts MCP servers that the user configured for omp itself, and a
  Coordinator or Advisor turn can call them as devices. `--tools` and
  `--no-extensions` do not remove them. Pi turns load only the Suplex bridge.
- If the private session directory loses its file, the next omp turn starts a
  new omp session.
