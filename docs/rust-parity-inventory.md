# Rust parity inventory

Baseline: TypeScript backend at `a57a47f5` (2026-09-24). This is a development status record, never a runtime input. The implementation scope includes milestones 4a and 4b.

States: `not started` means no complete Rust equivalent; `ported` means implementation exists with verification outstanding; `verified` means the relevant parity and integration checks pass. Tests for a smaller helper do not verify its containing route or workflow. Platform-dependent release evidence is tracked in the [PRD](plans/2026-09-24-experimental-rust-backend.md#15-implementation-progress).

The table lists all 238 backend TypeScript modules present at the baseline, including contracts, routes, and each provider adapter. New contract-only files introduced during M0 will be tracked with their source rows. Shared SQL migrations remain unchanged.

| TypeScript source | Status | Rust equivalent and evidence |
|---|---|---|
| [app.ts](../src/app.ts) | not started | |
| [cli.ts](../src/cli.ts) | not started | |
| [coordination/advisor-evidence.ts](../src/coordination/advisor-evidence.ts) | not started | |
| [coordination/advisor-report-bridge.ts](../src/coordination/advisor-report-bridge.ts) | not started | |
| [coordination/advisor-report.ts](../src/coordination/advisor-report.ts) | not started | |
| [coordination/bridge-auth.ts](../src/coordination/bridge-auth.ts) | not started | |
| [coordination/controller-reports.ts](../src/coordination/controller-reports.ts) | not started | |
| [coordination/coordinator-replacement-contracts.ts](../src/coordination/coordinator-replacement-contracts.ts) | not started | |
| [coordination/coordinator-replacement.ts](../src/coordination/coordinator-replacement.ts) | not started | |
| [coordination/human-question.ts](../src/coordination/human-question.ts) | not started | |
| [coordination/persistence/row-values.ts](../src/coordination/persistence/row-values.ts) | not started | |
| [coordination/persistence/session-operations.ts](../src/coordination/persistence/session-operations.ts) | not started | |
| [coordination/root-bridge.ts](../src/coordination/root-bridge.ts) | not started | |
| [coordination/root-contracts.ts](../src/coordination/root-contracts.ts) | not started | |
| [coordination/root-controller.ts](../src/coordination/root-controller.ts) | not started | |
| [coordination/root-session-store.ts](../src/coordination/root-session-store.ts) | not started | |
| [coordination/session-recovery.ts](../src/coordination/session-recovery.ts) | not started | |
| [coordination/task-agent-selection-contracts.ts](../src/coordination/task-agent-selection-contracts.ts) | not started | |
| [coordination/task-agent-selection.ts](../src/coordination/task-agent-selection.ts) | not started | |
| [coordination/worker-environment.ts](../src/coordination/worker-environment.ts) | not started | |
| [coordination/worker-replacement-contracts.ts](../src/coordination/worker-replacement-contracts.ts) | not started | |
| [coordination/worker-replacement.ts](../src/coordination/worker-replacement.ts) | not started | |
| [coordination/worker-turn-evidence.ts](../src/coordination/worker-turn-evidence.ts) | not started | |
| [coordination/workflow-evidence.ts](../src/coordination/workflow-evidence.ts) | not started | |
| [coordination/workflow-prompts.ts](../src/coordination/workflow-prompts.ts) | not started | |
| [coordination/workflow-records.ts](../src/coordination/workflow-records.ts) | not started | |
| [coordination/workflows.ts](../src/coordination/workflows.ts) | not started | |
| [delivery/agent-delivery.ts](../src/delivery/agent-delivery.ts) | not started | |
| [delivery/completed-pull-requests.ts](../src/delivery/completed-pull-requests.ts) | not started | |
| [delivery/failure.ts](../src/delivery/failure.ts) | not started | |
| [delivery/issue-evidence.ts](../src/delivery/issue-evidence.ts) | not started | |
| [delivery/operations.ts](../src/delivery/operations.ts) | not started | |
| [delivery/publication.ts](../src/delivery/publication.ts) | not started | |
| [delivery/pull-reference.ts](../src/delivery/pull-reference.ts) | not started | |
| [delivery/pull-request-ownership.ts](../src/delivery/pull-request-ownership.ts) | not started | |
| [delivery/review.ts](../src/delivery/review.ts) | not started | |
| [delivery/target-capabilities.ts](../src/delivery/target-capabilities.ts) | not started | |
| [http/agent-api-runtime.ts](../src/http/agent-api-runtime.ts) | not started | |
| [http/contracts/agent-api.ts](../src/http/contracts/agent-api.ts) | not started | |
| [http/contracts/auth.ts](../src/http/contracts/auth.ts) | ported | Five schemas now share one lossless validator implementation with ordinary adapters; normal and raw Zod fixtures pass. HTTP parsing still uses Serde, so full route parity remains incomplete |
| [http/contracts/avatars.ts](../src/http/contracts/avatars.ts) | not started | |
| [http/contracts/common.ts](../src/http/contracts/common.ts) | not started | 21 common validators implemented, four migrated to lossless rules. Combined parity passes 714 ordinary / 13 raw cases across 61 schemas; remaining common contracts and HTTP integration are incomplete |
| [http/contracts/github-triggers.ts](../src/http/contracts/github-triggers.ts) | not started | |
| [http/contracts/oauth.ts](../src/http/contracts/oauth.ts) | not started | |
| [http/contracts/projects.ts](../src/http/contracts/projects.ts) | not started | Profile/auxiliary schemas plus project bodies, create union, patch, single/list responses, and task policy implemented. Seven new HTTP schemas and the migrated task policy use lossless rules. Combined parity passes 825 ordinary / 26 raw cases across 68 HTTP schemas; 18 additional stored-configuration cases cover three nested schemas. Remaining project schemas and full HTTP coverage are incomplete |
| [http/contracts/providers.ts](../src/http/contracts/providers.ts) | ported | All nine validators implemented in [providers.rs](../rust/src/http/contracts/providers.rs); combined corpus passes 284 cases / 28 schemas. Raw HTTP JSON representation and endpoint integration remain unverified |
| [http/contracts/system-events.ts](../src/http/contracts/system-events.ts) | not started | |
| [http/contracts/task-templates.ts](../src/http/contracts/task-templates.ts) | not started | |
| [http/contracts/tasks.ts](../src/http/contracts/tasks.ts) | not started | Auxiliary schemas, task-agent batch query, and task-details response independently checked; combined parity passes 714 ordinary / 13 raw cases across 61 schemas. Remaining task schemas, lossless migration, and runtime routes are incomplete |
| [http/contracts/update.ts](../src/http/contracts/update.ts) | not started | |
| [http/contracts/workflows.ts](../src/http/contracts/workflows.ts) | not started | |
| [http/errors.ts](../src/http/errors.ts) | not started | |
| [http/oauth-runtime.ts](../src/http/oauth-runtime.ts) | not started | |
| [http/routes/administration.ts](../src/http/routes/administration.ts) | not started | Profile CRUD and identity invitation/list/revocation/audit routes ported with validation/auth/live checks. Other administration services and full raw HTTP parity remain pending |
| [http/routes/agent-api.ts](../src/http/routes/agent-api.ts) | not started | |
| [http/routes/agent-pairing.ts](../src/http/routes/agent-pairing.ts) | not started | |
| [http/routes/assets.ts](../src/http/routes/assets.ts) | not started | |
| [http/routes/auth.ts](../src/http/routes/auth.ts) | ported | All methods represented. Status/current-user/sign-out/profile PATCH and signed ceremonies pass focused checks; signed registration/authentication also pass an actual TCP listener with exact raw user bytes, cookies, and stored counter. Wider raw request/response corpus and complete attestation trust behavior remain pending |
| [http/routes/authenticated.ts](../src/http/routes/authenticated.ts) | not started | |
| [http/routes/avatars.ts](../src/http/routes/avatars.ts) | not started | |
| [http/routes/companies.ts](../src/http/routes/companies.ts) | ported | Read/create/rename/issue-code/status/membership operations implemented with authorization and validation-order checks; focused Rust/TS and live raw-response probes pass. Lossless HTTP JSON and shared response-corpus coverage remain incomplete |
| [http/routes/discovery.ts](../src/http/routes/discovery.ts) | not started | |
| [http/routes/external-agent-administration.ts](../src/http/routes/external-agent-administration.ts) | not started | |
| [http/routes/github-triggers.ts](../src/http/routes/github-triggers.ts) | not started | |
| [http/routes/health.ts](../src/http/routes/health.ts) | not started | |
| [http/routes/mcp.ts](../src/http/routes/mcp.ts) | not started | |
| [http/routes/oauth.ts](../src/http/routes/oauth.ts) | not started | |
| [http/routes/pages.ts](../src/http/routes/pages.ts) | not started | |
| [http/routes/projects.ts](../src/http/routes/projects.ts) | not started | Profile listing ported, including repeated query-key handling and live checks; project operations remain incomplete |
| [http/routes/provider-login.ts](../src/http/routes/provider-login.ts) | not started | |
| [http/routes/task-pane.ts](../src/http/routes/task-pane.ts) | not started | |
| [http/routes/task-templates.ts](../src/http/routes/task-templates.ts) | not started | |
| [http/routes/task-worktree.ts](../src/http/routes/task-worktree.ts) | not started | |
| [http/routes/tasks.ts](../src/http/routes/tasks.ts) | not started | |
| [http/routes/update.ts](../src/http/routes/update.ts) | not started | |
| [http/routes/workflows.ts](../src/http/routes/workflows.ts) | not started | |
| [http/session.ts](../src/http/session.ts) | not started | Partial integration: session lookup, trusted development sign-in, legacy rollover, cookie percent decoding/repeated headers, and CSRF checks ported; focused tests pass. Full HTTP route coverage remains pending |
| [identity/auth-contracts.ts](../src/identity/auth-contracts.ts) | not started | |
| [identity/auth-identifiers.ts](../src/identity/auth-identifiers.ts) | not started | |
| [identity/auth-repository.ts](../src/identity/auth-repository.ts) | not started | |
| [identity/auth-schema.ts](../src/identity/auth-schema.ts) | not started | |
| [identity/auth-webauthn.ts](../src/identity/auth-webauthn.ts) | not started | Partial adapter and [10-algorithm spike evidence](rust-spikes/webauthn.md), including synthetic packed and FIDO U2F attestation. Actual TypeScript/Rust services and shared SQLite register/authenticate in both directions; signed TCP flow passes. Apple, Android Key, TPM, and SafetyNet trust behavior remain incomplete |
| [identity/auth.ts](../src/identity/auth.ts) | not started | Sessions, development administrator, profile/company operations, invitations, lists, revocation, and signed ceremonies implemented with focused/live checks. Shared-database TypeScript↔Rust credential/session roundtrips pass. Legacy-user constructor normalization, setup/recovery CLI entrypoints, downstream agent audits, lossless metadata, and full attestation parity remain incomplete |
| [identity/avatar-kinds.ts](../src/identity/avatar-kinds.ts) | not started | |
| [identity/avatars.ts](../src/identity/avatars.ts) | not started | |
| [identity/external-agents.ts](../src/identity/external-agents.ts) | not started | |
| [identity/oauth.ts](../src/identity/oauth.ts) | not started | |
| [identity/registration.ts](../src/identity/registration.ts) | not started | |
| [integrations/bitbucket.ts](../src/integrations/bitbucket.ts) | not started | |
| [integrations/github/client.ts](../src/integrations/github/client.ts) | not started | |
| [integrations/github/delivery.ts](../src/integrations/github/delivery.ts) | not started | |
| [integrations/github/failure.ts](../src/integrations/github/failure.ts) | not started | |
| [integrations/github/issues.ts](../src/integrations/github/issues.ts) | not started | |
| [integrations/github/pull-request-states.ts](../src/integrations/github/pull-request-states.ts) | not started | |
| [integrations/github/trigger-delivery-policy.ts](../src/integrations/github/trigger-delivery-policy.ts) | not started | |
| [integrations/github/trigger-dispatches.ts](../src/integrations/github/trigger-dispatches.ts) | not started | |
| [integrations/github/trigger-inspection.ts](../src/integrations/github/trigger-inspection.ts) | not started | |
| [integrations/github/trigger-paths.ts](../src/integrations/github/trigger-paths.ts) | not started | |
| [integrations/github/trigger-poller.ts](../src/integrations/github/trigger-poller.ts) | not started | |
| [integrations/github/trigger-repository.ts](../src/integrations/github/trigger-repository.ts) | not started | |
| [integrations/github/triggers.ts](../src/integrations/github/triggers.ts) | not started | |
| [integrations/herdr/client.ts](../src/integrations/herdr/client.ts) | not started | |
| [integrations/herdr/readiness.ts](../src/integrations/herdr/readiness.ts) | not started | |
| [integrations/herdr/terminal-bridge.ts](../src/integrations/herdr/terminal-bridge.ts) | not started | |
| [integrations/issue-tracker.ts](../src/integrations/issue-tracker.ts) | not started | |
| [integrations/provider-http.ts](../src/integrations/provider-http.ts) | not started | |
| [integrations/suplex/mcp-bridge.ts](../src/integrations/suplex/mcp-bridge.ts) | not started | |
| [integrations/suplex/mcp-runtime.ts](../src/integrations/suplex/mcp-runtime.ts) | not started | |
| [platform/artifacts.ts](../src/platform/artifacts.ts) | not started | |
| [platform/backup.ts](../src/platform/backup.ts) | not started | |
| [platform/command-runner.ts](../src/platform/command-runner.ts) | not started | |
| [platform/config.ts](../src/platform/config.ts) | not started | Partial foundation in [config.rs](../rust/src/platform/config.rs), commit `924c9efe`: isolated defaults and port only; full configuration remains pending |
| [platform/database.ts](../src/platform/database.ts) | verified | [Rust database and tests](../rust/src/platform/database.rs): all 149 migrations, transactions/callbacks/rollback, read-only reopening, and additive rebuilds pass; TS↔Rust reopening matches all 155 schema rows and 149 ledger rows. Binary startup passes. Shared HTTP wrapper releases its lock before callbacks; callers must preserve each TypeScript transaction boundary |
| [platform/development.ts](../src/platform/development.ts) | not started | |
| [platform/diagnostics/doctor.ts](../src/platform/diagnostics/doctor.ts) | not started | |
| [platform/diagnostics/task.ts](../src/platform/diagnostics/task.ts) | not started | |
| [platform/environment-settings.ts](../src/platform/environment-settings.ts) | not started | |
| [platform/executable-resolver.ts](../src/platform/executable-resolver.ts) | not started | |
| [platform/factory-reset.ts](../src/platform/factory-reset.ts) | not started | |
| [platform/frontend-development.ts](../src/platform/frontend-development.ts) | not started | |
| [platform/health-contract.ts](../src/platform/health-contract.ts) | not started | |
| [platform/health.ts](../src/platform/health.ts) | not started | |
| [platform/host-health.ts](../src/platform/host-health.ts) | not started | |
| [platform/install/command.ts](../src/platform/install/command.ts) | not started | |
| [platform/install/stages.ts](../src/platform/install/stages.ts) | not started | |
| [platform/log-viewer.ts](../src/platform/log-viewer.ts) | not started | |
| [platform/logging.ts](../src/platform/logging.ts) | not started | |
| [platform/process-manager.ts](../src/platform/process-manager.ts) | not started | |
| [platform/runtime.ts](../src/platform/runtime.ts) | not started | |
| [platform/schemas.ts](../src/platform/schemas.ts) | not started | |
| [platform/setup.ts](../src/platform/setup.ts) | not started | |
| [platform/system-event-transport.ts](../src/platform/system-event-transport.ts) | not started | |
| [platform/system-events.ts](../src/platform/system-events.ts) | not started | |
| [platform/tailscale.ts](../src/platform/tailscale.ts) | not started | |
| [platform/ui.ts](../src/platform/ui.ts) | not started | Asset embedding tested in [embedded.rs](../rust/src/platform/embedded.rs), commit `924c9efe`; serving and UI behavior remain pending |
| [platform/updates/supervisor.ts](../src/platform/updates/supervisor.ts) | not started | |
| [platform/updates/update-client.ts](../src/platform/updates/update-client.ts) | not started | |
| [profiles/agent-profile-contracts.ts](../src/profiles/agent-profile-contracts.ts) | not started | |
| [profiles/agent-profiles.ts](../src/profiles/agent-profiles.ts) | ported | CRUD/duplicate/default selection, references, policy pruning/rollback, audit, and OS-based CLI discovery ported; Rust unit/live checks and 13 TS reference tests pass. Full raw HTTP/response-corpus parity remains pending |
| [profiles/model-pricing.ts](../src/profiles/model-pricing.ts) | not started | |
| [profiles/models-dev-catalog.ts](../src/profiles/models-dev-catalog.ts) | not started | |
| [profiles/provider-catalog.ts](../src/profiles/provider-catalog.ts) | not started | |
| [profiles/provider-connection.ts](../src/profiles/provider-connection.ts) | not started | |
| [profiles/provider-instances.ts](../src/profiles/provider-instances.ts) | not started | |
| [profiles/provider-login.ts](../src/profiles/provider-login.ts) | not started | |
| [profiles/provider-readiness.ts](../src/profiles/provider-readiness.ts) | not started | |
| [projects/contracts.ts](../src/projects/contracts.ts) | not started | |
| [projects/execution-configuration.ts](../src/projects/execution-configuration.ts) | not started | |
| [projects/integration-configuration.ts](../src/projects/integration-configuration.ts) | not started | |
| [projects/projects.ts](../src/projects/projects.ts) | not started | Default local GitHub preflight/create/get/list implemented with live membership, profile eligibility, duplicate rollback, audit, and lossless normalization of all four stored JSON columns. Independent Rust project checks7/7 and TypeScript reference23/23 pass; isolated staged full Rust checks pass. Optional writes, remote/new repositories, Bitbucket, updates, and HTTP composition remain incomplete |
| [projects/provider-policy.ts](../src/projects/provider-policy.ts) | not started | |
| [projects/repository-commands.ts](../src/projects/repository-commands.ts) | not started | |
| [projects/repository-coordinate.ts](../src/projects/repository-coordinate.ts) | not started | GitHub coordinate/remote parsing covered by repository tests; full provider coverage remains incomplete |
| [projects/repository-inspection.ts](../src/projects/repository-inspection.ts) | not started | Existing local GitHub repo inspection, real Git fetch, fake-gh observations, path checks, buffer limits/timeouts tested; Bitbucket and live GitHub-account proof remain incomplete |
| [projects/repository-provisioning.ts](../src/projects/repository-provisioning.ts) | not started | |
| [runtimes/claude-code/display.ts](../src/runtimes/claude-code/display.ts) | not started | |
| [runtimes/claude-code/environment.ts](../src/runtimes/claude-code/environment.ts) | not started | |
| [runtimes/claude-code/live-history.ts](../src/runtimes/claude-code/live-history.ts) | not started | |
| [runtimes/claude-code/session-reader.ts](../src/runtimes/claude-code/session-reader.ts) | not started | |
| [runtimes/claude-code/task-runtime.ts](../src/runtimes/claude-code/task-runtime.ts) | not started | |
| [runtimes/claude-code/transcript.ts](../src/runtimes/claude-code/transcript.ts) | not started | |
| [runtimes/codex/display.ts](../src/runtimes/codex/display.ts) | not started | |
| [runtimes/codex/session-reader.ts](../src/runtimes/codex/session-reader.ts) | not started | |
| [runtimes/codex/task-runtime.ts](../src/runtimes/codex/task-runtime.ts) | not started | |
| [runtimes/codex/transcript.ts](../src/runtimes/codex/transcript.ts) | not started | |
| [runtimes/devin/advisor-evidence.ts](../src/runtimes/devin/advisor-evidence.ts) | not started | |
| [runtimes/devin/display.ts](../src/runtimes/devin/display.ts) | not started | |
| [runtimes/devin/mcp-config.ts](../src/runtimes/devin/mcp-config.ts) | not started | |
| [runtimes/devin/session-reader.ts](../src/runtimes/devin/session-reader.ts) | not started | |
| [runtimes/devin/task-runtime.ts](../src/runtimes/devin/task-runtime.ts) | not started | |
| [runtimes/devin/transcript.ts](../src/runtimes/devin/transcript.ts) | not started | |
| [runtimes/harness-kind.ts](../src/runtimes/harness-kind.ts) | not started | |
| [runtimes/headless/turn-process.ts](../src/runtimes/headless/turn-process.ts) | not started | |
| [runtimes/opencode/client.ts](../src/runtimes/opencode/client.ts) | not started | |
| [runtimes/opencode/contracts.ts](../src/runtimes/opencode/contracts.ts) | not started | |
| [runtimes/opencode/providers.ts](../src/runtimes/opencode/providers.ts) | not started | |
| [runtimes/opencode/server.ts](../src/runtimes/opencode/server.ts) | not started | |
| [runtimes/opencode/session-history.ts](../src/runtimes/opencode/session-history.ts) | not started | |
| [runtimes/opencode/session-reader.ts](../src/runtimes/opencode/session-reader.ts) | not started | |
| [runtimes/opencode/session.ts](../src/runtimes/opencode/session.ts) | not started | |
| [runtimes/opencode/task-runtime.ts](../src/runtimes/opencode/task-runtime.ts) | not started | |
| [runtimes/project-environment.ts](../src/runtimes/project-environment.ts) | not started | |
| [runtimes/project-mcp.ts](../src/runtimes/project-mcp.ts) | not started | |
| [runtimes/task-display.ts](../src/runtimes/task-display.ts) | not started | |
| [runtimes/task-harness-registry.ts](../src/runtimes/task-harness-registry.ts) | not started | |
| [runtimes/task-harness.ts](../src/runtimes/task-harness.ts) | not started | |
| [server.ts](../src/server.ts) | not started | |
| [shared/abort-signal.ts](../src/shared/abort-signal.ts) | not started | |
| [shared/assert-never.ts](../src/shared/assert-never.ts) | not started | |
| [shared/canonical-json.ts](../src/shared/canonical-json.ts) | not started | |
| [shared/entrypoint.ts](../src/shared/entrypoint.ts) | not started | |
| [shared/ids.ts](../src/shared/ids.ts) | not started | |
| [shared/json.ts](../src/shared/json.ts) | not started | |
| [shared/mcp-stdio.ts](../src/shared/mcp-stdio.ts) | not started | |
| [tasks/agent-status.ts](../src/tasks/agent-status.ts) | not started | |
| [tasks/analytics/analytics.ts](../src/tasks/analytics/analytics.ts) | not started | |
| [tasks/analytics/collector.ts](../src/tasks/analytics/collector.ts) | not started | |
| [tasks/analytics/contracts.ts](../src/tasks/analytics/contracts.ts) | not started | |
| [tasks/analytics/metrics.ts](../src/tasks/analytics/metrics.ts) | not started | |
| [tasks/analytics/store.ts](../src/tasks/analytics/store.ts) | not started | |
| [tasks/archive/displays.ts](../src/tasks/archive/displays.ts) | not started | |
| [tasks/archive/processes.ts](../src/tasks/archive/processes.ts) | not started | |
| [tasks/archive/sessions.ts](../src/tasks/archive/sessions.ts) | not started | |
| [tasks/branch.ts](../src/tasks/branch.ts) | not started | |
| [tasks/contracts.ts](../src/tasks/contracts.ts) | not started | |
| [tasks/control.ts](../src/tasks/control.ts) | not started | |
| [tasks/dependencies.ts](../src/tasks/dependencies.ts) | not started | |
| [tasks/duplicate-title.ts](../src/tasks/duplicate-title.ts) | not started | |
| [tasks/execution/contracts.ts](../src/tasks/execution/contracts.ts) | not started | |
| [tasks/execution/execution.ts](../src/tasks/execution/execution.ts) | not started | |
| [tasks/execution/pane-layout.ts](../src/tasks/execution/pane-layout.ts) | not started | |
| [tasks/execution/role-prompt.ts](../src/tasks/execution/role-prompt.ts) | not started | |
| [tasks/history/contracts.ts](../src/tasks/history/contracts.ts) | not started | |
| [tasks/history/history.ts](../src/tasks/history/history.ts) | not started | |
| [tasks/history/live.ts](../src/tasks/history/live.ts) | not started | |
| [tasks/history/read.ts](../src/tasks/history/read.ts) | not started | |
| [tasks/host.ts](../src/tasks/host.ts) | not started | |
| [tasks/images.ts](../src/tasks/images.ts) | not started | |
| [tasks/inspection.ts](../src/tasks/inspection.ts) | not started | |
| [tasks/integration.ts](../src/tasks/integration.ts) | not started | |
| [tasks/issue-association.ts](../src/tasks/issue-association.ts) | not started | |
| [tasks/issue-context.ts](../src/tasks/issue-context.ts) | not started | |
| [tasks/limits/attachment-limits.ts](../src/tasks/limits/attachment-limits.ts) | not started | |
| [tasks/limits/limit-observer.ts](../src/tasks/limits/limit-observer.ts) | not started | |
| [tasks/limits/limit-store.ts](../src/tasks/limits/limit-store.ts) | not started | |
| [tasks/limits/limits.ts](../src/tasks/limits/limits.ts) | not started | |
| [tasks/preparation.ts](../src/tasks/preparation.ts) | not started | |
| [tasks/pull-request-dependencies.ts](../src/tasks/pull-request-dependencies.ts) | not started | |
| [tasks/queue.ts](../src/tasks/queue.ts) | not started | |
| [tasks/repository.ts](../src/tasks/repository.ts) | not started | |
| [tasks/sources.ts](../src/tasks/sources.ts) | not started | |
| [tasks/tasks.ts](../src/tasks/tasks.ts) | not started | |
| [tasks/templates.ts](../src/tasks/templates.ts) | not started | |
| [tasks/timeline/contracts.ts](../src/tasks/timeline/contracts.ts) | not started | |
| [tasks/timeline/timeline.ts](../src/tasks/timeline/timeline.ts) | not started | |
| [tasks/usage.ts](../src/tasks/usage.ts) | not started | |
| [tasks/worktree-open.ts](../src/tasks/worktree-open.ts) | not started | |
| [tasks/worktree.ts](../src/tasks/worktree.ts) | not started | |
