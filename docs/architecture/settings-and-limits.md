# Settings scope and task limits

For contributors and operators changing configuration, this page explains what
a setting affects and how resource limits differ from readiness observations.
Sources: [Settings navigation](../../apps/web/features/settings/settings-nav.ts),
[environment settings](../../apps/server/src/platform/environment_settings.rs),
[task admission limits](../../apps/server/src/tasks/limits.rs),
[workflow storage](../../apps/server/src/coordination/workflow_records.rs), and
[provider login instances](../../apps/server/src/profiles/provider_instances.rs).

## Scope comes from the setting, not the sidebar

Settings appear while a company is selected, but that does not make every
setting company-specific. Navigation groups and query parameters supply context;
the underlying resource determines who shares a change.

The important scopes are:

| Resource | Scope and effect |
| --- | --- |
| Environment defaults and backups | The Suplex instance; switching company does not select another host configuration or backup database |
| Native provider catalog and named login instances | Administrator-managed instance resources; projects select which logins they permit |
| Named workflow presets | Shared instance records, with administrator-managed defaults |
| Company, shown as Workspace in its settings page | Organization and access context for its projects and tasks |
| Project execution, integrations, credential policy, and templates | Project configuration and reusable task input |
| Task configuration and limit overrides | The individual task, with captured settings or explicit controls as applicable |

The Providers page groups dedicated logins under **Company**, but the instance
records do not have a company owner. Do not describe that label as credential
isolation. The project's allowed-login policy is the relevant selection boundary;
see [project execution](../project-execution.md#project-and-credential-boundaries).
A separate Suplex instance has separate storage, as described in
[deployment](deployment.md).

A provider login, agent profile, and task role also answer different questions.
The login supplies account access. A profile selects a provider, model, and
configuration. Coordinator, Worker, and Advisor describe responsibilities within
a task. Reusing a profile does not create a shared native conversation across
all tasks. See [providers](providers.md) and [coordination](coordination.md).

## Budget and turn allowances

Environment settings supply default estimated-spend and admitted-turn limits.
Each task can have explicit overrides. For a task without an override, admission
reads the host default; these defaults are not permanently frozen at task
creation. Changing a default can therefore affect remaining work on an existing
task that inherits it. An explicit task limit takes precedence.

Suplex checks these allowances before admitting another prompt. The turn count
covers admitted turns across task roles, and pending uncertain admissions reserve
capacity so concurrent dispatch cannot spend the same remaining turn twice.
An uncertain pending admission can hold the last slot without a limit question
while recovery resolves whether that prompt was admitted.
A turn already running can finish. These controls are not an instantaneous
provider kill switch or a guaranteed maximum invoice amount.

Spend comes from observed native usage and pricing estimates. Incomplete usage
can produce a partial estimate; it must not be advertised as a complete bill.
An unavailable estimate does not become a fabricated budget overrun, and the
turn limit can still apply independently. A failed native read can require a
retry. See [analytics](../analytics.md) for measurement and pricing limits.

When an allowance is reached, the task presents a specific limit question. The
operator can add the proposed allowance, change the limits, or cancel the task.
Setting either limit to zero disables that limit. Adjusting limits continues
from preserved task state; it does not approve the code or mark work delivered.

This pause enforces an explicit resource allowance owned by Suplex. It is not a
mirror gate based on pane metadata or cached repository state. Do not use it as
precedent for inventing unrelated human checkpoints; apply the
[engineering principles](principles.md) to each operation.

## Readiness and onboarding observations

Host health reports tool, provider, database, artifact-storage, and disk
observations. Onboarding summarizes whether the company, tools, providers,
agent profiles, and project setup appear ready. These summaries help identify
repairs; they do not prove model entitlement, successful inference, or complete
client-account access. Setup's Continue action remains available independently
of stale or unhealthy observations; see [runtime](runtime.md).

The minimum-free-disk setting is read by host health. Although the Settings
copy says it blocks worktree operations, the inspected Rust references do not
establish that enforcement. Treat this as a [documentation/UI discrepancy](unknowns.md),
not a shipped hard limit or a requirement to add a broad worktree blocker.

[Architecture index](README.md)
