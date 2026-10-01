# Unresolved work and verification limits

This is a research inventory for maintainers, not an approved backlog or a list
of launch requirements. It separates unfinished ideas from the implemented
architecture. Recheck the relevant source before planning work; absence of live
verification does not establish a defect or justify a new blocking condition.
Historical source paths and their dispositions are in [coverage](coverage.md).
[Unimplemented design ideas](../proposals.md) preserves the detailed prompt,
conversation, candidate-worktree, and trigger proposals with their tradeoffs.

## Concrete follow-ups

- **Move start cancelled mid-request.** When the client cancels
  `POST /api/moves/{id}/runs` while it runs, the handler stops at the cancel
  point. A terminal start can then leave a worktree and an open terminal
  without a run row. Run the start in a spawned task, or clean up on cancel.
  See [Moves](moves.md#known-limits).
- **Move transcript race.** The run row is written just after the terminal
  opens. A command that ends in that moment keeps no transcript.
- **Move run worktrees.** Nothing removes `move-<run id>` worktrees, archived
  or not. Removing one safely needs the unpushed-work check that task archive
  uses.
- **Host terminals across restarts.** A Suplex restart ends move runs and the
  quick shell. Herdr would keep them, but a terminal outside a task has no
  Herdr binding. See [host terminals](host-terminals.md#known-limits).

- **Disk threshold wording.** Environment Settings says minimum free disk blocks
  worktree operations. Searching the Rust consumers of `min_free_disk_gb` found
  health reporting and settings storage, not a worktree admission check. Reconcile
  the UI claim with the intended narrow operation behavior; do not infer a new
  blocking requirement from the label. See [settings and limits](settings-and-limits.md).
- **Dedicated login scope label.** The Providers page labels named logins
  **Company**, but provider-instance storage and administration have no company
  owner. Project policies restrict selection. Review the label before claiming
  per-company account isolation; see [settings scope](settings-and-limits.md).

- **Archive after display failure.** The [display cleanup](../../rust/src/tasks/archive/displays.rs)
  path tolerates missing/reassigned panes and retryable discovery failures, but
  other discovery and cleanup errors can propagate through
  [archive operations](../../rust/src/tasks/archive/operations.rs) and interrupt
  archive. The no-mirror-gates rule still requires uncertain display ownership
  to leave the pane alone without blocking the task action. Review the failing
  operation and distinguish display-only errors from actual data-loss risks;
  do not treat the implementation discrepancy as a new product requirement.

- **Consistent check rendering.** The Checks tab still derives status, names,
  and labels independently in
  [task-check-results](../../src/frontend/features/tasks/task-check-results.tsx).
  The PR card uses [shared helpers](../../src/frontend/features/tasks/lib/task-checks.ts).
  The September 14 cleanup was not fully carried through. Reuse those helpers
  when changing the tab; verify workflow prefixes, duration, skipped, and neutral
  states with a focused component check.
- **Waiting task and late display.** The September 14 native-environment plan
  described a task waiting for a human answer before its first transcript or
  display pane appeared. Inspection of the host coordination tests and task
  display tests did not establish that exact recovery sequence. Verify that
  native observation continues, the question survives, attachment can recover,
  and the admitted prompt is not resent. This is an unverified regression case,
  not proof of a present failure.
- **Provider attachment wiring.** The runtime call-site search found automatic
  attachment for Claude and Codex, but not OpenCode or Devin. See
  [provider differences](providers.md). Determine the intended display behavior
  before changing either runtime; viewer code alone is not a wiring proof.
- **Workflow race coverage.** Delivery has transactional review/ownership checks,
  but inspection did not establish that every cancellation, changed-review,
  changed-head, and external-merge race from the old workflow repair plans has
  an equivalent Rust regression case. Review the relevant cases when modifying
  [delivery](delivery.md), without restoring exact-base metadata gates.

## Product and operational ideas

These ideas survived the historical-document review because their underlying
problems remain understandable. Their scope and priority are unapproved:

- A chronological task conversation combining agent text, tool activity, and
  human decisions. Aggregate usage, operational logging, and provider-native
  transcripts already have separate owners; their presence does not establish
  a unified task-chat contract or a billable ledger.
- Broader triggers, including schedules, GitHub issues, failed checks, and
  Linear intake. The implemented GitHub rules poll labeled open pull requests.
  Native Linear support and automatic tracker status changes are not established.
- Multiple parallel implementation candidates with a chooser. Combined planning
  already compares two planning inputs; that is a different capability.
- A task-oriented diagnostic CLI with history and prompt inspection and narrowly
  scoped repair. Old Temporal reset, transcript backfill, and generic fixer
  registry designs no longer apply.
- Explicit Worker objections and review-disagreement arbitration. The intent is
  to return actionable repair to Coordinator and avoid fixed-cycle dead ends.
  The historical arbitration state machine is not established as implemented.
- A simpler user-facing Agent/profile model. The old proposal to collapse
  profiles into agents did not eliminate the current profile configuration.
- A cross-company overview, durable notification history, and optional agency
  billing/retainer views. These are design ideas, not shipped promises. The old
  branding alternatives and mobile redesign proposals were not adopted product
  decisions; current UI principles remain authoritative.
- Paperclip import, broader synchronization, automated backup scheduling, and
  client isolation drills. Preserve the problem for future scoping; do not revive
  old MVP obligations or treat project credentials as an OS sandbox.

## Verification outside this documentation change

Source inspection establishes implementation support. It does not establish
successful model inference, subscription entitlement, authenticated tracker
writes, attachment visibility for another account, packaged desktop behavior,
or compatibility with a running Herdr version. The [product guide](../product.md)
and [project execution](../project-execution.md) identify the checks needed
before public claims or client-account use.

The earlier backup/restore and CI performance notes record dated exercises and
measurements. A backup feature does not prove a successful restore of the
installation you operate. Old timing numbers do not describe the Rust build.
For a fresh comparison, use the same commit and complete successful runs;
separate queue time, cold/warm caches, wall time, and compute usage. Avoid
transplanting the old cache keys or TypeScript test commands.

[Architecture index](README.md)
