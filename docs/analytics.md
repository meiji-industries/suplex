# Task analytics

Analytics reports recorded usage and task outcomes. It does not control task
execution, delivery, or archive cleanup. The [collector](../apps/server/src/tasks/analytics/collector.rs)
reads native provider usage; [reporting](../apps/server/src/tasks/analytics/mod.rs)
combines it with lifecycle observations.

Costs are estimates in USD, not invoices. Missing measurements are not zero,
and zero reported cost does not establish that a provider is free. Coverage
varies by provider. Summed agent time differs from elapsed delivery time.
A delivered task reached its selected delivery target, which may be a local
worktree rather than a merged PR.

Keep collection idempotent and preserve recorded usage after archive or worktree
cleanup. Do not invent missing historical timestamps. Collector failures must
not block task operations. Existing collector and reporting tests cover these
behaviors; the old implementation plan is available in Git history.
