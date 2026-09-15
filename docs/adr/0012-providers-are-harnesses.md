# 12. Providers are harnesses

Date: 2026-09-15

## Status

Accepted

Supersedes [7. OpenRouter provider](0007-openrouter-provider.md).

## Context

Forge runs four agent tools: OpenCode, Claude Code, Devin CLI, and Codex CLI.
Each is a separate executable with its own sign-in, session identity, evidence
format, and runtime in `src/runtimes`.

An agent profile's `provider` did not name one of those four. It carried an id
discovered from OpenCode — `openai`, `anthropic`, `github-copilot` — except for
three reserved strings that meant a CLI instead. `profileHarness` mapped that
mixed vocabulary back to a harness, treating every unrecognised value as
OpenCode. The provider page listed every OpenCode vendor as a peer of Claude
Code, and read OpenCode's `auth.json` to give each vendor row its own sign-in
state. Three vendor ids could never appear, because they collided with the
reserved CLI names.

The vendor was an OpenCode implementation detail that had leaked into Forge's
own vocabulary. Only OpenCode has vendors; the other three resolve a model name
against the account their CLI is signed into.

## Decision

A profile's `provider` is the harness kind, from a closed enum shared by the
whole codebase: `opencode`, `claude-code`, `devin`, `codex`
(`src/runtimes/harness-kind.ts`). The HTTP contracts, the agent profile schema,
the provider list, the model list, the provider instances, and the sign-in route
parameter all use that enum, so an unknown provider is rejected at the boundary
rather than silently routed to OpenCode.

An OpenCode model id is vendor-qualified: `openai/gpt-5.6-sol`. Forge stores,
lists, and displays that whole string. It splits the vendor off only where it
speaks to OpenCode — creating a session, writing the role config, and building a
recovery prompt intent — through `openCodeModel`, which throws when the id is
not qualified. OpenCode's prompt intent keeps its own `{ providerID, modelID }`
vocabulary; that `providerID` is the vendor, not the harness.

`TaskUsage.provider` stays the pricing vendor, because it keys the models.dev
price catalog. OpenCode records its native vendor id. Claude Code records
`anthropic` and Codex now records `openai` rather than `codex`, which had no
listed prices.

Stored task, session, and trigger profile snapshots were written before this
change, so `TaskProfileSchema` is a `z.preprocess` that rewrites a provider
outside the enum into `opencode` with the vendor moved onto the model. Every
site that parses a stored snapshot gets the upgrade for free. The raw object
schema, `TaskProfileFieldsSchema`, is what response contracts and the agent
profile schema build on, because a Fastify response serializer cannot encode
through a unidirectional transform.

The migration converts existing rows the same way. It also re-seeds
`profile_native_root` and `profile_native_worker` to Codex CLI GPT-5.6 Sol and
GPT-5.6 Luna, but only when `forge_tasks` is empty. A fresh install has no
tasks, so it gets the Codex defaults; an installation with history keeps the
OpenCode profiles its tasks already reference.

## Consequences

The providers page has four rows. OpenCode's vendors appear inside its row as
qualified model ids labelled with their vendor, and its sign-in is the shared
OpenCode readiness check. The per-vendor detail that `auth.json` gave — this
installation has an OpenAI credential but no Anthropic one — is gone. It was
reported per vendor row, and there is no longer a vendor row to report it on.

Health checks probe OpenCode, Claude Code, and Codex CLI, so a fresh install
with Codex defaults reports its provider readiness like any other.

ADR 0007 described a provider as a model vendor reached through a fixed
harness map. That mapping is now the identity function, so the ADR no longer
describes the system.
