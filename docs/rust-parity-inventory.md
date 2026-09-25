# Rust parity inventory

Baseline: TypeScript backend at `a57a47f5` (2026-09-24). This is a development status record, never a runtime input. The implementation scope includes milestones 4a and 4b.

States: `not started` means no complete Rust equivalent; `ported` means implementation exists with verification outstanding; `verified` means the relevant parity and integration checks pass. Tests for a smaller helper do not verify its containing route or workflow. The [PRD](plans/2026-09-24-experimental-rust-backend.md) defines release criteria; keep completion and test evidence here.

The table lists all 238 backend TypeScript modules present at the baseline, including contracts, routes, and each provider adapter. Contract extractions already committed during M0 are tracked with their source rows; no further extraction is required. Shared SQL migrations remain unchanged. Inventory introduced in `ea44af63`.

Current sequence: complete one Codex Standard task through the UI with cancellation and restart recovery. High-level WebAuthn, typed live auth/project requests, detached process helpers, local Git2 worktrees and initial Root MCP operations are implemented. HTTP start/cancel, host scheduling, Worker completion and Standard local delivery pass integrated process/Git checks. Codex history updates, reconnect and shutdown pass the TS oracle; successful real Codex execution remains pending. The special JSON validators and raw-JSON/response-schema fixtures are removed; the hash serializer remains. Other API breadth and GitHub sign-in follow the first local task.

Request corpus: 1,141 fixtures across 95 request exports plus 23 stored-project cases across three exports. Implemented checks cover 522 cases across 43 schemas, all stored-project cases, seven hash fixtures, and separate task DTO checks for 60 TaskBody and nine TaskIdParams cases. Unused validators remain deferred with their routes. Unit evidence is recorded below; final commit snapshots use separate Cargo targets. The TypeScript full suite baseline is 1,613/1,623: seven failures reproduce at pre-port `a57a47f5`, and three Devin failures pass focused reruns. Hosted CI, packages, full task execution, switching, and the eight-hour run remain unverified.

`f59366a5`, `0f3f3065`: the [browser helper](../tests/helpers/native-browser.ts) supports `SUPLEX_BROWSER_BACKEND=rust` with an isolated listener, database and browser context; TypeScript remains the default. Its optional `preserveData` close mode now retains failed native-run fixtures. After that change the UI build, typecheck, targeted lint and all 11 default browser tests across seven files pass. The actual model-rejection fixture was preserved after observing that its native process group and Rust listener had exited. Successful Rust task journeys and normal native-process cleanup remain pending.

`ec13982e`: exact host/evidence/read source tree `b4acd01aaa32f9f4e666e1472dd4788ba3836e8a` passes 120 library tests, three integration tests, fmt and all-target Clippy. Four Node-backed tests are ignored by the default run; the two task-read/template oracles pass explicitly. The real MCP Worker-evidence/local-delivery comparison also passes. These compare complete parsed JSON with TypeScript on shared fixtures, not response-schema output. Actual UI create/start admitted a native Codex Root, but the signed-in ChatGPT account rejected `gpt-6-sol` with HTTP 400; the host persisted failure and moved the task to `waiting_human`. No real Worker or delivery was observed. A supported test-model choice, cancellation and full restart recovery remain pending.

| TypeScript source | Status | Rust equivalent and evidence |
|---|---|---|
| [app.ts](../src/app.ts) | not started | Cargo/CI, isolated startup, SQLite and sign-in assets pass local checks. `ec13982e` starts recovery after listener bind and drains in-flight work while retaining native sessions. History sockets now close with source code 1012 on shutdown. Full route wiring remains pending. |
| [cli.ts](../src/cli.ts) | not started | Real `mcp advisor` and `mcp root` dispatch run before installation/database/listener startup and pass staged-binary stdio probes. Other operational commands remain pending. |
| [coordination/advisor-evidence.ts](../src/coordination/advisor-evidence.ts) | not started | |
| [coordination/advisor-report-bridge.ts](../src/coordination/advisor-report-bridge.ts) | ported | `31ce45ae`: `rust/src/coordination/advisor_bridge.rs` passes 86 library tests, three integration tests, fmt and all-target Clippy; focused Advisor 4/4 and TS report 10/10 pass. Actual stdio checks cover token denial, initialize/list, invalid report without capture, exact valid result and 0600 file. Role/schema, JS trimming, numeric output and binding writer match source. Native Advisor launch composition remains pending. |
| [coordination/advisor-report.ts](../src/coordination/advisor-report.ts) | not started | `1c24c183`: existing schemas extracted with compatible exports and passing TypeScript checks; Rust service remains pending |
| [coordination/bridge-auth.ts](../src/coordination/bridge-auth.ts) | ported | `rust/src/coordination/bridge_auth.rs` validates source UUID grammar and compares original token bytes with `subtle::ConstantTimeEq`; no token values enter errors. Advisor and Root wrong-token stdio checks pass. Root bindings use private directories and 0600 files. |
| [coordination/controller-reports.ts](../src/coordination/controller-reports.ts) | not started | `tasks::worktree::observe_worktree` reads live Git HEAD and dirty state for Root observation. A real worktree check passes; it adds no comparison against saved branch intent. Report interpretation remains pending. |
| [coordination/coordinator-replacement-contracts.ts](../src/coordination/coordinator-replacement-contracts.ts) | not started | |
| [coordination/coordinator-replacement.ts](../src/coordination/coordinator-replacement.ts) | not started | |
| [coordination/human-question.ts](../src/coordination/human-question.ts) | not started | |
| [coordination/persistence/row-values.ts](../src/coordination/persistence/row-values.ts) | not started | |
| [coordination/persistence/session-operations.ts](../src/coordination/persistence/session-operations.ts) | not started | |
| [coordination/root-bridge.ts](../src/coordination/root-bridge.ts) | ported | `993e8dc`: actual staged binary opens the same SQLite controller directly and passes token denial, initialize/list, delegate, conflicting delegate, observe and ask-human checks. Detached handler cancellation cannot strand the tool-owner claim. Final unit passes 98 library tests, three integration tests, fmt, all-target Clippy and six focused Root tests; two Node signer tests remain explicitly ignored in this run. |
| [coordination/root-contracts.ts](../src/coordination/root-contracts.ts) | not started | Named Serde operation DTOs cover observe, Standard planned delegation and ask-human, including valid optional Advisor/candidate references. The advertised schema remains flat as in TS. Remaining operations follow their implementations. |
| [coordination/root-controller.ts](../src/coordination/root-controller.ts) | not started | Initial observe is deep-equal to the complete pinned TS result on the same database. Standard planned delegation, Worker evidence and local completion pass actual MCP checks; owner claims survive dropped handler futures. Lifecycle events and remaining workflows/operations are pending. |
| [coordination/root-session-store.ts](../src/coordination/root-session-store.ts) | not started | `76ff7e2b`: atomic Root/prompt admission passes detached launch, duplicate, reopen and prerequisite checks. Host integration adds terminal persistence, one Worker-result wake, Root failure questions and fenced requeue after authoritative recovery of an unknown dispatch. Turn IDs retain the source `msg_` format; broader recovery remains pending. |
| [coordination/session-recovery.ts](../src/coordination/session-recovery.ts) | not started | Standard recovery checks cover claim-before-launch crashes, admitted-child reopen without replay, native exit before terminal persistence, idempotent Worker receipt/wake and delivery retry. Cancellation after database reopen stops a real owned child. Real Codex recovery remains pending. TS also skips worktree cleanup when no outstanding session stops; that source lifecycle limitation is retained and unverified for escaped processes. |
| [coordination/task-agent-selection-contracts.ts](../src/coordination/task-agent-selection-contracts.ts) | not started | |
| [coordination/task-agent-selection.ts](../src/coordination/task-agent-selection.ts) | not started | |
| [coordination/worker-environment.ts](../src/coordination/worker-environment.ts) | not started | `51331fec`: `rust/src/runtimes/git_guard.rs` preserves guarded Git/GitHub commands, configured Git lookup, private executable files and cleanup. Real Git permits status and denies reset/branch deletion; a fake gh permits PR reads and denies mutation. The isolated staged unit passes 93 library tests, three integration tests, fmt and all-target Clippy. Full native launch composition remains pending. |
| [coordination/worker-replacement-contracts.ts](../src/coordination/worker-replacement-contracts.ts) | not started | |
| [coordination/worker-replacement.ts](../src/coordination/worker-replacement.ts) | not started | |
| [coordination/worker-turn-evidence.ts](../src/coordination/worker-turn-evidence.ts) | not started | `rust/src/coordination/worker_evidence.rs`: index, tail, head and cursor reads through actual MCP match complete TS results on the same database/native log. UTF-16 offsets are preserved; a slice splitting a surrogate pair uses replacement text under the documented lone-surrogate exception. |
| [coordination/workflow-evidence.ts](../src/coordination/workflow-evidence.ts) | not started | |
| [coordination/workflow-prompts.ts](../src/coordination/workflow-prompts.ts) | not started | Standard initial, planned Worker and Worker-result wake prompts match pinned TS bytes. Other workflows remain pending. |
| [coordination/workflow-records.ts](../src/coordination/workflow-records.ts) | not started | Seeded workflow listing and typed advisor serialization pass the cleanup's isolated Cargo and raw HTTP checks. CRUD remains deferred. |
| [coordination/workflows.ts](../src/coordination/workflows.ts) | not started | `1c24c183`: existing schemas extracted with compatible exports and passing TypeScript checks; next Rust work is limited to the Standard task slice |
| [delivery/agent-delivery.ts](../src/delivery/agent-delivery.ts) | not started | |
| [delivery/completed-pull-requests.ts](../src/delivery/completed-pull-requests.ts) | not started | |
| [delivery/failure.ts](../src/delivery/failure.ts) | not started | |
| [delivery/issue-evidence.ts](../src/delivery/issue-evidence.ts) | not started | |
| [delivery/operations.ts](../src/delivery/operations.ts) | not started | Standard `complete_local_work` observes actual Git branch/HEAD/dirty state, rechecks the tool owner and persists delivery through the store. Real Git/MCP checks reject the wrong expected HEAD and accept dirty local completion as TS does. GitHub and other delivery operations remain pending. |
| [delivery/publication.ts](../src/delivery/publication.ts) | not started | |
| [delivery/pull-reference.ts](../src/delivery/pull-reference.ts) | not started | |
| [delivery/pull-request-ownership.ts](../src/delivery/pull-request-ownership.ts) | not started | |
| [delivery/review.ts](../src/delivery/review.ts) | not started | |
| [delivery/target-capabilities.ts](../src/delivery/target-capabilities.ts) | not started | |
| [http/agent-api-runtime.ts](../src/http/agent-api-runtime.ts) | not started | |
| [http/contracts/agent-api.ts](../src/http/contracts/agent-api.ts) | not started | |
| [http/contracts/auth.ts](../src/http/contracts/auth.ts) | ported | `b43d8fa3`: named Serde/Garde requests replace the special JSON validators; the cleanup removes a net 3,132 Rust source lines. Request corpus and signed registration/sign-in pass after conversion. |
| [http/contracts/avatars.ts](../src/http/contracts/avatars.ts) | not started | |
| [http/contracts/common.ts](../src/http/contracts/common.ts) | not started | Live identity/company/admin bodies use named DTOs and public findings. Current request corpus passes; remaining schemas are deferred. |
| [http/contracts/github-triggers.ts](../src/http/contracts/github-triggers.ts) | not started | |
| [http/contracts/oauth.ts](../src/http/contracts/oauth.ts) | not started | |
| [http/contracts/projects.ts](../src/http/contracts/projects.ts) | not started | Typed project creation and nested configurations pass public findings and HTTP checks, including optional/null distinctions, source bounds, ASCII patterns and field ordering. Unused PATCH validation is deferred with its route. |
| [http/contracts/providers.ts](../src/http/contracts/providers.ts) | ported | `88bb9b9d`: nine validators pass the ordinary corpus; provider runtime/HTTP integration remains unverified. |
| [http/contracts/system-events.ts](../src/http/contracts/system-events.ts) | not started | |
| [http/contracts/task-templates.ts](../src/http/contracts/task-templates.ts) | not started | Named stored-template DTO normalization preserves source strictness, defaults, trimming and optional fields. The same-DB GET oracle and strict unknown/null checks pass. Mutation contracts remain pending. |
| [http/contracts/tasks.ts](../src/http/contracts/tasks.ts) | not started | `112a64e6`: named create and task-ID DTOs pass all 60 TaskBody and nine TaskIdParams fixtures, including public findings, IssueAssociation rules, UTF-16 bounds and integral numbers. Create/list/detail now return a named response with full raw-body TS equality on a shared fixture database. Other commands remain pending. |
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
| [http/routes/task-templates.ts](../src/http/routes/task-templates.ts) | not started | GET returns source-ordered, normalized stored templates and matches complete TS JSON/status on the same database. Invalid strict stored configuration returns the source 500. CRUD remains pending. |
| [http/routes/task-worktree.ts](../src/http/routes/task-worktree.ts) | not started | |
| [http/routes/tasks.ts](../src/http/routes/tasks.ts) | not started | `bf426610`: local create/list/detail raw TCP bodies match TS on the same database. `ec13982e` adds start and activity/execution reads; `cf1bfad` adds Codex history/live. Start and cancel now persist intent without requiring an attached host; focused HTTP checks pass. Immediate create, answers, other commands and GitHub diff summary remain pending. |
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
| [platform/executable-resolver.ts](../src/platform/executable-resolver.ts) | not started | Codex lookup reuses configured executable discovery and passes focused path/override checks. Other executable resolvers remain pending. |
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
| [profiles/model-pricing.ts](../src/profiles/model-pricing.ts) | ported | `rust/src/profiles/model_pricing.rs` preserves token/cache pricing and invalid-value handling. Formula and cumulative-usage checks pass. Host integration persists native usage: a priced million-token fixture records $1 with source fields; missing native logs cannot erase saved snapshots. |
| [profiles/models-dev-catalog.ts](../src/profiles/models-dev-catalog.ts) | ported | The models.dev reader uses JSON, a five-second timeout and no redirects. Local HTTP checks cover shared requests, successful caching and retry after failure. Parser checks preserve provider/model keys and optional cache rates. |
| [profiles/provider-catalog.ts](../src/profiles/provider-catalog.ts) | not started | |
| [profiles/provider-connection.ts](../src/profiles/provider-connection.ts) | not started | |
| [profiles/provider-instances.ts](../src/profiles/provider-instances.ts) | not started | |
| [profiles/provider-login.ts](../src/profiles/provider-login.ts) | not started | |
| [profiles/provider-readiness.ts](../src/profiles/provider-readiness.ts) | not started | |
| [projects/contracts.ts](../src/projects/contracts.ts) | not started | |
| [projects/execution-configuration.ts](../src/projects/execution-configuration.ts) | not started | Typed stored configuration passes the 23-case corpus and project HTTP checks, including nested public finding paths and order. Full execution integration remains pending. |
| [projects/integration-configuration.ts](../src/projects/integration-configuration.ts) | not started | Typed stored configuration passes the 23-case corpus and project HTTP checks, including source Jira bounds and GitHub ASCII rules. Full delivery integration remains pending. |
| [projects/projects.ts](../src/projects/projects.ts) | not started | `035f253b`, `1e2b2f0c`: creation, configuration persistence, reads and HTTP tested; typed DTO conversion passes. Git2 task-base capture now checks live origin, fetches the base branch and reads its refreshed SHA; real bare-origin/stale-ref/host checks pass. Credentials and other project operations remain pending. |
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
| [runtimes/codex/session-reader.ts](../src/runtimes/codex/session-reader.ts) | not started | Native turn filenames follow the observed Node lexical order; a reversed-mtime two-turn TS oracle proves the difference. Usage retains source msg-ID/legacy-mtime chronology. Codex history page/live tests pass; remaining native observation and real-provider success remain pending. |
| [runtimes/codex/task-runtime.ts](../src/runtimes/codex/task-runtime.ts) | not started | `d00a50ca`: Root and planned Worker adapters compose executable lookup, prompts, guards, bindings and durable claim-before-spawn. Fake CLI checks cover launch refusal, child capabilities and separate persisted/native/thread identities. Final isolated unit passes 106 library tests, three integration tests, fmt and all-target Clippy; two Node signer tests are ignored in this run. Full host, real Codex and UI remain pending. |
| [runtimes/codex/transcript.ts](../src/runtimes/codex/transcript.ts) | not started | Parsing, result text, completion, cumulative usage and native tool projection pass focused checks. The Worker-evidence MCP oracle matches TS on the same transcript, including stripped file-change extras and source web-search status handling. Real-provider verification remains pending. |
| [runtimes/devin/advisor-evidence.ts](../src/runtimes/devin/advisor-evidence.ts) | not started | |
| [runtimes/devin/display.ts](../src/runtimes/devin/display.ts) | not started | |
| [runtimes/devin/mcp-config.ts](../src/runtimes/devin/mcp-config.ts) | not started | |
| [runtimes/devin/session-reader.ts](../src/runtimes/devin/session-reader.ts) | not started | |
| [runtimes/devin/task-runtime.ts](../src/runtimes/devin/task-runtime.ts) | not started | |
| [runtimes/devin/transcript.ts](../src/runtimes/devin/transcript.ts) | not started | |
| [runtimes/harness-kind.ts](../src/runtimes/harness-kind.ts) | not started | |
| [runtimes/headless/turn-process.ts](../src/runtimes/headless/turn-process.ts) | not started | Detached claim-before-launch, dispatch/exit records, group stop and missing-turn recovery pass with real children. Child environment replacement, project settings, Mise trust and final credential exclusions follow source order. Environment-only rediscovery after loss of all records is unproved on this Mac; the same-host TS scanner also missed the tagged child. Real Codex/controller integration remains pending. |
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
| [runtimes/task-harness.ts](../src/runtimes/task-harness.ts) | not started | `e38b0718`: removal of stale bridge capabilities and actual child isolation pass. Native adapters now compose configured project context, prepared context and the source missing-file fallback. Full provider routing and controller integration remain pending. |
| [server.ts](../src/server.ts) | not started | |
| [shared/abort-signal.ts](../src/shared/abort-signal.ts) | not started | |
| [shared/assert-never.ts](../src/shared/assert-never.ts) | not started | |
| [shared/canonical-json.ts](../src/shared/canonical-json.ts) | not started | |
| [shared/entrypoint.ts](../src/shared/entrypoint.ts) | not started | |
| [shared/ids.ts](../src/shared/ids.ts) | not started | |
| [shared/json.ts](../src/shared/json.ts) | not started | `40eac0e1`: [hash bytes spike](spikes/rust-json-hash-bytes.md). Only Value-based stringify/ryu-js remains; seven hash fixtures pass. Document tree and raw-JSON machinery are removed. The task-create hash is connected; the remaining three task hash sites await their commands. |
| [shared/mcp-stdio.ts](../src/shared/mcp-stdio.ts) | not started | |
| [tasks/agent-status.ts](../src/tasks/agent-status.ts) | not started | |
| [tasks/analytics/analytics.ts](../src/tasks/analytics/analytics.ts) | not started | |
| [tasks/analytics/collector.ts](../src/tasks/analytics/collector.ts) | not started | |
| [tasks/analytics/contracts.ts](../src/tasks/analytics/contracts.ts) | not started | |
| [tasks/analytics/metrics.ts](../src/tasks/analytics/metrics.ts) | not started | |
| [tasks/analytics/store.ts](../src/tasks/analytics/store.ts) | not started | |
| [tasks/archive/displays.ts](../src/tasks/archive/displays.ts) | not started | |
| [tasks/archive/processes.ts](../src/tasks/archive/processes.ts) | ported | Task worktree cleanup checks actual process ownership; real macOS child and absent/symlinked path tests pass. Missing worktree paths follow source lexical resolution and marker rules. Missing/stale launch-owner metadata cannot block independently proven native stop; the source zero-outstanding-session lifecycle limitation remains. |
| [tasks/archive/sessions.ts](../src/tasks/archive/sessions.ts) | not started | |
| [tasks/branch.ts](../src/tasks/branch.ts) | not started | |
| [tasks/contracts.ts](../src/tasks/contracts.ts) | not started | |
| [tasks/control.ts](../src/tasks/control.ts) | not started | Cancel persists task status and Root/Worker stop intent atomically, then wakes recovery after commit. A dropped request does not cancel admitted durable work. Broader control operations remain pending. |
| [tasks/dependencies.ts](../src/tasks/dependencies.ts) | not started | |
| [tasks/duplicate-title.ts](../src/tasks/duplicate-title.ts) | not started | |
| [tasks/execution/contracts.ts](../src/tasks/execution/contracts.ts) | not started | |
| [tasks/execution/execution.ts](../src/tasks/execution/execution.ts) | not started | |
| [tasks/execution/pane-layout.ts](../src/tasks/execution/pane-layout.ts) | not started | |
| [tasks/execution/role-prompt.ts](../src/tasks/execution/role-prompt.ts) | not started | Native Standard Root and planned implementation/verification Worker prompts use source text. Direct-build and other workflow roles remain pending. |
| [tasks/history/contracts.ts](../src/tasks/history/contracts.ts) | ported | Named query parsing preserves cursor bounds and public findings; cursor checks and the actual HTTP/WebSocket oracle pass. No response validators were introduced. |
| [tasks/history/history.ts](../src/tasks/history/history.ts) | not started | Codex page messages and ordering match complete TS JSON on the same database and native logs. Other providers remain pending. |
| [tasks/history/live.ts](../src/tasks/history/live.ts) | not started | `cf1bfad`: exact source tree `512810366944c05328ed989245498c4bd167759a` passes 123 library tests (five ignored), three integrations, fmt and all-target Clippy. Explicit same-DB TS oracle checks page, initial snapshot, appended-turn update and reconnect; both open Rust sockets close 1012 `server closing`. TS checks and source peer pass. Other providers and system-event telemetry remain pending. |
| [tasks/history/read.ts](../src/tasks/history/read.ts) | not started | Codex session reads preserve live task scope and native output; the HTTP/WebSocket oracle passes. Other providers remain pending. |
| [tasks/host.ts](../src/tasks/host.ts) | not started | `ec13982e` ports Standard scheduling, admission, terminal routing and local delivery. Cancellation/restart source tree `53cab56e1ce74fb0ecdb6c23d3d8bd17618e62ef` passes 124 library tests (five ignored), three integrations, fmt and all-target Clippy. Focused host 5/5, HTTP 1/1, command/store and real owned-process cleanup checks pass. Actual successful Codex task/restart/cancel remain pending. |
| [tasks/images.ts](../src/tasks/images.ts) | not started | |
| [tasks/inspection.ts](../src/tasks/inspection.ts) | not started | |
| [tasks/integration.ts](../src/tasks/integration.ts) | not started | |
| [tasks/issue-association.ts](../src/tasks/issue-association.ts) | not started | |
| [tasks/issue-context.ts](../src/tasks/issue-context.ts) | not started | |
| [tasks/limits/attachment-limits.ts](../src/tasks/limits/attachment-limits.ts) | not started | |
| [tasks/limits/limit-observer.ts](../src/tasks/limits/limit-observer.ts) | not started | Host admission observes and prices native Codex usage, honors max-turn/budget short circuits and atomically replaces usage snapshots. Missing native logs leave saved usage intact and prevent treating unknown spend as zero, matching source behavior. Other providers remain pending. |
| [tasks/limits/limit-store.ts](../src/tasks/limits/limit-store.ts) | not started | |
| [tasks/limits/limits.ts](../src/tasks/limits/limits.ts) | not started | |
| [tasks/preparation.ts](../src/tasks/preparation.ts) | not started | |
| [tasks/pull-request-dependencies.ts](../src/tasks/pull-request-dependencies.ts) | not started | |
| [tasks/queue.ts](../src/tasks/queue.ts) | not started | Task repository tests cover queued prerequisite admission and backlog start. Queue host/controller integration remains pending. |
| [tasks/repository.ts](../src/tasks/repository.ts) | not started | Atomic task/control/dependency/audit creation and replay are connected to local create/read HTTP. Prepared task IDs also determine the branch suffix. The first persisted request hash uses JS-compatible stringify and source field order; seven pinned TS hash cases pass. Wider metadata operations and the remaining three hash sites remain pending. |
| [tasks/sources.ts](../src/tasks/sources.ts) | not started | |
| [tasks/tasks.ts](../src/tasks/tasks.ts) | not started | Local create/start/cancel preserve authorization, audit and transaction/after-commit boundaries. Start/cancel accept durable intent without an attached host; native cleanup follows ownership evidence after restart. Immediate create, answers and other commands remain pending. |
| [tasks/templates.ts](../src/tasks/templates.ts) | not started | GET reads and normalizes stored configurations with named DTOs; ordered/default/trim/optional-field behavior matches TS on a shared database. Mutations remain pending. |
| [tasks/timeline/contracts.ts](../src/tasks/timeline/contracts.ts) | not started | |
| [tasks/timeline/timeline.ts](../src/tasks/timeline/timeline.ts) | not started | |
| [tasks/usage.ts](../src/tasks/usage.ts) | not started | |
| [tasks/worktree-open.ts](../src/tasks/worktree-open.ts) | not started | |
| [tasks/worktree.ts](../src/tasks/worktree.ts) | not started | `7986a84f`: Git2 create/dirty/reopen/stale-registration/symlink checks pass without a new existing-path branch gate. Delivery now reads actual branch, HEAD, tree and dirty state; the real Git check passes. Remote missing-commit fetch, credentials, removal and full controller/delivery remain pending. Git2/libssh2 and WebAuthn still bring native OpenSSL dependencies. |
