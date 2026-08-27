# 6. Claude Code provider

Date: 2026-08-27

## Status

Accepted

## Context

Planner and Reviewer need access to Claude Fable alongside Codex.

## Decision

A profile selects `codex` or `claude`. Both use the same Herdr session and turn
substrate. Forge pre-assigns Claude session IDs and launches Claude with bypass
permissions. The historical `codex_session_id` column stores either provider's
session ID.

## Consequences

Capacity lane keys and `FORGE_CODEX_*` remain unchanged. The `codex-auth` check
remains; `claude-auth` is added. Claude profiles require the local Claude login.
