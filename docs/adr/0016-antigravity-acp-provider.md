# 16. Antigravity ACP provider

This decision records the Antigravity CLI contract as published on 2026-11-23.
Consult the [product guide](../product.md) for current claims and the
[Antigravity runtime](../../apps/server/src/runtimes/antigravity/) for the
implemented invocation and recovery behavior.

Date: 2026-11-23

## Status

Accepted

## Context

Google Antigravity ships a CLI, `agy`. `agy acp` is Google's official Agent
Client Protocol (ACP) agent: JSON-RPC 2.0 over stdin and stdout, protocol
version 1. Suplex needs Antigravity as a seventh local agent provider for the
Coordinator, Worker, and Advisor roles.

No `agy` binary was available on the build host, so the contract comes from
these sources:

- Antigravity docs: "Getting started", "CLI reference", and "Agent Client
  Protocol (ACP)". They give the installer
  (`curl -fsSL https://antigravity.google/cli/install.sh | bash`, which writes
  `~/.local/bin/agy`), `agy --version`, `agy acp`, `agy acp --login` (a sign-in
  by a pasted code that works without a browser), the auth method ids
  (`oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`),
  `Authentication required` as error `-32000`, session load and resume (a
  resume does not replay history), the Model and Thinking level session options
  (Low, Medium, High, Extra, Max), `--process-per-session` for HTTP MCP servers,
  and the print-mode flags `-p`, `-i`, `--model`, `--effort`, and `--mode plan`.
- t3code (`pingdotgg/t3code`), `docs/user/providers-antigravity.md` and
  `apps/server/src/provider/acp/`. It gives runtime 1.5 as the minimum
  (1.5.12 recommended), the `model` option id and the `thought_level` option
  category set with `session/set_config_option`, the line that `agy acp` prints
  when a browser sign-in starts, the 1.5 "No browser is available here" error,
  and that Antigravity cannot rewind a conversation.

[`runtimes/antigravity/cli.rs`](../../apps/server/src/runtimes/antigravity/cli.rs)
holds this contract in one place so a correction changes one file.

## Decision

Each turn is a headless process, `suplex antigravity-turn`, started through the
shared headless runtime like the Pi and Codex turns. It is the ACP client. It
reads the prompt on standard input, starts `agy acp` in the worktree, and
writes a turn log to standard output:

1. `initialize` with protocol version 1 and no client file or terminal
   capabilities, so the agent uses its own tools.
2. `session/new` on the first turn. A later turn resumes with `session/resume`,
   or `session/load` when the agent offers only that (its replayed updates are
   not logged). The resumed native session id comes from the latest turn log,
   which records the agent's answer, so no separate cache decides it. If the
   agent no longer has the session, the turn starts a new one and logs
   `resume_failed`, so work continues.
3. On `Authentication required`, one `authenticate` with `gemini-api-key` when
   `GEMINI_API_KEY` is set, `agent-platform` when `GOOGLE_CLOUD_PROJECT` is set,
   else `oauth-personal`. `BROWSER=false` keeps a sign-in from opening a window
   on the host; a printed sign-in link ends the turn with "Antigravity is not
   signed in" and the `agy acp --login` remedy.
4. `session/set_config_option` for the profile model and for the thinking level
   that matches the Suplex reasoning level (`xhigh` is Extra). The model
   `default` keeps the account's model. A model that the account does not list
   fails the turn before the prompt.
5. `session/prompt`, then a wait for commands that the agent keeps running
   after its prompt ends, and for the reply it sends when they end (up to 30
   minutes). Daemon commands are not awaited.

The session id is `antigravity-<uuid>`. The registry routes this prefix to the
runtime, and an `antigravity` profile never falls back to OpenCode.

Antigravity asks the client before it acts. The client answers each
`session/request_permission` by role, as the Pi read-only tools do: a Worker
may do what it asks; a Coordinator or Advisor may read, search, think, fetch,
call its own Suplex bridge, and call the project MCP tools that the project
grants its role. Other requests are rejected. A native question
(`interaction_…`) is cancelled because no one is there to answer it.

The Coordinator and Advisor bridges and the granted project MCP servers go to
`session/new` and `session/resume` as ACP `mcpServers`. The private
`antigravity-mcp.json` names the bridge variables, and the client copies their
values from its environment, so the file holds no bridge token. The Worker runs
with the Git guard on `PATH`.

The reader takes history, reasoning, tool evidence, and usage from the turn
logs, which hold the agent's own `session/update` payloads. An MCP call reads
as `mcp__<server>__<tool>` with its `CallToolResult`, so Advisor reports and
`read_worker_evidence` work as for the other runtimes. Observation, stop, and
recovery use the shared headless process record and the turn log. `suplex
antigravity-display` follows the turn logs in Herdr.

Settings and System health start `agy acp`, read the version from
`initialize`, and open one session to learn the sign-in state and the account
models. No prompt is sent. One result serves callers for two minutes. Before a
probe, Settings lists a static fallback. A version older than 1.5 shows as
unhealthy with the install command. It does not block a turn. `suplex
antigravity-probe` prints the probe, and the VM bootstrap uses it as its
sign-in check. Sign-in runs `agy acp --login`.

Moves run `agy --model <model> --effort <level> -i <prompt>` in a terminal, and
recommendations run `agy --mode plan -p` with the model and effort.

## Consequences

- Antigravity cannot rewind its conversation; Suplex never asks it to.
- The role policy applies to the requests Antigravity sends. An action that the
  user's own Antigravity permission rules already allow runs without a request.
- Session history is what the agent reported to Suplex. Turns that another
  client ran in the same native session do not appear.
- A dedicated provider instance home is not supported, as for Pi, OMP, and
  Codex. `agy` uses the sign-in of the OS user that runs Suplex.
- Usage shows the token counts that `session/prompt` reports. If a runtime does
  not report them, the turn has no token counts.
- Each probe opens an Antigravity session in a Suplex temporary directory, and
  Antigravity can list it as a conversation.
- Not verified against a live `agy`: the flags and option names above, the
  permission request shapes, MCP delivery, resume, and the probe. The
  automated tests use a fake ACP agent
  ([fixture](../../apps/server/src/runtimes/antigravity/fixtures/fake-agy.mjs))
  that follows the sources above. Run one real turn and correct `cli.rs` if the
  binary differs.
