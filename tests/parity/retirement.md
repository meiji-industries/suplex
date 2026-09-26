# Test independence and coverage map

Status: in progress. This records the test-by-test deletion audit and remaining work. Baseline before retirement: 225 root test files, of which 7 are browser tests, 48 have frontend imports, 156 have backend imports, and 14 are tooling or fixture only (the categories were exclusive in the first pass; mixed frontend/backend imports are listed under backend). Rust baseline was 614 passed and 6 ignored before the oracle migrations.

| Retired TypeScript behavior | Native evidence and disposition |
| --- | --- |
| SQL migration ledger and access modes | `platform::database::tests::migrates_shared_sql_and_reopens_read_only`, `rejects_changed_sql_at_an_applied_timestamp`, `read_write_mode_does_not_apply_migrations`, and new `migrates_frozen_typescript_database_without_changing_its_history` (149 captured TS migrations, synthetic company, disposable Rust migration). Keep `tests/parity/typescript-database.sqlite` immutable. |
| Auth, passkey, session, recovery, OAuth | `http::routes::auth::tests::signed_fresh_passkey_over_isolated_tcp_listener`, `identity::ceremony::tests::signed_fresh_passkey_survives_reopen_and_updates_counter`, `http::routes::oauth::tests::discovery_registration_consent_pkce_rotation_replay_revocation_and_reapproval`, `denial_keeps_state_and_consent_needs_csrf_admin_and_session`. Browser auth and OAuth journeys now run against Rust. Recovery details still need a focused comparison against old tests. |
| Task creation, actions, authorization, idempotency | `http::routes::tasks::tests::local_backlog_create_fetches_git_and_returns_full_task_shape`, `tasks::commands::tests::live_authority_and_after_commit_wake_follow_task_start`, `http::routes::agent_api::tests::creation_is_idempotent_scoped_and_validated_and_dry_runs_write_nothing`, `lifecycle_commands_use_revisions_receipts_note_attribution_and_duplicate_provenance`. Browser task creation/start/answer/cancel/edit journeys now run against Rust. Frozen task-response fixture replaces the live oracle. |
| Task detail/history/timeline | New `http::routes::task_reads::tests::frozen_typescript_task_detail_responses_remain_compatible` checks exact activity/execution/diff summary responses from a TS-created fixture. `task_timeline` native route test covers scope and saved shape; native interop timeline journey is being rewritten. Live history oracle belongs to `frontend_contracts` agent. |
| Archive and Git/worktree safety | `tasks::archive::operations::tests::archive_uses_live_native_and_git_facts_then_commits_once`, `tasks::archive::displays::tests::archive_preserves_unrelated_and_unproven_panes`, `missing_or_unavailable_displays_never_block_archive`, `http::routes::task_worktree::tests::worktree_routes_require_a_direct_loopback_peer_and_the_configured_host`. Browser archive dirty-cleanup journey now runs against Rust. |
| Project creation and GitHub ownership | `http::routes::projects::tests::admitted_project_create_finishes_after_request_task_is_dropped`, `project_patch_replaces_or_patches_and_checks_git_only_for_repository_changes`, `projects::git` tests. Browser project creation has been rewired to Rust fixture, but native POST requires isolated provider credentials; this is the remaining browser gap. |
| Backup, install, recovery | `platform::backup::tests::backup_round_trip_excludes_authentication_and_verifies_artifacts`, `verification_rejects_tampered_and_unsafe_archives`, `http::routes::admin_platform::tests::administrators_create_list_download_and_restore_backups`; native lifecycle agent owns install/recover/supervisor tests. |
| Provider/runtime/delivery | Native `rust/src/runtimes/**`, `rust/src/delivery/tests.rs`, and `rust/tests/coordination/**` cover deterministic runtime and delivery behaviors. Individual old TS test cases still need an equivalence audit; no live provider or CI claim follows from local fixtures. |
| Explicit retirements | Forge upgrade CLI and `tests/upgrade-from-forge.test.ts` removed by approved plan. Placeholder unported route and old guarded TypeScript script tests removed after native replacements. |

Frozen fixtures: `tests/parity/routes.json` (222 Fastify method/path registrations), 1,164 Zod HTTP cases and 23 stored project cases (`generate.ts --check`), 7 JSON/hash byte cases (`hash-bytes/generate.ts --check`), 149-migration TS SQLite file, and task detail HTTP response/database/transcript. Route checker now reads its frozen fixture and has no TypeScript app import.

No Rust test starts Node or tsx as an oracle. Frozen fixtures now cover task reads, raw task responses, task agents, templates, history, Coordinator prompt/hash, and store behavior. The remaining TypeScript imports are in browser/interop helpers and standalone TypeScript tests listed below.

## Backend-importing TypeScript tests (deletion inventory)

These filenames import retired engine modules directly or through test helpers. Deletion awaits domain-by-domain native assertion review; frontend tests with mixed imports need rewiring instead. Exact current list, generated by scanning `tests/*.test.ts(x)` imports:

- `advisor-report.test.ts`
- `agent-api.test.ts`
- `agent-machine-discovery.integration.test.ts`
- `agent-merge-train.integration.test.ts`
- `agent-profiles.test.ts`
- `app.test.ts`
- `architecture-guardrails.test.ts`
- `artifacts.test.ts`
- `auth-api.test.ts`
- `auth-routes.test.ts`
- `auth.test.ts`
- `avatars-api.test.ts`
- `backup-api.test.ts`
- `backup-integrity.test.ts`
- `backup.test.ts`
- `bitbucket-evidence-upload.test.ts`
- `canonical-json.test.ts`
- `claude-code-display.test.ts`
- `claude-code-environment.test.ts`
- `claude-code-live-history.test.ts`
- `claude-code-runtime.test.ts`
- `claude-code-transcript.test.ts`
- `codex-analytics.test.ts`
- `codex-runtime.test.ts`
- `codex-transcript.test.ts`
- `command-runner.test.ts`
- `company-issue-code.test.ts`
- `completed-pull-request-hosts.test.ts`
- `config.test.ts`
- `coordinator-replacement-api.test.ts`
- `coordinator-replacement.test.ts`
- `database-after-commit.test.ts`
- `database.test.ts`
- `delivery-operations.test.ts`
- `development.test.ts`
- `devin-analytics.test.ts`
- `devin-runtime.test.ts`
- `diagnostics.test.ts`
- `discovery-artifacts.test.ts`
- `entrypoint.test.ts`
- `environment-settings-api.test.ts`
- `executable-resolver.test.ts`
- `external-agents-api.test.ts`
- `external-agents.test.ts`
- `factory-reset.test.ts`
- `git-fixture.test.ts`
- `git-test-environment.integration.test.ts`
- `github-delivery.test.ts`
- `github-pull-request-states.test.ts`
- `github-trigger-admission.test.ts`
- `github-trigger-dispatch-service.test.ts`
- `github-trigger-dispatches.test.ts`
- `github-trigger-inspection.test.ts`
- `github-trigger-paths.test.ts`
- `github-trigger-poller.test.ts`
- `github-triggers.test.ts`
- `health-refresh.test.ts`
- `health.test.ts`
- `herdr-client.test.ts`
- `herdr-readiness.test.ts`
- `herdr-terminal-bridge.test.ts`
- `host-dependencies.test.ts`
- `host-health.test.ts`
- `http-infrastructure.test.ts`
- `human-question.test.ts`
- `install-stages.test.ts`
- `issue-evidence-upload.test.ts`
- `issue-evidence-write-guards.test.ts`
- `issue-evidence.test.ts`
- `issue-image-intake.test.ts`
- `issue-timeline-events.test.ts`
- `logging.test.ts`
- `logs-viewer.test.ts`
- `migrations.test.ts`
- `models-dev-catalog.test.ts`
- `native-cutover-migration.test.ts`
- `native-tasks.test.ts`
- `new-task-dialog-blocked-by.test.tsx`
- `oauth-mcp.test.ts`
- `onboarding.test.ts`
- `opencode-attachment.test.ts`
- `opencode-client.test.ts`
- `opencode-dispatch-recovery.test.ts`
- `opencode-server.test.ts`
- `opencode-session-history.test.ts`
- `opencode-session.test.ts`
- `process-manager.test.ts`
- `project-details-model.test.ts`
- `project-integrations.test.ts`
- `project-mcp.test.ts`
- `projects-api.test.ts`
- `projects.real.test.ts`
- `projects.test.ts`
- `provider-catalog.test.ts`
- `provider-login-routes.test.ts`
- `provider-policy.test.ts`
- `provider-readiness.test.ts`
- `providers-api.test.ts`
- `recent-pull-request.test.ts`
- `redaction.test.ts`
- `root-bridge.test.ts`
- `root-controller-delegation.test.ts`
- `root-controller-lifecycle.test.ts`
- `root-controller-limits.test.ts`
- `root-controller-recovery.test.ts`
- `runtime-locators.test.ts`
- `runtime.test.ts`
- `schemas.test.ts`
- `self-update.integration.test.ts`
- `session-history.test.ts`
- `setup-view.test.ts`
- `setup.test.ts`
- `shared-resource-command.test.ts`
- `supervisor-packaged.test.ts`
- `suplex-guardrails.test.ts`
- `suplex-mcp-bridge.test.ts`
- `system-event-transport.test.ts`
- `system-events-api.test.ts`
- `system-events.test.ts`
- `system-health.test.ts`
- `task-activity.test.ts`
- `task-agent-selection.test.ts`
- `task-agent-status.test.ts`
- `task-archive-displays.real.test.ts`
- `task-archive-displays.test.ts`
- `task-archive-sessions.test.ts`
- `task-archive.test.ts`
- `task-blocked-by-property.test.tsx`
- `task-blocked-by.test.ts`
- `task-board-status-filter.test.tsx`
- `task-branch.test.ts`
- `task-continue-delivery-card.test.tsx`
- `task-creation-body-limit.test.ts`
- `task-data.test.tsx`
- `task-display-metadata.test.ts`
- `task-execution.test.ts`
- `task-history-live.test.ts`
- `task-host.test.ts`
- `task-inspection.test.ts`
- `task-issues.integration.test.ts`
- `task-limits.test.ts`
- `task-note-input.test.tsx`
- `task-pane-layout.test.ts`
- `task-pane-routes.test.ts`
- `task-preparation.test.ts`
- `task-properties-placement.test.tsx`
- `task-pull-request-ownership.test.ts`
- `task-pull-request-prerequisites.test.ts`
- `task-queue.test.ts`
- `task-queued-migration.test.ts`
- `task-role-prompt.test.ts`
- `task-row.test.ts`
- `task-session-history.test.ts`
- `task-sources.test.ts`
- `task-status.test.ts`
- `task-timeline.test.ts`
- `task-usage.test.ts`
- `task-work-diff-badge.test.tsx`
- `task-worktree-routes.test.ts`
- `task-worktree.test.ts`
- `tasks-api-creation.test.ts`
- `theme.test.ts`
- `timeline.test.ts`
- `update.test.ts`
- `webauthn-interop.test.ts`
- `worker-environment.test.ts`
- `worker-replacement-api.test.ts`
- `worker-replacement.test.ts`
- `worker-turn-evidence.test.ts`
- `workflows-delegation.test.ts`
- `workflows-delivery-repairs.test.ts`
- `workflows-delivery.test.ts`
- `workflows-intake.test.ts`
- `worktree-open.test.ts`

Count at this revision: 174.

## Retired task-only TypeScript tests

The following backend-only tests were removed after their distinct assertions were checked against native tests. Browser evidence refers to the seven-file Rust fixture suite (11 passing tests), not to external provider or CI verification.

| Removed TS test | Retained native assertion |
| --- | --- |
| `task-branch.test.ts` | `tasks::commands::tests::task_branch_names_preserve_frozen_typescript_title_rules` pins all six original exact branch strings. |
| `task-limits.test.ts` | `tasks::limits::tests::budget_and_turn_limits_match_frozen_typescript_cases` pins independent budget, turn, disabled, and unknown-spend cases; `coordination::host::tests::a_budget_suggestion_rounds_spend_plus_allowance` pins the four rounding cases. |
| `task-creation-body-limit.test.ts` | `routes::tasks::tests::local_backlog_create_fetches_git_and_returns_full_task_shape` checks large image admission and actionable 413 for over-limit requests. |
| `task-preparation.test.ts` | `tasks::preparation::tests::preparation_preserves_worktree_files_copies_skills_and_reruns_idempotent_setup`, `setup_only_inherits_non_secret_tooling_environment`, and `project_setup_runs_once_in_the_prepared_worktree_before_the_root_starts`. |
| `task-archive.test.ts` | `tasks::archive::operations::tests::archive_uses_live_native_and_git_facts_then_commits_once`, `tasks::archive::displays` tests, and `task-archive.browser.test.ts` cover branch retention, dirty confirmation, native sessions, display/process cleanup, and failed cleanup retry. |
| `task-worktree-routes.test.ts` | `routes::task_worktree::tests::worktree_routes_require_a_direct_loopback_peer_and_the_configured_host` and `opening_runs_the_resolved_launcher_and_audits_only_successful_launches` cover peer/host authority, launcher errors, and audit success only. |

The four one-shot TypeScript service oracle programs under `tests/support/task-{ui,agents,history,template}-read-interop.ts` were captured before deletion. Their checked-in SQLite/runtime inputs and exact normalized outputs are exercised by native Rust task-read, agent, history, and template tests under `rust/tests/routes/`; fixture provenance is adjacent to each `tests/parity/` corpus. No Rust test starts these programs.
