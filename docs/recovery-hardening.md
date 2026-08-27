# Recovery hardening

## Convergence contract

Recovery classifies durable task facts and live observations into one action.
It is idempotent per task revision and evidence set.

| Failure class | Action |
| --- | --- |
| transient_infrastructure, rate_limited | retry |
| code_failure, ci_failure, merge_conflict_mechanical | repair |
| credential_missing, product_ambiguity | attention |
| missing_delivery_evidence, worktree_missing_active, dirty_worktree, no_progress | attention |

Other outcomes are `no_change`, `advance`, or `resume` when the durable state
and live evidence support them.

## Attention cards

| Card | Primary action |
| --- | --- |
| github_credential | Sign in to GitHub and retry |
| worktree_missing | Recreate worktree and resume |
| missing_turn_outcome | Resume Developer or Lead turn |
| product_decision | Choose a behavior |
| dirty_worktree_cleanup | Discard changes and delete worktree |
| no_progress | Resume Developer turn or conflict resolution |
| generic | The next available safe task command |

Cards are typed server-side and are shared by the attention view and task
detail view. Product decisions retain their choices and recommended choice.

## Reconciliation triggers

- Worker start
- Active-turn and worktree heartbeat every 60 seconds
- GitHub poll every 5 minutes
- `POST /api/tasks/:id/refresh`

## Commands

- `delete_worktree`
- `recreate_worktree`
- `resume_preserved_work`
- `report_worktree_missing`

## Patch markers

- `forge-turn-outcome-recovery-v1`
- `forge-live-head-v1`
- `forge-repair-no-progress-v1`
- `forge-merge-resolution-loop-v1`
- `forge-recoverable-cancellation-v1`
