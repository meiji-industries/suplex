# Documentation coverage and historical sources

This is the maintenance ledger for the documentation consolidation, not a
product specification. Historical statements in this ledger describe their
sources; they do not reinstate those sources as requirements.

## Scope and confidence

Source baseline: `640866cf447ca4823fe6228e6a3072bceef66a0b`, inspected 2026-09-27.
The campaign covers product orientation and the technical knowledge affected by
historical-document deletion. It is not an exhaustive API/configuration audit.
The generated HTTP contracts, agent API reference, migrations, and operational
guides retain ownership of their respective surfaces.

Code and test-source inspection establish implementation support, not execution
success. No application tests, browser runs, paid calls, authenticated provider
checks, installs, or external writes were performed. The skills were read from
their upstream files without installing them.

The deletion inventory was produced with `git diff --name-only --diff-filter=D`:
81 files. Each path appears once in the table. Originals can be recovered
with `git show 640866cf447ca4823fe6228e6a3072bceef66a0b:PATH`; replace `PATH` with the listed
path. Links pin the same commit, so future branch changes do not change the record.

The early-plan pass reviewed substantive sections of the largest obsolete
specifications; it was not a line-by-line certification of all historical code
samples. Layered prompt customization, prompt evaluation, task chat, and broader
triggers received a deeper follow-up read. The proposal record preserves their
portable requirements and tradeoffs. Git retains the exact text. This ledger
does not claim every historical sentence was transferred or every old acceptance
case was implemented.

## Surface ownership

| Surface | Living owner | Verification scope |
| --- | --- | --- |
| Processes and scheduling | [Runtime](runtime.md) | Rust host wiring, desktop lifecycle, contextual health, browser cache |
| Task lifecycle and roles | [Coordination](coordination.md) | Creation, commands, role/session persistence, workflow policy |
| Reuse and intake | [Workflows and templates](workflows-and-templates.md) | Stored defaults, task creation form, trigger and paired-agent boundaries |
| Parallel work and prerequisites | [Parallel work and dependencies](parallel-work-and-dependencies.md) | Git worktree ownership, dependency graph, queue admission, PR observations |
| Native execution and display | [Providers](providers.md), [Herdr](herdr.md) | Registry, dispatch call sites, native readers, pane routes, bridge and archive ownership |
| Recovery | [Recovery](recovery.md) | Prompt admission, continuation, owned-process cleanup |
| Git and repository services | [Delivery](delivery.md) | Operation routing, current observations, review and completion boundaries |
| Configuration and credential policy | [Project execution](../project-execution.md) | Captured settings; provider-specific scope and publication limits |
| External agent contracts | [Agent API](../agent-api.md), [MCP](../agent-mcp.md) | Existing references retained; no full endpoint re-audit claimed |
| Persistent data | [Migrations](../database-migrations.md), [JSON bytes](serialization.md), [Analytics](../analytics.md) | Existing schema owner retained; serialization rationale and estimate limitations preserved |
| Build and distribution | [README](../../README.md), [Updates](../updates.md) | Existing runbooks retained; old benchmark conclusions not imported |
| Unfinished work | [Proposals](../proposals.md), [Unknowns](unknowns.md) | Distinct from implemented behavior and approved scope |

## Second-reader review

Coordination, delivery, providers, recovery, and serialization received an
independent source/prose review. The incorrect workflow anchor and terminology
were corrected. Runtime and Herdr received an independent source review. The Herdr archive
error qualification was corrected, and its mismatch with the operating rule
is recorded in unknowns.md. The review does not certify live operation. The
specific unverified sequences and integration limits remain in unknowns.md.

The per-document review status is:

| Document | Status | Second reader |
| --- | --- | --- |
| deployment.md | Reviewed | Independent reviewer against desktop, native configuration, and packaging sources |
| settings-and-limits.md | Reviewed | Independent reviewer against storage scope, limit admission, and health consumers |
| backup-and-restore.md | Reviewed | Assembling editor against archive service, CLI, and administrator routes |
| runtime.md | Reviewed | Independent reviews/ADR reviewer checked source and prose |
| coordination.md | Reviewed | Late-plan reviewer |
| principles.md | Reviewed | Independent reviewer against AGENTS.md and copilot direction; normative, not a shipped-state claim |
| workflows-and-templates.md | Reviewed | Independent reviews/ADR reviewer against contracts and intake code |
| parallel-work-and-dependencies.md | Reviewed | Independent reviews/ADR reviewer against graph and admission code |
| ../project-execution.md, credential-boundaries section | Reviewed | Independent reviews/ADR reviewer against profile policy |
| delivery.md | Reviewed | Late-plan reviewer |
| providers.md | Reviewed | Late-plan reviewer |
| recovery.md | Reviewed | Late-plan reviewer |
| serialization.md | Reviewed | Late-plan reviewer |
| herdr.md | Reviewed | Independent reviews/ADR reviewer; archive-error overstatement corrected |
| README.md | Reviewed | Early-plan reviewer |
| unknowns.md | Reviewed | Early-plan reviewer |
| ../proposals.md | Reviewed | Early-plan reviewer against deeper source reads |
| coverage.md | Reviewed for scope | Early-plan reviewer; mechanical inventory checked by assembling editor |

## Validation

On 2026-09-27, a local Markdown link/anchor check covered the root entry points,
all retained Markdown under docs/, and prompts/README.md. It found no missing
local targets or anchors. `git diff --check` passed. A terminology search for
retired roles, Temporal, completion receipts, OpenRouter, and evidence packets
left only explicit historical/rejected terminology and code-backed observation
or artifact references. No runtime, API, schema, generated contract, or skill
installation changed.

## Feature-brief concept follow-up

The walkthrough prompted two additional concept pages on 2026-09-27: workflows
and templates, and parallel work and dependencies. The existing project execution
guide gained a credential-boundaries section rather than a competing guide.
Source inspection covered template storage and application, workflow default
normalization, task profile selection, queue admission, PR refresh behavior,
and existing route-test cases for dependency cycles and template input.
These are conceptual explanations, not a new workflow builder, subscription
compatibility certification, or host-isolation promise.

## Preserved operating principles

[Engineering principles](principles.md) consolidates the normative guidance from
AGENTS.md, the no-mirror-gates plan, the simplification plans, and the repair
arbitration proposal. It retains authority boundaries, adaptation to manual
changes, narrow harm-based safeguards, repair before escalation, and stale-cache
regression cases. It does not restore retired role names, the old phase engine,
or the proposed arbitration implementation. Known violations remain discrepancies
in unknowns.md rather than exceptions that weaken the principles.

## Deployment concept follow-up

[Instances, clients, and distribution](deployment.md) consolidates the host/client
model, local desktop supervision, remote browser/desktop access, instance
separation, embedded assets, and Mac/Linux distribution. Source inspection
covered desktop boot and URL policy, native configuration and embedding,
packaging scripts, and release tasks. README host-adoption wording was corrected
to require matching installation identity. The updates guide now distinguishes
Linux download manifests from a running-binary updater. No build, release,
installation, network exposure, or live connection was performed.

## Settings concept follow-up

[Settings and limits](settings-and-limits.md) records actual resource scope,
live inherited task allowances, native usage estimates, and readiness limits.
[Backup and restore](backup-and-restore.md) separates archive contents, in-place
browser restore, and separate-destination CLI recovery. Source review found two
UI claims needing reconciliation: the Company grouping of instance-wide provider
logins and the minimum-disk setting's worktree-blocking copy. Both are listed in
unknowns.md; no runtime enforcement or UI changes were added. Local Markdown
links/anchors and whitespace checks passed. No backup, restore, application test,
or live provider operation ran.
