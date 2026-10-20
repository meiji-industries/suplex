# 14. Pi CLI provider

This decision records dated provider probes. Consult the [product guide](../product.md)
for current claims and the [Pi runtime](../../apps/server/src/runtimes/pi/) for the
implemented invocation and recovery behavior. Probe results are not a current
release or account verification.

Date: 2026-10-20

## Status

Accepted

## Context

Suplex needs a fifth local agent provider. Pi (`pi`, from
`@earendil-works/pi-coding-agent`) runs one prompt per process and writes a
documented JSONL event stream, so Suplex can read native tool, token, and
result evidence as it does for Codex CLI. Pi also reaches local
OpenAI-compatible servers, such as llama-server, MLX, or Ollama, through its own
`models.json`. Probes against Pi 1.3.0, installed with
`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, establish the
flags, the event and session shapes, the bridge mechanism, and the sign-in
probe. A local fake OpenAI-compatible server stood in for a model provider.

## Decision

Suplex resolves `pi` on `PATH`, then `/opt/homebrew/bin/pi`,
`/usr/local/bin/pi`, `~/.local/bin/pi`, `~/.pi/agent/bin/pi`, or `~/bin/pi`.
These are the places the pi.dev installer and `npm install -g` use.
`SUPLEX_PI_COMMAND` pins an absolute executable path. The install command is
`curl -fsSL https://pi.dev/install.sh | sh`. Like `codex`, the npm `pi` is a
Node script, so the Suplex process `PATH` must reach `node`.

Each turn runs one detached headless process:

```sh
pi --mode json --model <provider>/<id> --thinking <level> \
  --session-dir <runtime>/pi-sessions --session-id <native session id> \
  [--tools read,grep,find,ls,mcp__<suplex_root|suplex_advisor>__* -e <runtime>/suplex-bridge.ts]
```

`--mode json` writes JSONL events to standard output and exits after the
prompt settles. With no message argument, Pi reads the prompt from standard
input, which is the private per-turn prompt file Suplex already writes, so the
prompt never reaches argv. Suplex prepends the role prompt to that file, as for
Codex, instead of passing `--append-system-prompt`. Pi still loads `AGENTS.md`
itself; `--no-context-files` is not passed, because Codex also reads it.

The profile reasoning level maps one to one onto `--thinking` (`low`, `medium`,
`high`, `xhigh`, `max`); Pi clamps it to what the model supports. The profile
model is passed as is, so a `models.json` entry such as `llama-server/qwen3`
runs with no extra Suplex configuration.

Suplex mints `pi-<uuid>` as the native session id. The id routes the session
back to the Pi harness and is a valid Pi session id. Every turn passes the same
`--session-id` and `--session-dir`. The first turn prints
"No project session found with id …; creating a new session" to stderr and
creates `<runtime>/pi-sessions/<timestamp>_<id>.jsonl`; later turns append to
that file and resume the conversation. There is no thread mapping to persist
or recover, and the user's `~/.pi/agent/sessions` is not touched.

Coordinator and Advisor turns get `--tools read,grep,find,ls,mcp__<bridge>__*`:
Pi's read-only built-in tools and their own bridge, without `bash`, `edit`, or
`write`. An entry that starts with `mcp__` makes `--tools` filter MCP tools too,
so the user's other MCP servers are not declared to these roles. Workers keep
Pi's default `read,bash,edit,write` and the user's MCP servers, matching Codex
CLI's Worker. Every role gets the Git command guard.

The bridge is an extension file, `<runtime>/suplex-bridge.ts`, that Suplex
writes with mode 0600 for each Coordinator and Advisor turn and loads with `-e`.
It calls `pi.registerMcpServer("suplex_root" | "suplex_advisor", …)` with the
same `suplex mcp root` or `suplex mcp advisor` command as Codex, `exposure`
`direct` so the tools are declared to the model, and a 3600 second request
timeout, because delivery calls can outlast Pi's 60 second default. The file
holds no secret: `env` names `SUPLEX_ROOT_BINDING`, `SUPLEX_ROOT_TOKEN`, and
`SUPLEX_GIT_REAL_BIN`, or the three Advisor variables, as `${NAME}`
references. Suplex puts the values in the environment of the `pi` process,
which Pi passes to the stdio server. A probe confirmed that the child receives
those values and that an Advisor turn against the real `suplex mcp advisor`
called `mcp__suplex_advisor__submit_report` and captured the report.

Two other mechanisms were rejected. `~/.pi/agent/mcp.json` belongs to the user.
A project `.pi/mcp.json` is read only after project trust. In `--mode json`, an
untrusted project's `.pi` files are skipped without a prompt; trust can be
granted only per run with `--approve`, which would also load the repository's
own `.pi` extensions. Explicit `-e` paths load without project trust, and
Suplex does not pass `--no-extensions`, so the user's provider extensions still
load.

## Evidence

The per-turn log `turn-<id>.jsonl` is Pi's standard output. Its first record is
the session header `{"type":"session","version":3,"id":…,"cwd":…}`. Then come
`agent_start`, `turn_start`, `message_start`, `message_update`, and
`message_end`, `tool_execution_start`, `tool_execution_update`, and
`tool_execution_end` (`toolCallId`, `toolName`, `args`, `result`, `isError`,
`durationMs`), `turn_end`, `agent_end` (`willRetry`), and
`agent_settled` (`aborted`).

- A failed response still ends with `agent_end` and `agent_settled`, and the
  process exits 0. The final assistant `message_end` has `stopReason: "error"`
  and `errorMessage`. Observation therefore reads that native error before
  completion. `auto_retry_end` with `success: false` is a native error too.
- `agent_settled`, or an `agent_end` that will not retry, completes the turn.
  An aborted settle is an interruption. A `tool_execution_start` without its
  end after the process stopped is an unsettled tool.
- The result text is the text of the last assistant `message_end`.
- Tool evidence is the execution events. For an MCP tool, the turn log's
  `result.structuredContent` holds the whole MCP `CallToolResult`, which is
  what the Advisor report reader accepts.
- Usage comes from each assistant `message_end`: `input` excludes cache reads,
  and `reasoning` is a subset of `output`. Suplex maps `input`, `cacheRead`,
  `cacheWrite`, and `output` minus `reasoning`, and keeps `reasoning`
  separately. A turn is the sum of its responses. Cost is Pi's own
  `usage.cost.total` from its model pricing when it is above zero, else the
  Suplex pricing catalog under `<provider>/<model>`. The usage provider is the
  assistant message's native `provider` field.

The session file is the conversation. Entries have `type`, `id`, `parentId`,
and `timestamp`; `message` entries hold a `user`, `assistant`, or `toolResult`
message. Assistant content blocks are `text`, `thinking`, and `toolCall`, and a
`toolResult` message settles the call with the same `toolCallId`. Live history
and reasoning read the assistant messages and their thinking blocks from this
file. A file that does not exist yet is an empty history.

## Sign-in probe

Pi has no sign-in status command. `pi auth check` needs a provider name, and
credentials can come from `auth.json`, `models.json`, or provider environment
variables. Suplex runs `pi --offline --list-models`, which exits 0 in either
case. It prints a table of the models whose provider has credentials,
including `models.json` providers, or "No models available. Use /login …".
A table is signed in, the message is signed out, and anything else is unknown.
The probe never reads `auth.json` and never shows a credential. The provider
catalog reads the same listing, so each row becomes a `provider/id` model. A
small static list covers a host where the listing is unavailable.

`pi "/login"` treats `/login` as a prompt, so the sign-in pane runs `pi`, and
the person types `/login` in it.

## Consequences

Pi turns have the same durable claim, process ownership, recovery, stop, result,
and log evidence lifecycle as the other detached headless CLIs.

The Herdr display runs `suplex pi-display <runtime>`, which uses the Codex
display loop with a Pi event renderer. It reads only the per-turn event and
stderr files, does not invoke Pi, and does not own execution.

Moves still run only Claude Code and Codex.

Not verified on this host: a paid model provider, OAuth `/login`, the
pi.dev installer, and a Coordinator turn against the real `suplex mcp root`,
which needs a task database. The Root bridge uses the same extension mechanism
as the verified Advisor bridge.
