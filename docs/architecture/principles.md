# Engineering principles

For contributors designing or reviewing Suplex behavior, these principles define
how the product should act when work changes, observations disappear, or an
operation fails. They preserve the operating rules from the superseded plans.
They are normative: an implementation that violates them is a discrepancy to
fix, not a reason to weaken the rule. See [known discrepancies](unknowns.md).

## A copilot that steers

People can edit, redirect, push, merge, cancel, or resume work themselves.
Suplex must adapt to their intent and the actual state of their tools. Do not
require an action to pass through Suplex merely so its bookkeeping stays tidy.
Delivery targets guide agent work; they must not become universal fences around
what a person can do.

Prefer observing, explaining, repairing, and continuing over adding a rejection,
disabled control, confirmation step, or human blocker. A proposed guard needs a
concrete harm to prevent. "The state looks unusual" is not enough.

## Read the owner; never add mirror gates

A mirror gate blocks an action because Suplex's local observation is absent or
differs from the system that owns the fact. Never add one. Refresh or rediscover
the fact at the decision point instead of requiring the person to repair the
copy. A cached identifier can narrow a lookup; it cannot establish ownership,
completion, or safety.

Use the appropriate authority:

| Fact | Authority |
| --- | --- |
| Task intent, permission, and recorded human decisions | Suplex |
| Prompt admission, tool execution, and native turn results | Agent runtime |
| Worktree contents, branches, and commits | Git and the filesystem |
| Remote branches, pull requests, checks, and merges | Repository service |
| Pane existence, layout, and live terminal ownership | Herdr |

Keep durable intent, authorization, and idempotency records. Those are not
redundant copies of an external fact. Keep observations for display and diagnosis,
but do not promote them into a second authority or require another completion
receipt after the owning system establishes what happened.

Herdr is a display system, not the owner of native task completion. Older plans
assigned it broader execution authority; that historical model must not return
through copied terminology or requirements.

## Adapt to normal changes

Restarts, recreated panes, cache loss, advancing base branches, and merge
conflicts are ordinary conditions. Their recovery belongs in the normal path.

The following examples distinguish adaptation from an unnecessary blocker:

| Situation | Required response |
| --- | --- |
| A pane ID disappears or points to unrelated work | Rediscover it; leave uncertain or unrelated panes alone. Display uncertainty must not prevent task archive. |
| A person merges the PR outside Suplex | Observe and record the external merge. Record the actual review state without inventing an approval; do not demand a second merge or receipt. |
| Another developer advances the base branch | Inspect actual changes and integration results. Resolve ordinary conflicts and verify the result; base-SHA disagreement alone is not an authorization failure. |
| A refresh or display-cache write fails after a command succeeds | Preserve the command's successful result and refresh the view separately. |
| A provider response is lost after dispatch or a remote write | Observe whether the operation took effect before retrying. Never replay an admitted prompt because its local acknowledgment is missing. |
| CI or a review finds repairable work | Return the concrete finding to Coordinator and Worker. A failed attempt does not itself require a human decision. |

Fresh observations can reveal a real change that needs a different action.
For example, a changed patch may need review, and uncommitted work may make
cleanup destructive. Respond to that actual condition, not the disagreement
between two stored revisions.

## Scope necessary checks to the harm

Authentication, authorization, and data-preservation checks still matter.
Do not remove them to make a task appear unblocked. Before adding or retaining
any blocking condition, answer these questions:

1. What concrete harm would this particular operation cause?
2. Which owning system establishes the unsafe condition or missing authority?
3. Can Suplex refresh, repair, or skip an optional side effect and continue?
4. What is the smallest operation that must wait, and what makes it safe to retry?

An unknown process owner means do not signal that process. It does not establish
that every task action is unsafe. A failed merge prevents that merge attempt;
it does not require parking the whole task for a human. Missing permission
prevents the unauthorized operation; it does not erase completed work.

Missing information is not proof of safety. Obtain the relevant observation.
If access remains unavailable, report that limitation accurately and preserve
safe progress. Do not fabricate success or replace a failed owner read with a
cached success. Explicit task prerequisites and permissions remain meaningful;
a no-mirror-gates rule is not permission to ignore user intent.

## Repair before escalating

Coordinator should handle recoverable failures and disagreements with actionable
repair work. Repeating the same failed action without new information is not
recovery. Bound automatic retries, inspect the cause, and change the approach.
A retry limit alone does not justify an "accept the bug or discard the work"
dead end, automatic approval, or an invented human authorization requirement.

Ask a person when a concrete choice, missing authority, or unavailable access
prevents progress that a competent developer could otherwise make. State what
happened, what work is preserved, and the decision or access needed. Name the
system that failed; do not describe an internal bookkeeping problem as a
provider outage. Let the person redirect the work.

This principle does not claim that the old proposed arbitration state machine
was implemented. See [unresolved work](unknowns.md) for that distinction.

## Checks explain work; they are not a product ritual

Retain useful test output, review records, logs, and screenshots. They help agents
and people assess changes. Do not infer mandatory evidence packets, client
exports, signed receipts, or additional approval ceremonies from those records.
Do not rerun completed checks merely to satisfy a stale local status. Recheck
when the actual change, failure, or unresolved risk warrants it.

## Verify the action, not the mirror

For a feature that reads external state, hold the authoritative state constant
and vary the local observation: present, missing, stale, and recreated after
restart. The action's outcome must remain the same, allowing automatic refresh
or rediscovery. Test genuinely unsafe owner state separately so removing a
mirror gate does not remove a necessary safeguard.

Review every new rejection, disabled action, retry requirement, and transition
to a human wait against these principles. Fix the ownership or recovery rule at
its source instead of adding a special-case bypass for each symptom. Use focused
unit or integration tests for these cases; documentation-only changes need no
application or browser run.

[Architecture index](README.md)
