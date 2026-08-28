# Codex Node version

## Symptom

Codex/Herdr pane commands selected Homebrew Node 25.8.1, causing the Node-26-built
`better-sqlite3` module to fail.

## Root cause and fix

Codex/Herdr can inherit an environment that never loaded `~/.zprofile`, where
`mise activate zsh --shims` was configured. Homebrew was therefore first on PATH.
`~/.zshenv` now prepends `~/.local/share/mise/shims`, so mise resolves the
directory-specific version from `mise.toml`.

## Verify

From the repository, run `zsh -c 'node --version'` or:
`codex exec -C /Users/dev/code/forge -- 'Run: node --version && node -e "require(\"better-sqlite3\")"'`.
Expected Node version: `v26.7.0`.
