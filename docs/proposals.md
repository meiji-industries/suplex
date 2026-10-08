# Unimplemented design ideas

For maintainers revisiting unfinished work, this page preserves the problems,
design choices, and tradeoffs from superseded plans. These are proposals, not
shipped capabilities or approved requirements. The [product guide](product.md)
owns product claims. [Architecture coverage](architecture/coverage.md) identifies
the historical sources; [unresolved work](architecture/unknowns.md) lists specific
verification gaps and other ideas.

The relevant implementation anchors are [prompt composition](../apps/server/src/coordination/root_prompts.rs),
[workflow policy](../apps/server/src/coordination/workflows.rs),
[GitHub triggers](../apps/server/src/integrations/github_triggers.rs), and
[native session history](../apps/web/features/tasks/task-chat/session-history.tsx).

## Editable prompt guidance

**Problem.** Project teams may need to adjust agent guidance without changing Suplex source. The old layered plan proposed system defaults, instance-wide guidance, then project guidance. At each layer an operator could inherit, append, or replace editable guidance. A separate contract section held output shape, ownership, tool, and credential rules and would always be supplied by Suplex. Running tasks would retain the resolved prompt selected at task creation, and a task view would show provenance so an operator could explain which revision influenced a turn.

**Requirements to reconsider against current Rust code.** Define which prompt fragments are safely editable and which must remain owned by Suplex. Resolve settings deterministically for a new task, retain revision history and actor attribution, validate placeholders and forbidden contract syntax at the save boundary, and make stale replacements and removed templates visible. Preserve previously selected guidance for active work if that is the current task-setting model. Reuse current project authorization rather than inventing another role. The old plan's `inherit` rows, append-only rollback revisions, orphan visibility, and provenance answer real operational questions; its specific SQL schema and `task-prompt-set` artifact do not bind a new design.

**Tradeoffs and decisions.** A global layer reduces repetition but can affect every project. Replacing guidance can hide later improvements to system text; an explicit stale warning and comparison are useful. The plan itself left repository-file overrides versus Settings ownership unresolved and recognized that an editable PR body would be inert until its publisher used the template. These must be settled from current product behavior. `root_prompts.rs` currently composes bundled prompt text; the deleted override service and Settings routes are not present in current Rust code. This remains a proposal.

**Do not import as gates.** Structural validation and authorization protect a trust boundary. The plan's blanket refusal to create a task when override storage is unavailable is not automatically a product requirement; evaluate the concrete harm and available persisted task intent first. The old hash/provenance format must not become a second receipt required to accept native execution.

## Prompt quality evaluation

**Problem.** A structurally valid prompt can still produce vague reviews, no-op repairs, inflated materiality, or a PR description with no useful test plan. The evaluation plan proposed six scrubbed regression cases, production-equivalent rendering, deterministic rubrics, an optional provider-backed comparison of current and draft guidance, and redacted reports containing model, usage, estimated cost, corpus identity, and concrete failures. The cases targeted branch-state awareness, exact findings, action-producing repair steps, realistic PR testing, and schema validity. Its prompt critique is still a useful checklist: plan only the remaining delta; name the path/artifact that supports a finding; map each repair finding to an edit or exact already-satisfied proof; describe what a verification command actually showed.

**Requirements to reconsider.** Keep evaluation off the task execution path. Use synthetic or scrubbed fixtures, no private transcripts or credentials, and an isolated read-only provider invocation if model calls are needed. Let deterministic checks run without credentials. Show unknown cost as unknown and distinguish model/provider failure from a quality score. Compare candidate and baseline on the same corpus and preserve enough provenance to reproduce a result. Add a real provider run only when an explicit operator workflow justifies its cost.

**Tradeoffs and rejected enforcement.** The old plan chose seven covered templates, a score of at least 0.8, no regression, all hard rubrics, a 30-minute HMAC receipt, and a save-time gate when `SUPLEX_EVAL=1`. That is a dated policy for a retired prompt service, not a current requirement. A small corpus may overfit or punish a useful change; model scores and prices drift. A preview and report can aid a decision without blocking an operator's prompt edit. The old proposal exempted rollback because recovery during a provider outage matters. The evaluation report is advisory; it is not a delivery prerequisite.

## Task conversation

**Problem.** The old task page split member decisions, agent turns, tool progress, and pull request state across separate views. The task-chat plan proposed one chronological conversation: original brief, member notes and decisions, each agent turn, selected lifecycle milestones, and the PR card. A running turn would show new events; a completed turn would collapse to elapsed time and known file-change counts, with command and file details on expansion. Raw stdout stayed out of the summary. The Activity view would remain the terse audit feed.

**Requirements to reconsider.** Build any combined view from authoritative task intent and native provider history, preserving event identity/order across reconnect and restart. Make unknown duration or file counts absent rather than zero. Support reading long history, following new output, and holding scroll position while an operator reads earlier events. Keep a clear boundary between a message the user sent and a provider event Suplex merely observed. The old composer sent Planner notes only; extending user steering to other roles was explicitly out of scope. Current `session-history.tsx` already reads native messages and live updates, so first evaluate whether one thin task-level composition is needed before adding another transcript store or stream.

**Tradeoffs.** One transcript reduces navigation but can bury decisions under tool noise. Collapse routine events and retain the Activity view. A unified view may have gaps when a provider cannot supply a native event, which should be shown as a gap rather than invented continuity. Do not make UI feed completeness a task or archive gate.

## Parallel implementations and triggers

**Parallel implementation idea.** The old fan-out proposal let one task start several independent Worker candidates, each with its own worktree, branch, provider session, status, and diff. A user would compare and choose one for normal review/delivery. Losing worktrees would remain available for explicit cleanup rather than automatic deletion. This is distinct from current Combined planning, which has two Plan A/B advisors and one subsequent Worker (`root_controller.rs`, `workflows.rs`). If pursued, preserve task intent and user choice, scope native sessions and worktrees independently, report per-candidate resource use, and let ordinary user edits/merges continue. The proposed fixed 1-to-5 control and `choose_candidate` state machine were tied to the removed phase engine and are not current requirements.

**Trigger idea.** The old plan proposed scheduled tasks, labeled GitHub issues, Linear state changes, and failing CI checks, with external event identity used for idempotent task creation and task-template defaults. It also proposed best-effort tracker writeback on PR creation and completion. Current `github_triggers.rs` handles labeled open pull requests, which is a narrower implemented product. Any new trigger should observe the external owner at decision time, use stable source identity to avoid duplicate tasks, expose the rule and recent failure to an operator, and route creation through normal task authorization. Automatic issue close or Linear state change is an external write requiring a concrete product decision and service-specific permissions; it was only a proposal. The old cron parser, 60-second sweep, 300-second API interval, schema, and phase hooks are obsolete implementation choices.

**Rejected enforcement.** A selected delivery target directs agent delivery; it does not prevent a person from editing, merging, or redirecting a task. Trigger provenance and candidate metadata are observations, not conditions that require users to repair a mirror before acting.
