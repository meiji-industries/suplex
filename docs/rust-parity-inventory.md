# Rust parity inventory

Baseline: TypeScript backend at `a57a47f5` (2026-09-24). This is a development status record, never a runtime input. The implementation scope includes milestones 4a and 4b.

States: `not started` means no complete Rust equivalent; `ported` means implementation exists with verification outstanding; `verified` means the relevant parity and integration checks pass. Tests for a smaller helper do not verify its containing route or workflow. The [PRD](plans/2026-09-24-experimental-rust-backend.md) defines release criteria; keep completion and test evidence here.

The table lists all 238 backend TypeScript modules present at the baseline, including contracts, routes, and each provider adapter. Contract extractions already committed during M0 are tracked with their source rows; no further extraction is required. Shared SQL migrations remain unchanged. Inventory introduced in `ea44af63`.

Current sequence: complete one Codex Standard task through the UI with cancellation and restart recovery. High-level WebAuthn and the Serde/Garde conversion of live auth/project requests are implemented. The UTF-16 document model, special schema interpreters, raw-JSON fixtures and response-schema fixtures are removed; the hash serializer remains. The typed cleanup in `b43d8fa3` removes a net 3,132 Rust source lines. Other API breadth is deferred. Git2 and GitHub API/keychain integration follow their M2/M3 delivery seams.

Request corpus: 1,141 fixtures across 95 request exports plus 23 stored-project cases across three exports. The typed cleanup passes 522 cases across 43 implemented request schemas, all stored-project cases, and seven hash fixtures. Its actual index export passes 58 unit tests and three integration tests, plus both signed passkey tests run explicitly. The subsequent task DTO unit passes 60 TaskBody cases and nine TaskIdParams cases, including UTF-16 strings and integral JSON numbers. Its isolated export passes 79 unit tests, three integration tests, locked fmt, all-target Clippy, generator, TypeScript typecheck and targeted ESLint. Unused request validators are deferred until their routes need them; the corpus retains their fixtures. The TypeScript full suite baseline is 1,613/1,623: seven failures reproduce at pre-port `a57a47f5`, and three Devin failures pass focused reruns. Hosted CI, packages, full task execution, switching, and the eight-hour run remain unverified. Final snapshots use separate Cargo targets after an earlier shared-target collision.

| TypeScript source | Status | Rust equivalent and evidence |
|---|---|---|
| [app.ts](../src/app.ts) | not started | `924c9efe`, `92f290e3`: Cargo/toolchain/CI, isolated startup, SQLite and sign-in assets tested locally; task host and full route wiring remain pending. |
| [cli.ts](../src/cli.ts) | not started | |
| [coordination/advisor-evidence.ts](../src/coordination/advisor-evidence.ts) | not started | |
| [coordination/advisor-report-bridge.ts](../src/coordination/advisor-report-bridge.ts) | not started | |
| [coordination/advisor-report.ts](../src/coordination/advisor-report.ts) | not started | `1c24c183`: existing schemas extracted with compatible exports and passing TypeScript checks; Rust service remains pending |
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
| [coordination/root-session-store.ts](../src/coordination/root-session-store.ts) | not started | `76ff7e2b`: `rust/src/coordination/root_session_store.rs` reserves current Root generation and claims prompts atomically with source dependency/budget/turn/owner checks. Real detached shell launch, duplicate denial, reopened SQLite attempt/record agreement and prerequisite regression pass. Isolated staged export passes 76 library tests, three integration tests, locked fmt and all-target Clippy. Full controller recovery and real Codex remain pending. |
| [coordination/session-recovery.ts](../src/coordination/session-recovery.ts) | not started | |
| [coordination/task-agent-selection-contracts.ts](../src/coordination/task-agent-selection-contracts.ts) | not started | |
| [coordination/task-agent-selection.ts](../src/coordination/task-agent-selection.ts) | not started | |
| [coordination/worker-environment.ts](../src/coordination/worker-environment.ts) | not started | |
| [coordination/worker-replacement-contracts.ts](../src/coordination/worker-replacement-contracts.ts) | not started | |
| [coordination/worker-replacement.ts](../src/coordination/worker-replacement.ts) | not started | |
| [coordination/worker-turn-evidence.ts](../src/coordination/worker-turn-evidence.ts) | not started | |
| [coordination/workflow-evidence.ts](../src/coordination/workflow-evidence.ts) | not started | |
| [coordination/workflow-prompts.ts](../src/coordination/workflow-prompts.ts) | not started | |
| [coordination/workflow-records.ts](../src/coordination/workflow-records.ts) | not started | Seeded workflow listing and typed advisor serialization pass the cleanup's isolated Cargo and raw HTTP checks. CRUD remains deferred. |
| [coordination/workflows.ts](../src/coordination/workflows.ts) | not started | `1c24c183`: existing schemas extracted with compatible exports and passing TypeScript checks; next Rust work is limited to the Standard task slice |
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
| [http/contracts/auth.ts](../src/http/contracts/auth.ts) | ported | Named Serde/Garde requests replace the special JSON validators. Request corpus and signed registration/sign-in pass after conversion. |
| [http/contracts/avatars.ts](../src/http/contracts/avatars.ts) | not started | |
| [http/contracts/common.ts](../src/http/contracts/common.ts) | not started | Live identity/company/admin bodies use named DTOs and public findings. Current request corpus passes; remaining schemas are deferred. |
| [http/contracts/github-triggers.ts](../src/http/contracts/github-triggers.ts) | not started | |
| [http/contracts/oauth.ts](../src/http/contracts/oauth.ts) | not started | |
| [http/contracts/projects.ts](../src/http/contracts/projects.ts) | not started | Typed project creation and nested configurations pass public findings and HTTP checks, including optional/null distinctions, source bounds, ASCII patterns and field ordering. Unused PATCH validation is deferred with its route. |
| [http/contracts/providers.ts](../src/http/contracts/providers.ts) | ported | `88bb9b9d`: nine validators pass the ordinary corpus; provider runtime/HTTP integration remains unverified. |
| [http/contracts/system-events.ts](../src/http/contracts/system-events.ts) | not started | |
| [http/contracts/task-templates.ts](../src/http/contracts/task-templates.ts) | not started | `a974de91` is historic evidence only. Special JSON validators are removed; typed contracts return with template routes needed by M2. |
| [http/contracts/tasks.ts](../src/http/contracts/tasks.ts) | not started | `rust/src/http/contracts/typed/tasks.rs` provides named create and task-ID DTOs. All 60 TaskBody and nine TaskIdParams fixtures pass, including public multi-issue findings, IssueAssociation rules, UTF-16 bounds and integral JSON numbers. Start remains params-only. HTTP wiring, response serialization and other commands remain pending. |
| [http/contracts/update.ts](../src/http/contracts/update.ts) | not started | |
| [http/contracts/workflows.ts](../src/http/contracts/workflows.ts) | not started | List query preserves literal/strict rules and passes corpus/HTTP checks. Special JSON validators for other operations are removed and deferred with their routes. |
| [http/errors.ts](../src/http/errors.ts) | not started | `b369604d`: validationFindings exported unchanged; removed100 response-only groups and65 raw fixtures. Typed request parsers return DTOs directly and map public findings once. Isolated request/stored corpus and HTTP checks pass, including project400 and source Jira500. Wider route integration remains pending. |
| [http/oauth-runtime.ts](../src/http/oauth-runtime.ts) | not started | |
| [http/routes/administration.ts](../src/http/routes/administration.ts) | not started | `e49977ee`, `99c6e5f8`, `f23bab60`: known-route registration and identity/profile administration tested; wider administration deferred. |
| [http/routes/agent-api.ts](../src/http/routes/agent-api.ts) | not started | |
| [http/routes/agent-pairing.ts](../src/http/routes/agent-pairing.ts) | not started | |
| [http/routes/assets.ts](../src/http/routes/assets.ts) | not started | |
| [http/routes/auth.ts](../src/http/routes/auth.ts) | ported | `40b7e8aa`: high-level signed TCP registration/sign-in, exact user response, session/CSRF cookies and detached admitted completion pass. Both signed checks pass again after typed request conversion; old-passkey reenrollment is accepted. |
| [http/routes/authenticated.ts](../src/http/routes/authenticated.ts) | not started | |
| [http/routes/avatars.ts](../src/http/routes/avatars.ts) | not started | |
| [http/routes/companies.ts](../src/http/routes/companies.ts) | ported | `f50af424`: company mutations, authority and raw response checks pass. Named request DTO conversion passes the cleanup's isolated Cargo checks. |
| [http/routes/discovery.ts](../src/http/routes/discovery.ts) | not started | |
| [http/routes/external-agent-administration.ts](../src/http/routes/external-agent-administration.ts) | not started | |
| [http/routes/github-triggers.ts](../src/http/routes/github-triggers.ts) | not started | |
| [http/routes/health.ts](../src/http/routes/health.ts) | not started | |
| [http/routes/mcp.ts](../src/http/routes/mcp.ts) | not started | |
| [http/routes/oauth.ts](../src/http/routes/oauth.ts) | not started | |
| [http/routes/pages.ts](../src/http/routes/pages.ts) | verified | `6631e45c`: five focused checks, live redirect/HTML/OAuth policy and desktop/narrow React boot pass. `40b7e8aa` removes two accidentally committed deferred-workflow registrations; its exact index export passes 54 library tests, five integration tests, fmt and all-target Clippy. Health and task execution remain separate pending capabilities. |
| [http/routes/projects.ts](../src/http/routes/projects.ts) | not started | `1e2b2f0c`: reads/defaults/provider instances, GitHub pickers and local/existing/new GitHub creation tested. Typed creation passes isolated checks and preserves raw response order/nullability. Bitbucket/PATCH/ancillary routes remain deferred. |
| [http/routes/provider-login.ts](../src/http/routes/provider-login.ts) | not started | |
| [http/routes/task-pane.ts](../src/http/routes/task-pane.ts) | not started | |
| [http/routes/task-templates.ts](../src/http/routes/task-templates.ts) | not started | |
| [http/routes/task-worktree.ts](../src/http/routes/task-worktree.ts) | not started | |
| [http/routes/tasks.ts](../src/http/routes/tasks.ts) | not started | |
| [http/routes/update.ts](../src/http/routes/update.ts) | not started | |
| [http/routes/workflows.ts](../src/http/routes/workflows.ts) | not started | GET listing passes query findings, session authority and ordered raw response checks in the isolated cleanup export. CRUD remains 501. TS tests2/2 pass with an added seeded raw-body assertion; no contract or existing expectation changed. |
| [http/session.ts](../src/http/session.ts) | not started | `92f290e3`, `0856b0d4`: session lookup, trusted sign-in, legacy rollover, cookies and CSRF tested; full route integration pending. |
| [identity/auth-contracts.ts](../src/identity/auth-contracts.ts) | not started | |
| [identity/auth-identifiers.ts](../src/identity/auth-identifiers.ts) | not started | |
| [identity/auth-repository.ts](../src/identity/auth-repository.ts) | not started | |
| [identity/auth-schema.ts](../src/identity/auth-schema.ts) | not started | |
| [identity/auth-webauthn.ts](../src/identity/auth-webauthn.ts) | verified | `40b7e8aa`: high-level webauthn-rs replaces custom attestation/core/CBOR glue; library state uses existing columns and old credential rows remain intact. Signed registration/sign-in/reopen, counters7→8, equal-counter/replay rejection and detached TCP completion pass. Exact index export: fmt/all-target Clippy,54 library tests and5 integration tests pass; both ignored Node signer tests also pass explicitly, as do TS signer1/1, ESLint and typecheck. Reenrollment is accepted; OpenSSL remains transitive. |
| [identity/auth.ts](../src/identity/auth.ts) | not started | `905b7b82`, `99c6e5f8`, `f50af424`: identity/company administration and metadata tested. Serde metadata/transports and typed consumers pass isolated cleanup checks; M2 integration and operational CLI remain pending. |
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
| [integrations/suplex/mcp-bridge.ts](../src/integrations/suplex/mcp-bridge.ts) | not started | `4d0861e3`: rmcp stdio/HTTP initialize/list/call transport probes pass; [spike](rust-spikes/mcp.md). Real Rust bridges/tools/auth remain M2 work. |
| [integrations/suplex/mcp-runtime.ts](../src/integrations/suplex/mcp-runtime.ts) | not started | |
| [platform/artifacts.ts](../src/platform/artifacts.ts) | not started | |
| [platform/backup.ts](../src/platform/backup.ts) | not started | |
| [platform/command-runner.ts](../src/platform/command-runner.ts) | not started | |
| [platform/config.ts](../src/platform/config.ts) | not started | `924c9efe`: isolated defaults/port; `cd7c1f93`: plain cargo selects nested toolchain, config2/2 and isolated root/listener checks pass, Clippy passes. Full configuration pending |
| [platform/database.ts](../src/platform/database.ts) | verified | `0555c057`: all149 migrations,155 schema rows, transactions/savepoints/callbacks/rollback/read-only/rebuild and TS↔Rust reopening pass; callers must preserve each source transaction boundary. |
| [platform/development.ts](../src/platform/development.ts) | not started | |
| [platform/diagnostics/doctor.ts](../src/platform/diagnostics/doctor.ts) | not started | |
| [platform/diagnostics/task.ts](../src/platform/diagnostics/task.ts) | not started | |
| [platform/environment-settings.ts](../src/platform/environment-settings.ts) | not started | |
| [platform/executable-resolver.ts](../src/platform/executable-resolver.ts) | not started | |
| [platform/factory-reset.ts](../src/platform/factory-reset.ts) | not started | |
| [platform/frontend-development.ts](../src/platform/frontend-development.ts) | not started | `e555e83b`: built-asset watch/refresh and release embedding checks pass; no frontend helper rewrite. |
| [platform/health-contract.ts](../src/platform/health-contract.ts) | not started | |
| [platform/health.ts](../src/platform/health.ts) | not started | |
| [platform/host-health.ts](../src/platform/host-health.ts) | not started | |
| [platform/install/command.ts](../src/platform/install/command.ts) | not started | |
| [platform/install/stages.ts](../src/platform/install/stages.ts) | not started | |
| [platform/log-viewer.ts](../src/platform/log-viewer.ts) | not started | |
| [platform/logging.ts](../src/platform/logging.ts) | not started | |
| [platform/process-manager.ts](../src/platform/process-manager.ts) | not started | `rust/src/runtimes/process.rs` inspects live PID/start/argv/UID before each signal and stops proven groups. Ownership, reused/unsafe PID and missing-turn-record cases pass. Full process-manager integration remains pending. |
| [platform/runtime.ts](../src/platform/runtime.ts) | not started | |
| [platform/schemas.ts](../src/platform/schemas.ts) | not started | |
| [platform/setup.ts](../src/platform/setup.ts) | not started | |
| [platform/system-event-transport.ts](../src/platform/system-event-transport.ts) | not started | |
| [platform/system-events.ts](../src/platform/system-events.ts) | not started | |
| [platform/tailscale.ts](../src/platform/tailscale.ts) | not started | |
| [platform/ui.ts](../src/platform/ui.ts) | not started | `924c9efe`, `e555e83b`, `6631e45c`: sign-in shell, assets and ordinary page rendering tested, including desktop/narrow React boot. Health rendering remains pending. |
| [platform/updates/supervisor.ts](../src/platform/updates/supervisor.ts) | not started | |
| [platform/updates/update-client.ts](../src/platform/updates/update-client.ts) | not started | |
| [profiles/agent-profile-contracts.ts](../src/profiles/agent-profile-contracts.ts) | not started | |
| [profiles/agent-profiles.ts](../src/profiles/agent-profiles.ts) | ported | `f23bab60`: CRUD/duplicate/defaults, references, policy pruning/rollback, audit and CLI discovery tested. Typed stored-policy conversion passes isolated cleanup checks. |
| [profiles/model-pricing.ts](../src/profiles/model-pricing.ts) | not started | |
| [profiles/models-dev-catalog.ts](../src/profiles/models-dev-catalog.ts) | not started | |
| [profiles/provider-catalog.ts](../src/profiles/provider-catalog.ts) | not started | |
| [profiles/provider-connection.ts](../src/profiles/provider-connection.ts) | not started | |
| [profiles/provider-instances.ts](../src/profiles/provider-instances.ts) | not started | |
| [profiles/provider-login.ts](../src/profiles/provider-login.ts) | not started | |
| [profiles/provider-readiness.ts](../src/profiles/provider-readiness.ts) | not started | |
| [projects/contracts.ts](../src/projects/contracts.ts) | not started | |
| [projects/execution-configuration.ts](../src/projects/execution-configuration.ts) | not started | Typed stored configuration passes the 23-case corpus and project HTTP checks, including nested public finding paths and order. Full execution integration remains pending. |
| [projects/integration-configuration.ts](../src/projects/integration-configuration.ts) | not started | Typed stored configuration passes the 23-case corpus and project HTTP checks, including source Jira bounds and GitHub ASCII rules. Full delivery integration remains pending. |
| [projects/projects.ts](../src/projects/projects.ts) | not started | `035f253b`, `1e2b2f0c`: local/existing/new GitHub creation, configuration persistence, reads and HTTP tested. Typed DTO conversion passes isolated cleanup checks; other project operations remain deferred. |
| [projects/provider-policy.ts](../src/projects/provider-policy.ts) | not started | Typed stored policy replaces the special JSON representation and passes corpus/project/profile checks. Full task integration remains pending. |
| [projects/repository-commands.ts](../src/projects/repository-commands.ts) | not started | |
| [projects/repository-coordinate.ts](../src/projects/repository-coordinate.ts) | not started | GitHub coordinate/remote parsing covered by repository tests; full provider coverage remains incomplete |
| [projects/repository-inspection.ts](../src/projects/repository-inspection.ts) | not started | `09db91ae`: local GitHub inspection/preflight, real Git, controlled gh, path/buffer/timeout checks pass; other providers deferred. |
| [projects/repository-provisioning.ts](../src/projects/repository-provisioning.ts) | not started | `1e2b2f0c`: existing/new GitHub provisioning and admitted completion after HTTP disconnect tested; Bitbucket deferred. |
| [runtimes/claude-code/display.ts](../src/runtimes/claude-code/display.ts) | not started | |
| [runtimes/claude-code/environment.ts](../src/runtimes/claude-code/environment.ts) | not started | |
| [runtimes/claude-code/live-history.ts](../src/runtimes/claude-code/live-history.ts) | not started | |
| [runtimes/claude-code/session-reader.ts](../src/runtimes/claude-code/session-reader.ts) | not started | |
| [runtimes/claude-code/task-runtime.ts](../src/runtimes/claude-code/task-runtime.ts) | not started | |
| [runtimes/claude-code/transcript.ts](../src/runtimes/claude-code/transcript.ts) | not started | |
| [runtimes/codex/display.ts](../src/runtimes/codex/display.ts) | not started | |
| [runtimes/codex/session-reader.ts](../src/runtimes/codex/session-reader.ts) | not started | `rust/src/runtimes/codex/session_reader.rs` and thread recovery pass focused runtime checks. Real Codex and the complete NativeSessionReader remain pending. |
| [runtimes/codex/task-runtime.ts](../src/runtimes/codex/task-runtime.ts) | not started | `ce20b01e`: `rust/src/runtimes/codex` invocation, dispatch, observation and recovery helpers pass 17 focused checks. Its isolated staged export passes 75 library tests, three integration tests, locked fmt and all-target Clippy. Full TaskHarness, durable store binding, real Codex, bridges and UI remain pending. |
| [runtimes/codex/transcript.ts](../src/runtimes/codex/transcript.ts) | not started | `rust/src/runtimes/codex/transcript.rs` parsing, result text and completion evidence pass focused runtime checks. Real-provider verification remains pending. |
| [runtimes/devin/advisor-evidence.ts](../src/runtimes/devin/advisor-evidence.ts) | not started | |
| [runtimes/devin/display.ts](../src/runtimes/devin/display.ts) | not started | |
| [runtimes/devin/mcp-config.ts](../src/runtimes/devin/mcp-config.ts) | not started | |
| [runtimes/devin/session-reader.ts](../src/runtimes/devin/session-reader.ts) | not started | |
| [runtimes/devin/task-runtime.ts](../src/runtimes/devin/task-runtime.ts) | not started | |
| [runtimes/devin/transcript.ts](../src/runtimes/devin/transcript.ts) | not started | |
| [runtimes/harness-kind.ts](../src/runtimes/harness-kind.ts) | not started | |
| [runtimes/headless/turn-process.ts](../src/runtimes/headless/turn-process.ts) | not started | `rust/src/runtimes/headless.rs` detached claim-before-launch, source-shaped dispatch/exit records, process-group stop and missing-turn recovery pass with real short-lived children. Environment-only rediscovery after loss of all records is unproved on this Mac; the same-host TS scanner also missed the tagged child. No new record gate added. Durable store and real Codex integration remain pending. |
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
| [shared/json.ts](../src/shared/json.ts) | not started | `40eac0e1`: [hash bytes spike](spikes/rust-json-hash-bytes.md). Only Value-based stringify/ryu-js remains; seven hash fixtures pass, including finite large-number rounding. Document tree and raw-JSON machinery are removed. Four task hash call sites remain pending. |
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
| [tasks/queue.ts](../src/tasks/queue.ts) | not started | Task repository tests cover queued prerequisite admission and backlog start. Queue host/controller integration remains pending. |
| [tasks/repository.ts](../src/tasks/repository.ts) | not started | `rust/src/tasks/repository.rs` implements atomic task/control/dependency/audit creation and idempotent replay, plus internal start/admission mutations. Store tests cover replay, prerequisites, PR ownership conflict and budget pause. Wider metadata operations and task HTTP/authorization integration remain pending. |
| [tasks/sources.ts](../src/tasks/sources.ts) | not started | |
| [tasks/tasks.ts](../src/tasks/tasks.ts) | not started | |
| [tasks/templates.ts](../src/tasks/templates.ts) | not started | |
| [tasks/timeline/contracts.ts](../src/tasks/timeline/contracts.ts) | not started | |
| [tasks/timeline/timeline.ts](../src/tasks/timeline/timeline.ts) | not started | |
| [tasks/usage.ts](../src/tasks/usage.ts) | not started | |
| [tasks/worktree-open.ts](../src/tasks/worktree-open.ts) | not started | |
| [tasks/worktree.ts](../src/tasks/worktree.ts) | not started | |
