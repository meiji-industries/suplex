# 11. Codex CLI provider

Date: 2026-09-15

## Status

Accepted

## Context

Forge needs a fourth local agent provider. OpenAI's Codex CLI publishes a
documented JSONL event stream for non-interactive runs, so Forge can read native
tool, token, and result evidence instead of parsing terminal output. Tests
against codex-cli 0.154.0 establish the flags, the event shape, and the thread
identity that Forge stores.

## Decision

Forge resolves `codex` on `PATH`, then `~/.local/bin/codex` or
`~/.codex/bin/codex`. `FORGE_CODEX_COMMAND` pins an absolute executable path.
The install command is `npm install -g @openai/codex`. Forge lists Codex CLI in
its provider catalog before it is installed and reports whether the executable
is available on the host. Codex has no model listing command, so Forge carries a
static alias list.

Each turn runs one detached headless process:

```sh
codex exec [resume <thread-id>] --json --skip-git-repo-check \
  -m <model> \
  -c model_reasoning_effort="<effort>" \
  -c approval_policy="never" \
  -c sandbox_mode="<read-only | danger-full-access>" \
  [-c mcp_servers.<forge_root|forge_advisor>={command="…",args=[…],env_vars=[…],default_tools_approval_mode="approve"}] \
  -
```

Every policy is a `-c` config override rather than a flag because
`codex exec resume` accepts no `-s/--sandbox`, `-C/--cd`, or `--add-dir`; only
`-c`, `-m`, `--json`, and `--skip-git-repo-check` appear on both invocation
forms. A `-c` value parses as TOML, and CLI overrides outrank a checked-out
project's `.codex/config.toml`, so a repository cannot weaken them.

Workers get `sandbox_mode="danger-full-access"`, matching Claude Code's
`--dangerously-skip-permissions`; the worktree is the isolation boundary.
Coordinator and Advisor sessions get `read-only`. `approval_policy="never"`
keeps every turn non-interactive. The trailing `-` makes Codex read the prompt
from standard input, which is the private per-turn prompt file Forge already
writes; Codex exposes no system-prompt flag, so Forge prepends the role prompt
to that file.

Task bridges are passed as one `mcp_servers.<name>` inline TOML table built from
the same command and arguments Claude Code writes into `mcp.json`. The table
carries no values: `env_vars` lists the variable *names*, which Codex forwards
to the server from its own environment, and Forge puts the binding paths and
bridge tokens in the environment of the `codex` process itself. No secret
reaches the command line, `ps`, or the argv recorded in the turn record. The
table also sets `default_tools_approval_mode="approve"`, because Codex asks
for per-tool approval on MCP calls by default and a headless turn has nobody to
answer; a live turn against codex-cli 0.154.0 without it failed the bridge call
with "MCP tool call requires approval, but approval policy is never". Forge
writes no project-local Codex configuration file, so there is no
`.git/info/exclude` handling and no shared-worktree merge between concurrent
Coordinator and Advisor sessions. A small TOML string quoter escapes the names,
so no override can contain a newline. Overrides supplied this way do not replace
the user's own `config.toml` MCP servers, which still load.

Codex thread ids are UUIDs, which collide with the heuristic that routes a bare
UUID to Claude Code. Forge therefore mints `codex-<uuid>` as the routing
identity and records the real thread id from the first `thread.started` event in
`<runtime>/session.json`. Later turns resume with `exec resume <thread-id>`. A
lost or corrupted record is rebuilt from the newest turn log that announced a
thread. When a resume fails because the thread is gone — its rollout pruned, or
`CODEX_HOME` moved — Forge drops the record and records the id as dead, so the
next turn starts a fresh thread instead of failing forever. Any other startup
failure keeps the record, because starting over would silently abandon the
conversation.

The turn log is authoritative for evidence. `turn.completed` completes the turn
and carries `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`,
`output_tokens`, and `reasoning_output_tokens`. `input_tokens` is inclusive of
both cache figures and `output_tokens` of the reasoning figure, so Forge
subtracts them to get the fresh input and visible output slices rather than
double-counting. `turn.failed` and a top-level `error` are native errors.
The last `item.completed` carrying an `agent_message` is the result text, and
`command_execution`, `file_change`, `mcp_tool_call`, and `web_search` items are
tool evidence. An item type a later Codex release adds is carried, not rejected.

Interactive sign-in is `codex login`, not `codex auth login`.
`codex login status` prints `Logged in using …` and exits 0, or reports that no
credentials exist.

## Consequences

Unlike Claude Code, Coordinator and Advisor Codex turns have a shell and the
user's own MCP servers; they are bounded by the read-only sandbox and by the git
command guard, which every role gets, because Codex has no tool allowlist flag.

Codex turns have the same durable claim, process ownership, recovery, stop,
result, and log evidence lifecycle as the other detached headless CLIs. The same
`/bin/sh` wrapper records each exit status in Forge's private turn directory; it
is not a Codex CLI flag.

Unlike Devin, Codex reports native tool and token detail, so the task detail view
and analytics read real evidence rather than a limitation notice. Advisor
`submit_report` needs no separate capture file: the bridge call appears in the
turn log as an `mcp_tool_call` item named `mcp__forge_advisor__submit_report`,
which the existing report reader already accepts.

The Herdr display runs a Forge output viewer, not Codex. It reads only the
private per-turn event and stderr files, renders each event as a line, follows
appends, and discovers later turns without reopening the pane. It does not
invoke Codex, read a bridge binding, or own execution, so closing it does not
stop a turn.

`codex exec` never shows the interactive trust prompt, and
`--skip-git-repo-check` lets a non-Git directory run. Health-check probing,
`CODEX_HOME` provider instances, and `--output-last-message` are all omitted:
the first matches Devin, the second waits for a second OpenAI login to be
needed, and the third is redundant with the event stream.
