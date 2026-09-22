# 8. Devin CLI provider

Date: 2026-09-12

## Status

Accepted

## Context

Suplex needs a third local agent provider without treating terminal output as an
API. Cognition's published reference defines the CLI and local MCP configuration
contracts. Tests against Devin 3000.10.21 also establish the ATIF export fields
that Suplex uses for native session identity.

## Decision

Suplex resolves `devin` on `PATH`, then `~/.local/bin/devin` or
`~/.devin/bin/devin`. `SUPLEX_DEVIN_COMMAND` pins an absolute executable path.
The install command is `curl -fsSL https://cli.devin.ai/install.sh | bash`.
Suplex lists Devin CLI in its provider catalog before it is installed and reports
whether the executable is available on the host.

The first turn uses the documented headless invocation:

```sh
devin --print --prompt-file <file> --export <private-file> --model <model> \
  --permission-mode dangerous --respect-workspace-trust false
```

The flags are documented in Cognition's [Commands & Flags](https://docs.devin.ai/cli/reference/commands): `--print` exits after the response,
`--resume` resumes a specific existing session, `--prompt-file` loads the prompt,
`--model` chooses a model, `--permission-mode` controls approval, and
`--respect-workspace-trust false` makes non-interactive execution possible in
an untrusted workspace. Devin documents model aliases such as `swe`, `opus`,
and `gpt` at [Models](https://docs.devin.ai/cli/models).

`--print` has no documented event stream, token usage output, or transcript
location. Each headless invocation writes `--export` to a private file in its
session runtime directory. Devin 3000.10.21 writes ATIF-v1.7 with a
`session_id` that matches the resumable session slug. Suplex validates only that
field. Later turns add `--resume <session-id>`. Suplex never uses the
directory-wide order from `devin list` to adopt a session. If `session.json` is
missing, Suplex rebuilds it from the current turn export or an old warm-up export
created by a prior Suplex version.
The export remains the authoritative identity record.

Suplex parses final text from its immutable per-turn stdout log and uses a
separate `devin-<uuid>` identity for harness routing. Devin tool and token detail
remain unavailable. Advisor `submit_report` is an exception because Suplex owns
that bridge call. The authenticated bridge atomically records the latest valid
submission at the current assignment turn's private evidence path. Invalid
submissions and display processes cannot replace that file.

Suplex passes no `--config` because the installed CLI states that this flag
overrides the default user config. Suplex keeps the user's settings intact and
adds only task bridge configuration through the project-local MCP file. Suplex
prepends the role prompt to each documented `--prompt-file`.

Cognition documents the project-local MCP configuration shape in
[MCP configuration](https://docs.devin.ai/cli/extensibility/mcp/overview).
Suplex writes `.devin/mcp_config.local.json` with invariant `suplex_root` and
`suplex_advisor` server entries. Tests against Devin 3000.10.21 confirm
`${VAR}` interpolation in MCP environment fields. This installed CLI probe is
also the source for the ATIF-v1.7 export behavior described above.
Every bridge process, on every provider, reads its binding path and token from
environment variables; there is no command-line binding flag. Bridge configuration carries Suplex's resolved GitHub CLI path as SUPLEX_GH_COMMAND. The shared Git
`info/exclude` ignores this local config path and its pending sibling file. Config repair
preserves unrelated MCP entries and writes both Suplex entries, so Coordinator
and multiple Advisor sessions can share one worktree without a last-writer-wins
binding path.

Each invocation removes inherited Suplex binding, token, and Advisor result
variables before it adds the current role's credentials. Worker and display
processes receive no Advisor result path. Coordinator and Advisor
bridge processes validate the token before MCP initialization. The Coordinator
bridge also validates it before opening the Suplex database. Existing
per-request Coordinator identity checks remain the authoritative task and
generation check.

## Consequences

Devin turns have the same durable claim, process ownership, recovery,
stop, result, and log evidence lifecycle as other detached headless CLIs. A
small `/bin/sh` wrapper records each CLI exit status in Suplex's private turn
directory; it is not a Devin CLI flag or part of the native CLI contract.
Tests against Devin 3000.10.21 found that both interactive `--resume` and
headless `--print --resume` exclusively own the native session. A headless turn
fails to start while an interactive display owns the same session. Closing only
the interactive process lets the same headless command succeed.

The Herdr display therefore runs a Suplex output viewer. The viewer reads only
the private per-turn stdout and stderr files. It prints existing output, follows
appends, and discovers later turns without reopening the pane. Before output
exists, it prints a short waiting label. The runtime directory identifies the
viewer and lets Suplex distinguish displays for different tasks. The viewer does
not invoke Devin, open an exported transcript, read a bridge binding, or own
execution. Closing the viewer does not stop a turn.

Suplex rejected serial interactive and headless ownership because that design
would make execution depend on the optional pane lifetime and recreate the
attach and dispatch race. Native tool and usage detail remains unavailable
until Cognition documents a stable machine-readable contract.

The bridge token is a soft same-user boundary. File permissions and private
runtime directories prevent accidental cross-session use, but they do not
isolate processes that already run as the same operating-system user. Suplex's
owner-controlled pilot trust model still applies.
