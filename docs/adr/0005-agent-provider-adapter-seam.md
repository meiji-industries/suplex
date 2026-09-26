# 5. Agent-provider adapter seam

Date: 2026-08-12

## Status

Superseded by [ADR 0012](0012-providers-are-harnesses.md). The TypeScript
paths and single-provider implementation below record the original decision.

## Context

Suplex drives AI agents exclusively through the Codex CLI today, and Claude is
about to be added as a second provider. Codex facts — the `codex` command and
its `SUPLEX_CODEX_COMMAND`/PATH resolution, `exec`/`resume` argv construction,
JSONL event parsing and session-ref extraction, failure-classification
heuristics, the supervised-turn wrapper, and the version/auth/smoke readiness
probe — were spread across the Lead service, Developer service, health checks,
and support modules. Adding a provider would have meant touching all of them.

## Decision

Introduce one seam: `AgentProvider` (`src/agent-providers/provider.ts`), with
Codex as its first adapter (`src/agent-providers/codex.ts`) and a single
resolution point (`resolveAgentProvider()` in `src/agent-providers/index.ts`).
The seam sits at the process/session/parsing layer: command resolution, turn
argv, event/transcript parsing, line sanitization, failure classification,
session store, turn supervisor, supervised-turn wrapper, model-catalog
compatibility, and readiness probing. Prompts and output schemas stay
role-owned — the Lead and Developer services keep authoring their own prompts
and Zod contracts and speak only the neutral interface. Multi-provider routing
(config/profile-driven selection) is deliberately deferred until a second
adapter exists.

## Consequences

- Adding Claude means one new adapter file plus a registry entry; role
  services, health checks, and the turn wrapper machinery stay untouched.
- All codex-only modules now live under `src/agent-providers/`; old paths
  (`src/codex-turn.ts`, `src/codex-jsonl.ts`, `src/codex-turn-supervisor.ts`,
  `src/codex-turn-wrapper.ts`) are frozen one-line re-export shims, and
  `codex-lead-errors`/`codex-session-store`/`codex-lead-contracts` were
  renamed to neutral homes (`agent-failure`, `session-store`,
  `lead-contracts`) with shims, so every existing import keeps working.
- Persisted/wire values stay frozen: profile `provider: "codex"`, capacity
  lane keys `codex:<profile>`, the `codex-auth` health id, and the
  `SUPLEX_CODEX_*` env vars are contracts, not code seams; they remain
  literal (the env fallback now lives inside the codex adapter).
- Claude provider details are recorded in [ADR 0006](0006-claude-code-provider.md).
- `src/codex-lead.ts`/`src/codex-developer.ts` keep their historical file
  names to avoid churning ~15 import sites and test suites; renaming them is
  safe follow-up work once the conflict-hotspot refactor lands.
