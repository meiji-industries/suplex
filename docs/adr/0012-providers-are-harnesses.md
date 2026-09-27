# ADR 0012: Providers are agent tools

Status: accepted. Decision made 2026-09-15; source references updated 2026-09-27.
Supersedes the OpenRouter provider decision, ADR 0007 (available in Git history).

## Decision

A profile's provider names the tool that runs a turn: `opencode`, `claude-code`,
`devin`, or `codex`. Each owns its executable, sign-in, native session identity,
and result format. The [runtime registry](../../rust/src/runtimes/task_harness_registry.rs)
selects the implementation.

OpenCode model IDs include their vendor, such as `openai/gpt-5.6-sol`. That
vendor is not another Suplex runtime. The other tools use their own model IDs.
Usage pricing may name a model vendor independently of the profile's provider.

## Reason

Mixing vendors and executable names in one provider field made authentication
and routing ambiguous. A profile now selects one agent tool; its runtime handles
the tool's model naming and native protocol.

Executable discovery and sign-in are separate from successful model inference.
The [product guide](../product.md) states the supported product claims and limits.
Original TypeScript migration details and the superseded OpenRouter adapter
proposal are available in Git history.

## Historical context

At the time of the decision, the profile field mixed OpenCode vendor IDs with
CLI tool names. Unknown values fell back to OpenCode, and some vendor names
collided with reserved CLI names. The decision made provider a closed tool
vocabulary at HTTP and stored-profile boundaries; OpenCode kept its vendor in
a qualified model ID. This removed separate sign-in rows for each OpenCode
vendor. Tool readiness no longer showed which individual OpenCode vendors had
credentials.

The TypeScript migration rewrote old profile snapshots and existing database
rows. It changed fresh-install defaults only where no tasks existed, preserving
profiles referenced by task history. Those migration mechanics explain the
original compatibility choice; they are not a current Rust migration procedure.
