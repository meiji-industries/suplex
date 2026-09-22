# Definitions

Terms coined in this repository. Each entry names the concept, states the rule it implies, and
points at where the rule is enforced. Add a term when a review or a postmortem keeps reaching for
the same phrase.

## Mirror gate

**Definition.** A mirror gate is a decision that Suplex makes from its own copy of a fact that
another system owns, instead of from the owner. Git owns worktrees, branches, commits, and trees.
GitHub owns pull requests, checks, and merge state. Herdr owns turns, sessions, agent liveness,
and result files. Suplex may keep a copy of any of those as a receipt or for display. The moment a
copy becomes a precondition, a refusal, or a reason to park a task, it is a mirror gate.

**Why it is a defect.** The copy and the owner drift. A restart, a retry, a moved base branch, a
timed-out acknowledgement, or a second writer leaves the copy stale while the owner is fine. A
mirror gate then refuses work that is already correct, and the task stops with nothing left to
do. Every dead end found on 2026-09-03 and 2026-09-04 was two copies of one fact.

**The rule.** At a decision point, read the owner and record the observation you used. A Suplex
row may narrow a lookup; it may never prove the fact. A stale copy must cause a refresh, never a
refusal, a loop, or a parked task. Suplex keeps its own intent and member decisions, and it keeps
idempotency keys, because those are facts Suplex owns.

**How to recognise one.**

- A `status`, `result_commit`, `head_sha`, or turn state column appears in an `if` that ends in
  `blocked`, `throw`, or `owner: "human"`.
- A join across several Suplex tables must line up exactly before an action is allowed.
- A message says a revision "does not match the recorded" anything.
- The fix for a parked task is a restart, a retry click, or a database edit, while `git status`,
  `gh pr view`, and `herdr agent get` all say the work is fine.

**Shapes seen so far.**

| Copy that gated | Owner that was right | Fix |
| --- | --- | --- |
| `suplex_developer_executions.status` and `result_commit` before a release | git had the reviewed commit clean at HEAD | Prove the revision in git; rows narrow the lookup (`src/engine/activities/git-proof.ts`) |
| Forward-merge lineage chain across three base moves | git had the merge commit with the base as an ancestor | Same proof in the no-drift path of `target-base.ts` |
| PR base observation vs reviewed base | Git integration result on the authoritative base | Digest-aware `sameRange` in `src/workflows.ts` and review equivalence in `src/delivery-review.ts` |
| A workflow state field pointing at an execution id that was never inserted | nothing owned it | Keep the prior id until the activity returns a persisted row |
| `suplex_herdr_turns.status = 'waiting'` treated as a live turn | Herdr showed the pane idle and the result file present | Parse the result with the turn's schema, then ask Herdr; a `dispatching` turn gets a bounded grace |
| A prompt acknowledgement timeout treated as a failed turn | Herdr showed the agent working | Read `herdr agent get` after the timeout |
| A stale pull-request head observation rewritten every loop pass | GitHub said the same thing each time | Idempotent observation: no revision bump when nothing changed |
| A CI-repair lookup that only accepted execution rows | the commit CI tested was a forward-merge result git had at HEAD | Accept forward-merge rows, then the worktree by branch |

**What is not a mirror gate.**

- Suplex's own intent: a task brief, an assignment, an approved plan, a review outcome, an
  arbitration choice, a member answer, the current step and its allowed commands.
- Idempotency keys such as `release_key`, provider `operation_key`, command ids, and engine
  activity ids. They record that Suplex meant to do a thing once, not that the owner did it.
- Local engine bookkeeping in `suplex_engine_activities` and `suplex_engine_commands`. No external
  fact is copied there.
- A throttle on how often an owner is read, as long as the decision still uses a fresh read when
  it is due.

**Related ideas elsewhere.** Source of truth versus cache; stale-replica reads; controller
reconciliation loops that observe actual state rather than trusting a status field; idempotency
keys as intent rather than proof. The name is ours. The pathology is common.

**Where the rule lives.** `docs/plans/2026-09-03-no-mirror-gates.md` holds the truth table, the
ranked deletion list, and the rules for implementers.

## Silent projection

**Definition.** A silent projection is a write of a new workflow revision that changes nothing a
member or an agent could act on: the same step, the same owner, the same pending action, the same
blocker, only a higher revision and a new event id. It usually comes from an evaluation that ran,
decided nothing, and projected anyway.

**Why it is a defect.** Revisions are the optimistic-concurrency token for every command. Each
silent projection invalidates the revision a person or an API client just read, so their command
fails with a stale-revision conflict. A loop that projects silently on every wake makes the task
uncommandable, and at speed it becomes a hot loop that only the projection breaker stops.

**The rule.** No projection without a change. An evaluation compares the state it would write to
the state it read and returns without projecting when they are equal. A command refused by a
handler guard rolls back its provisional claim: no revision bump, no processed command id. A
receipt refresh such as an observation time is not by itself a reason to project.

**How to recognise one.** The timeline shows no entry, but the revision climbs. A snapshot diff
shows only `revision`, `lastEventId`, `processedCommandIds`, or `lastHandlerError`. Commands sent
from the UI or the API return 409 with `stale-revision` while nothing visible changed.

**Seen so far.** A stale pull-request head observation rewritten every loop pass (about 27
revisions a minute, just under the breaker); a declined re-observation that appended its reason to
the pending action and ping-ponged with the auto-retry (14,000 revisions in twelve minutes); a
driver command refused by its handler guard that still projected on every wake, blocking every
human command with a 409.
