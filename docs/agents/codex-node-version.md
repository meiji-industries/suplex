# Codex Node version

This records a historical environment issue from the TypeScript backend.
The current Suplex server is a native binary; Node and pnpm remain build
and development tools.

## Symptom

Codex/Herdr pane commands selected Homebrew Node 25.8.1, causing the then-current Node-26-built `better-sqlite3` module to fail.

## Root cause and fix

Codex/Herdr can inherit an environment that never loaded `~/.zprofile`, where
`mise activate zsh --shims` was configured. Homebrew was therefore first on PATH.
`~/.zshenv` now prepends `~/.local/share/mise/shims`, so mise resolves the
directory-specific version from `mise.toml`.

This also means every non-interactive `node`, `pnpm`, or other mise-managed
command evaluates the repository's `mise.toml` before the command starts. In
Suplex, that evaluation runs `scripts/resolve-magicdns.sh` to populate
`SUPLEX_TAILSCALE_ADDRESS`. If Tailscale exits successfully but prints something
other than JSON, `jq` fails and the requested command never starts. This is a
local environment-rendering failure, not a TypeScript or test failure. To
diagnose the project independently, invoke the pinned Node binary directly;
fix the Tailscale/MagicDNS response before returning to the normal mise shim.

Git fixture tests have a separate inherited-state hazard: a global
`commit.gpgsign=true` applies inside temporary repositories unless the fixture
disables it. In a sandbox this can look like a product failure because GPG
cannot access `~/.gnupg`. For local diagnosis, `GIT_CONFIG_GLOBAL=/dev/null`
reproduces CI's clean global Git configuration without changing user settings.

## Verify

From the repository, run `zsh -c 'node --version'`. The pinned development version is in `mise.toml`.
