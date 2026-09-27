# Current technical architecture

For maintainers, these concept pages explain the running system, its ownership
boundaries, and its failure behavior. Operational instructions remain in their
existing guides. The [coverage record](coverage.md) identifies source review and
historical-document dispositions; [unresolved work](unknowns.md) keeps proposals
and verification gaps separate from implemented behavior.

For product intent and supported claims, read [the product guide](../product.md).
Suplex is a copilot: a person can change or merge work directly. Technical
bookkeeping helps the system continue from those changes; it is not a reason to
force the person back through a prescribed workflow.

## Concepts

| Concept | Record |
| --- | --- |
| Copilot behavior, no mirror gates, repair, and narrow safeguards | [Engineering principles](principles.md) |
| Local and remote instances, thin clients, and binary distribution | [Deployment](deployment.md) |
| Instance, project, and task settings; resource allowances | [Settings and limits](settings-and-limits.md) |
| Backup contents, restore, and native-state boundaries | [Backup and restore](backup-and-restore.md) |
| Host processes, scheduling, and state ownership | [Runtime](runtime.md) |
| Task lifecycle, role sessions, and delegation | [Coordination](coordination.md) |
| Reusable workflows, named presets, templates, and intake | [Workflows and templates](workflows-and-templates.md) |
| Worktree isolation and task/PR prerequisites | [Parallel work and dependencies](parallel-work-and-dependencies.md) |
| Provider execution, native results, and display differences | [Native providers](providers.md) |
| Pane discovery, terminal transport, and display cleanup | [Herdr](herdr.md) |
| Dispatch recovery, process ownership, and restart behavior | [Recovery](recovery.md) |
| Repository operations and manual intervention | [Delivery](delivery.md) |
| Persisted hash compatibility and serialization limits | [JSON bytes](serialization.md) |
| Project context, credentials, MCP grants, and shared resources | [Project execution](../project-execution.md) |

Projects capture instructions, environment references, integration settings,
and allowed agent credentials. Dedicated Claude logins and role-scoped project
MCP configuration have narrower guarantees than host isolation. Shared-resource
verification locks only coordinate commands using the same wrapper and key.
[Project execution](../project-execution.md) is the current record for those rules.

## Related technical records

| Topic | Current record |
| --- | --- |
| Workflow presets, templates, providers, and integration limits | [Product guide](../product.md), linked to implementations |
| External agents, grants, idempotency, and HTTP capabilities | [Agent API](../agent-api.md) |
| Incoming MCP connections and project-scoped access | [MCP guide](../agent-mcp.md) |
| Public machine discovery and pairing | [Machine discovery](../agents/machine-discovery.md) |
| Usage estimates, missing measurements, and retention | [Analytics](../analytics.md) |
| Operational events, retention, and diagnostic limits | [System logging](../system-logging.md) |
| Migration creation and immutability | [Database migrations](../database-migrations.md) |
| Desktop updates and signing | [Updates](../updates.md) |
| Browser contracts, module ownership, and verification scope | [Agent guidance](../../AGENTS.md) |
| Reasons for retained design decisions | [ADRs](../adr/) |
| Unimplemented ideas and their tradeoffs | [Proposals](../proposals.md) |

Tests alongside the runtime, display, bridge, archive, and delivery modules,
plus [host integration tests](../../rust/tests/coordination/host.rs), are the
starting points for changes. A source review or fixture test does not establish
live provider access, actual Herdr compatibility, or packaged-app behavior.

## Updating these records

Update the relevant concept document when its ownership or behavior changes. Keep one
current explanation and link to detailed operational instructions. Keep future
work separately labelled as proposed, with its unresolved scope. Recover an old
plan from Git history when investigating its intent, then check remaining work
against current code before treating it as relevant. Deleting a historical plan
does not prove every item in it was implemented.
