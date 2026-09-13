# 8. Devin CLI provider

Date: 2026-09-12

## Status

Accepted

## Context

Forge needs a third local agent provider without treating undocumented terminal
output as an API. `devin` was not installed on the Forge host when this decision
was recorded, so the contract below is from Cognition's published reference.

## Decision

Forge resolves `devin` on `PATH`, then `~/.local/bin/devin` or
`~/.devin/bin/devin`. `FORGE_DEVIN_COMMAND` pins an absolute executable path.
The install command is `curl -fsSL https://cli.devin.ai/install.sh | bash`.
Forge lists Devin CLI in its provider catalog before it is installed and reports
whether the executable is available on the host.

The first Worker turn uses the documented headless invocation:

```sh
devin --print --prompt-file <file> --model <model> \
  --permission-mode dangerous --respect-workspace-trust false
```

The flags are documented in Cognition's [Commands & Flags](https://docs.devin.ai/cli/reference/commands): `--print` exits after the response,
`--resume` resumes a specific existing session, `--prompt-file` loads the prompt,
`--model` chooses a model, `--permission-mode` controls approval, and
`--respect-workspace-trust false` makes non-interactive execution possible in
an untrusted workspace. Devin documents model aliases such as `swe`, `opus`,
and `gpt` at [Models](https://docs.devin.ai/cli/models).

`--print` has no documented JSON/event output, session-create response, token
usage output, or transcript location. After its first completed turn Forge runs
the documented `devin list --format json` in the worktree and persists the
newest returned session id in its private `session.json`; later turns add
`--resume <session-id>`. Forge parses final text from its immutable per-turn
stdout log, uses a separate `devin-<uuid>` identity only for harness routing,
and reports unavailable tool/token detail honestly. The documented `--export`
writes ATIF after each turn, but its schema and default location are not
documented, so Forge does not parse it.

Forge passes no `--config`: while the command reference documents that flag, it
does not document a config-file shape or a `subagents_enabled` key. This avoids
inventing a configuration contract. Forge prepends the role prompt to each
documented `--prompt-file` instead.

The command reference documents MCP as persistent `devin mcp add` configuration,
not a per-invocation MCP config flag. Forge rejects Coordinator and Advisor
roles for Devin because it cannot safely bind their bridges for one task.

## Consequences

Devin Worker turns have the same durable claim, process ownership, recovery,
stop, result, and log evidence lifecycle as other detached headless CLIs. A
small `/bin/sh` wrapper records each CLI exit status in Forge's private turn
directory; it is not a Devin CLI flag or part of the native CLI contract.
Interactive display attachment and native tool/usage detail are unavailable
until Cognition documents a stable machine-readable contract.
