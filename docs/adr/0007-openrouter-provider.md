# ADR 0007: OpenRouter provider

## Decision

OpenRouter is a third agent provider. It uses omp (oh-my-pi) in the existing
Herdr substrate. The harness map is fixed: Codex uses Codex CLI, Claude uses
Claude Code CLI, and OpenRouter uses omp.

The OpenRouter API key is the only provider credential that the UI collects.
Forge stores it in `forge_provider_credentials` on the local host. Backups do
not include it. The API does not return it. Forge does not write it to prompts,
artifacts, pane text, or Temporal history. A pane reads it only from a 0600
environment file. A missing or invalid key fails the turn with an action
required message.
