# Repository delivery

For maintainers tracing how work reaches a repository, this page explains
Suplex's delivery decisions and how they accommodate manual intervention.
Sources: [delivery operations](../../rust/src/delivery/operations.rs),
[GitHub observations](../../rust/src/integrations/github_delivery.rs), and
[workflow policy](../../rust/src/coordination/workflows.rs).

## Intent and observed work

A delivery target describes the outcome requested from the agents. People can
edit, push, rebase, or merge independently. Suplex observes those changes from
Git and the repository service instead of requiring people to reconstruct a
prescribed sequence of steps. An external merge remains a remote fact even if
Suplex cannot establish that its workflow review covered the merged revision.
The completion record distinguishes an external merge from verified workflow
completion and retains the revision that was actually reviewed.

GitHub supports all delivery targets. Bitbucket supports local work, branch
publication, and draft pull requests. Issue association is independent of
repository hosting; see [project execution](../project-execution.md) for tracker
publication and retry destinations.

## Reviews and operation boundaries

Before Suplex publishes or merges changes, it inspects the worktree and the
remote delivery range. Coordinator reviews that range; additional workflow
reviews apply according to the selected preset. A changed source cannot inherit
an unrelated approval. An advanced base branch is not by itself an authorization
failure: review equivalence can establish whether the integrated change is still
covered. Ordinary conflicts become repair work for the agents.

For non-Standard workflows, recording verified completion reloads reviews,
delegates, cancellation, and operation ownership in the same database transaction
as the completion write. Git and network observations happen outside that short
transaction. These checks protect Suplex's own actions and records; they do not
control actions a person takes in GitHub or their worktree.

The implementation includes narrow target checks for local completion and host
capability checks. It does not provide a universal target-based fence around
all repository actions. Do not infer such a fence from a target's name or add
one as a documentation-derived requirement.

## Observation failures

A failed GitHub read does not erase local task intent or prove that a remote
operation failed. Suplex classifies remote failures and gives Coordinator a
concrete cause. Transient failures can retry; missing executables, expired
credentials, and missing repository access need their respective repairs.
After an uncertain write, observe the repository before repeating it.

Checks, review records, command output, and published artifacts help explain the
work. Their existence does not imply a mandatory client-facing evidence packet
or a second completion receipt. [Recovery](recovery.md) describes the same
observe-before-retry rule for native execution.

[Architecture index](README.md)
