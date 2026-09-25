# Rust parity inventory

Baseline: TypeScript backend at `a57a47f5` (2026-09-24). This is a development status record, never a runtime input. The implementation scope includes milestones 4a and 4b.

States: `not started` means no complete Rust equivalent; `ported` means implementation exists with verification outstanding; `verified` means the relevant parity and integration checks pass. Tests for a smaller helper do not verify its containing route or workflow. The [PRD](plans/2026-09-24-experimental-rust-backend.md) defines release criteria; keep completion and test evidence here.

The table lists all 238 backend TypeScript modules present at the baseline (117 not started, 109 ported, 12 verified), including contracts, routes, and each provider adapter. Contract extractions already committed during M0 are tracked with their source rows; no further extraction is required. Shared SQL migrations remain unchanged. Inventory introduced in `ea44af63`.

Current sequence: follow the work packages in [the Rust backend 9/10 plan](plans/2026-09-25-rust-backend-to-nine.md).

Request corpus: 1,141 fixtures across 95 request exports in `tests/parity/`; `rust/tests/contract_parity.rs` checks every schema that Rust implements.

| TypeScript source | Status | Rust equivalent and evidence |
|---|---|---|
| [app.ts](../src/app.ts) | ported | `rust/src/http/mod.rs` (`router`) and `rust/src/main.rs`; routes without a port return 501. Test: `committed_callback_can_reenter_shared_database`. |
| [cli.ts](../src/cli.ts) | ported | `rust/src/main.rs` dispatches `mcp advisor` and `mcp root` only; other commands are absent. |
| [coordination/advisor-evidence.ts](../src/coordination/advisor-evidence.ts) | not started | |
| [coordination/advisor-report-bridge.ts](../src/coordination/advisor-report-bridge.ts) | ported | `rust/src/coordination/advisor_bridge.rs`; native Advisor launch is absent. Test: `mcp_stdio_transport_lists_and_calls_the_assigned_tool`. |
| [coordination/advisor-report.ts](../src/coordination/advisor-report.ts) | ported | `validate_submission` in `rust/src/coordination/advisor_bridge.rs`; report parsing from turns is absent. Test: `advisor_submission_checks_role_and_recommendation_before_capture`. |
| [coordination/bridge-auth.ts](../src/coordination/bridge-auth.ts) | verified | `rust/src/coordination/bridge_auth.rs`. Tests: `token_binding_requires_exact_uuid_without_exposing_it`, `tests/interop/root-worker-evidence.ts`. |
| [coordination/controller-reports.ts](../src/coordination/controller-reports.ts) | ported | `observe_worktree` in `rust/src/tasks/worktree.rs`; Advisor report resolution is absent. Test: `prepares_and_reobserves_a_real_local_git_worktree`. |
| [coordination/coordinator-replacement-contracts.ts](../src/coordination/coordinator-replacement-contracts.ts) | verified | `rust/src/http/contracts/typed/tasks.rs`. Test: `task_coordinator_replacement_matches_public_zod_contract`. |
| [coordination/coordinator-replacement.ts](../src/coordination/coordinator-replacement.ts) | ported | `replace_coordinator` in `rust/src/coordination/root_session_store.rs`; Standard Codex only. Test: `worker_and_coordinator_replacement_preserve_handoffs_and_native_readiness`. |
| [coordination/human-question.ts](../src/coordination/human-question.ts) | ported | `HumanOption` in `rust/src/coordination/root_stdio.rs` validates `ask_human` options. |
| [coordination/persistence/row-values.ts](../src/coordination/persistence/row-values.ts) | ported | `parse_json` in `rust/src/tasks/response.rs`; `text` and `integer` use rusqlite row accessors. |
| [coordination/persistence/session-operations.ts](../src/coordination/persistence/session-operations.ts) | ported | Claim, prompt and requeue operations in `rust/src/coordination/root_session_store.rs`. Test: `committed_claim_survives_reopen_and_budget_pause_never_dispatches`. |
| [coordination/root-bridge.ts](../src/coordination/root-bridge.ts) | verified | `rust/src/coordination/root_bridge.rs`. Tests: `root_binding_tracks_current_identity_and_reuses_valid_token`, `tests/interop/root-worker-evidence.ts`. |
| [coordination/root-contracts.ts](../src/coordination/root-contracts.ts) | ported | `rust/src/coordination/root_stdio.rs`; Standard operations only. Test: `advertised_kinds_are_only_the_implemented_standard_operations`. |
| [coordination/root-controller.ts](../src/coordination/root-controller.ts) | ported | `rust/src/coordination/root_controller.rs`; Standard workflow only. Tests: `worker_evidence_reads_only_the_admitted_native_turn`, `tests/interop/root-image.ts`. |
| [coordination/root-session-store.ts](../src/coordination/root-session-store.ts) | ported | `rust/src/coordination/root_session_store.rs`; Standard workflow only, no status-event or analytics hooks. Test: `human_note_reuses_root_and_resumes_delivered_intent_without_replay`. |
| [coordination/session-recovery.ts](../src/coordination/session-recovery.ts) | ported | Recovery in `rust/src/tasks/host.rs`. Tests: `root_dispatch_claim_survives_reopen_without_replaying_child`, `mise run test:journey:rust` (restart phase). |
| [coordination/task-agent-selection-contracts.ts](../src/coordination/task-agent-selection-contracts.ts) | verified | `rust/src/http/contracts/typed/tasks.rs`. Test: `task_agent_selection_request_fixtures_match_public_zod_contract`. |
| [coordination/task-agent-selection.ts](../src/coordination/task-agent-selection.ts) | ported | `select_user_task_agent` in `rust/src/tasks/commands.rs`. Test: `agent_selection_starts_a_coordinator_and_records_a_worker_profile`. |
| [coordination/worker-environment.ts](../src/coordination/worker-environment.ts) | ported | `rust/src/runtimes/git_guard.rs`. Test: `guarded_git_allows_observation_and_blocks_destructive_operations`. |
| [coordination/worker-replacement-contracts.ts](../src/coordination/worker-replacement-contracts.ts) | verified | `rust/src/http/contracts/typed/tasks.rs`. Test: `task_worker_replacement_matches_public_zod_contract`. |
| [coordination/worker-replacement.ts](../src/coordination/worker-replacement.ts) | ported | `replace_worker` in `rust/src/coordination/root_controller.rs` and `root_session_store.rs`; Standard Codex only. Test: `tests/interop/root-worker-replacement.ts`. |
| [coordination/worker-turn-evidence.ts](../src/coordination/worker-turn-evidence.ts) | verified | `rust/src/coordination/worker_evidence.rs`. Tests: `selected_tail_and_head_cursors_preserve_native_failure_text`, `tests/interop/root-worker-evidence.ts`. |
| [coordination/workflow-evidence.ts](../src/coordination/workflow-evidence.ts) | not started | |
| [coordination/workflow-prompts.ts](../src/coordination/workflow-prompts.ts) | ported | `rust/src/coordination/root_prompts.rs`; Standard prompts only. Test: `standard_worker_wake_matches_pinned_typescript_bytes`. |
| [coordination/workflow-records.ts](../src/coordination/workflow-records.ts) | ported | `rust/src/coordination/workflow_records.rs`; list only, CRUD returns 501. Test: `seeded_list_applies_archive_filter_after_query_validation_and_session`. |
| [coordination/workflows.ts](../src/coordination/workflows.ts) | not started | Only Standard is hard-coded in `rust/src/tasks/host.rs`; other workflows return 501. |
| [delivery/agent-delivery.ts](../src/delivery/agent-delivery.ts) | not started | |
| [delivery/completed-pull-requests.ts](../src/delivery/completed-pull-requests.ts) | not started | |
| [delivery/failure.ts](../src/delivery/failure.ts) | ported | `DeliveryOperationFailure` in `rust/src/delivery/operations.rs`. |
| [delivery/issue-evidence.ts](../src/delivery/issue-evidence.ts) | not started | |
| [delivery/operations.ts](../src/delivery/operations.ts) | ported | `rust/src/delivery/operations.rs`; Standard local completion only. Test: `standard_completion_uses_actual_branch_and_head_without_a_clean_tree_gate`. |
| [delivery/publication.ts](../src/delivery/publication.ts) | not started | |
| [delivery/pull-reference.ts](../src/delivery/pull-reference.ts) | not started | |
| [delivery/pull-request-ownership.ts](../src/delivery/pull-request-ownership.ts) | ported | `assert_pull_request_available` in `rust/src/tasks/repository.rs`. |
| [delivery/review.ts](../src/delivery/review.ts) | ported | `rust/src/delivery/inspection.rs`; pull request ranges are absent. Test: `tests/interop/root-delivery-inspection.ts`. |
| [delivery/target-capabilities.ts](../src/delivery/target-capabilities.ts) | not started | |
| [http/agent-api-runtime.ts](../src/http/agent-api-runtime.ts) | not started | |
| [http/contracts/agent-api.ts](../src/http/contracts/agent-api.ts) | not started | |
| [http/contracts/auth.ts](../src/http/contracts/auth.ts) | verified | `rust/src/http/contracts/typed/auth.rs`. Test: `ported_contracts_match_zod_fixtures` (all five schemas). |
| [http/contracts/avatars.ts](../src/http/contracts/avatars.ts) | not started | |
| [http/contracts/common.ts](../src/http/contracts/common.ts) | ported | `rust/src/http/contracts/common.rs` and `common_commands.rs`. Test: `ported_contracts_match_zod_fixtures`. |
| [http/contracts/github-triggers.ts](../src/http/contracts/github-triggers.ts) | not started | |
| [http/contracts/oauth.ts](../src/http/contracts/oauth.ts) | not started | |
| [http/contracts/projects.ts](../src/http/contracts/projects.ts) | ported | `rust/src/http/contracts/typed/projects.rs` and `project_aux.rs`. Test: `serde_dtos_project_all_accepted_project_request_fixtures`. |
| [http/contracts/providers.ts](../src/http/contracts/providers.ts) | ported | `rust/src/http/contracts/providers.rs`; provider routes return 501. Test: `ported_contracts_match_zod_fixtures`. |
| [http/contracts/system-events.ts](../src/http/contracts/system-events.ts) | not started | |
| [http/contracts/task-templates.ts](../src/http/contracts/task-templates.ts) | ported | `rust/src/http/contracts/typed/task_templates.rs`; mutation contracts are absent. Test: `stored_configuration_defaults_and_rejects_extra_keys`. |
| [http/contracts/tasks.ts](../src/http/contracts/tasks.ts) | ported | `rust/src/http/contracts/typed/tasks.rs`, `typed/task_answers.rs` and `task_aux.rs`. Test: `task_create_request_fixtures_match_public_zod_contract`. |
| [http/contracts/update.ts](../src/http/contracts/update.ts) | not started | |
| [http/contracts/workflows.ts](../src/http/contracts/workflows.ts) | ported | List query and `WorkflowRecord` in `rust/src/coordination/workflow_records.rs`; CRUD contracts are absent. |
| [http/errors.ts](../src/http/errors.ts) | ported | `rust/src/http/validation.rs`. Test: `public_findings_keep_issue_order_and_paths`. |
| [http/oauth-runtime.ts](../src/http/oauth-runtime.ts) | not started | |
| [http/routes/administration.ts](../src/http/routes/administration.ts) | ported | `rust/src/http/routes/admin_identity.rs` and `profiles.rs`; environment, backups, factory reset, providers and models return 501. Test: `invitation_body_validation_precedes_csrf_and_admin_routes_preserve_raw_order`. |
| [http/routes/agent-api.ts](../src/http/routes/agent-api.ts) | not started | |
| [http/routes/agent-pairing.ts](../src/http/routes/agent-pairing.ts) | not started | |
| [http/routes/assets.ts](../src/http/routes/assets.ts) | ported | `/assets/{filename}` in `rust/src/http/mod.rs` with `rust/src/platform/embedded.rs`. Test: `bundled_frontend_entry_is_readable_when_built`. |
| [http/routes/auth.ts](../src/http/routes/auth.ts) | ported | `rust/src/http/routes/auth.rs`. Tests: `status_cookie_and_sign_out_follow_existing_order`, `signed_fresh_passkey_over_isolated_tcp_listener` (ignored by default). |
| [http/routes/authenticated.ts](../src/http/routes/authenticated.ts) | not started | 501 stub. |
| [http/routes/avatars.ts](../src/http/routes/avatars.ts) | not started | 501 stub. |
| [http/routes/companies.ts](../src/http/routes/companies.ts) | ported | `rust/src/http/routes/companies.rs`. Test: `company_routes_apply_live_user_and_membership_scope`. |
| [http/routes/discovery.ts](../src/http/routes/discovery.ts) | not started | |
| [http/routes/external-agent-administration.ts](../src/http/routes/external-agent-administration.ts) | not started | |
| [http/routes/github-triggers.ts](../src/http/routes/github-triggers.ts) | not started | 501 stub. |
| [http/routes/health.ts](../src/http/routes/health.ts) | not started | 501 stub. |
| [http/routes/mcp.ts](../src/http/routes/mcp.ts) | not started | |
| [http/routes/oauth.ts](../src/http/routes/oauth.ts) | not started | 501 stub for the consent API; `/oauth/*` endpoints are absent. |
| [http/routes/pages.ts](../src/http/routes/pages.ts) | verified | `rust/src/http/routes/pages.rs`. Tests: `root_and_application_pages_follow_live_session_and_project_state`, `tests/task-detail.browser.test.ts` with `SUPLEX_BROWSER_BACKEND=rust`. |
| [http/routes/projects.ts](../src/http/routes/projects.ts) | ported | `rust/src/http/routes/projects.rs`; issues, task sources and models return 501. Test: `project_reads_serialize_normalized_configuration_and_enforce_scope`. |
| [http/routes/provider-login.ts](../src/http/routes/provider-login.ts) | not started | 501 stub. |
| [http/routes/task-pane.ts](../src/http/routes/task-pane.ts) | not started | 501 stub. |
| [http/routes/task-templates.ts](../src/http/routes/task-templates.ts) | ported | `rust/src/http/routes/task_templates.rs`; list only, other routes return 501. Test: `stored_configuration_defaults_and_rejects_extra_keys`. |
| [http/routes/task-worktree.ts](../src/http/routes/task-worktree.ts) | not started | 501 stub. |
| [http/routes/tasks.ts](../src/http/routes/tasks.ts) | ported | `rust/src/http/routes/tasks.rs`, `task_reads.rs`, `task_history.rs`, `task_timeline.rs`, `task_agents.rs` and `task_artifacts.rs`; checks, refresh, analytics, task costs and company timeline return 501. Tests: `tests/task-detail.browser.test.ts`, `tests/task-archive.browser.test.ts` with `SUPLEX_BROWSER_BACKEND=rust`. |
| [http/routes/update.ts](../src/http/routes/update.ts) | not started | 501 stub. |
| [http/routes/workflows.ts](../src/http/routes/workflows.ts) | ported | `rust/src/http/routes/workflows.rs`; list only, admin CRUD returns 501. Test: `seeded_list_applies_archive_filter_after_query_validation_and_session`. |
| [http/session.ts](../src/http/session.ts) | ported | `rust/src/http/session.rs`. Test: `session_lookup_keeps_trusted_sign_in_before_legacy_rollover`. |
| [identity/auth-contracts.ts](../src/identity/auth-contracts.ts) | ported | Types in `rust/src/identity/auth.rs`, `admin.rs`, `ceremony.rs` and `companies.rs`. |
| [identity/auth-identifiers.ts](../src/identity/auth-identifiers.ts) | ported | `new_session_token` in `rust/src/identity/auth.rs`; cookie and header names in `rust/src/http/session.rs`. |
| [identity/auth-repository.ts](../src/identity/auth-repository.ts) | ported | Queries are inline in `rust/src/identity/auth.rs`, `admin.rs`, `ceremony.rs` and `companies.rs`. Test: `session_lookup_development_sign_in_sign_out_and_legacy_rollover`. |
| [identity/auth-schema.ts](../src/identity/auth-schema.ts) | ported | Tables come from the shared SQL migrations that `rust/src/platform/database.rs` applies. Test: `migrates_shared_sql_and_reopens_read_only`. |
| [identity/auth-webauthn.ts](../src/identity/auth-webauthn.ts) | verified | `rust/src/identity/webauthn.rs` and `ceremony.rs`. Test: `signed_fresh_passkey_survives_reopen_and_updates_counter` (ignored by default; run manually). |
| [identity/auth.ts](../src/identity/auth.ts) | ported | `rust/src/identity/auth.rs`, `admin.rs` and `companies.rs`. Test: `session_lookup_development_sign_in_sign_out_and_legacy_rollover`. |
| [identity/avatar-kinds.ts](../src/identity/avatar-kinds.ts) | not started | |
| [identity/avatars.ts](../src/identity/avatars.ts) | not started | |
| [identity/external-agents.ts](../src/identity/external-agents.ts) | not started | |
| [identity/oauth.ts](../src/identity/oauth.ts) | not started | |
| [identity/registration.ts](../src/identity/registration.ts) | ported | `begin_registration` and `complete_registration` in `rust/src/identity/ceremony.rs`. Test: `signed_fresh_passkey_survives_reopen_and_updates_counter` (ignored by default). |
| [integrations/bitbucket.ts](../src/integrations/bitbucket.ts) | not started | |
| [integrations/github/client.ts](../src/integrations/github/client.ts) | ported | `rust/src/integrations/github.rs`. Test: `current_user_and_encoded_branch_use_token_backed_api`. |
| [integrations/github/delivery.ts](../src/integrations/github/delivery.ts) | ported | `published_branch_sha` and `current_user_login` in `rust/src/integrations/github.rs` port `getBranchHead` and `checkAuthentication` only; pull request operations are absent. Test: `current_user_and_encoded_branch_use_token_backed_api`. |
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
| [platform/artifacts.ts](../src/platform/artifacts.ts) | ported | `rust/src/platform/artifacts.rs`; task images only. Tests: `task_image_file_and_row_share_commit_and_rollback_cleanup`, `tests/interop/root-image.ts`. |
| [platform/backup.ts](../src/platform/backup.ts) | not started | 501 stub. |
| [platform/command-runner.ts](../src/platform/command-runner.ts) | ported | Bounded subprocess execution in `rust/src/projects/repository.rs`; no shared runner. Test: `subprocess_output_and_timeout_match_git_adapter_limits`. |
| [platform/config.ts](../src/platform/config.ts) | ported | `rust/src/platform/config.rs`. Test: `paths_stay_under_experimental_root`. |
| [platform/database.ts](../src/platform/database.ts) | verified | `rust/src/platform/database.rs`. Test: `opens_typescript_database_and_creates_reverse_fixture_when_requested`. |
| [platform/development.ts](../src/platform/development.ts) | not started | |
| [platform/diagnostics/doctor.ts](../src/platform/diagnostics/doctor.ts) | not started | |
| [platform/diagnostics/task.ts](../src/platform/diagnostics/task.ts) | not started | |
| [platform/environment-settings.ts](../src/platform/environment-settings.ts) | not started | 501 stub. |
| [platform/executable-resolver.ts](../src/platform/executable-resolver.ts) | ported | Codex only in `rust/src/runtimes/codex/executable.rs`; Git in `rust/src/runtimes/git_guard.rs`. Test: `override_path_precedes_path_and_home_and_requires_executable_file`. |
| [platform/factory-reset.ts](../src/platform/factory-reset.ts) | not started | 501 stub. |
| [platform/frontend-development.ts](../src/platform/frontend-development.ts) | ported | Development asset refresh in `rust/src/http/mod.rs`. Test: `development_assets_refresh_without_restarting_the_server`. |
| [platform/health-contract.ts](../src/platform/health-contract.ts) | not started | |
| [platform/health.ts](../src/platform/health.ts) | not started | 501 stub. |
| [platform/host-health.ts](../src/platform/host-health.ts) | not started | |
| [platform/install/command.ts](../src/platform/install/command.ts) | not started | |
| [platform/install/stages.ts](../src/platform/install/stages.ts) | not started | |
| [platform/log-viewer.ts](../src/platform/log-viewer.ts) | not started | |
| [platform/logging.ts](../src/platform/logging.ts) | ported | `redact` only, as `rust/src/platform/redaction.rs`. Test: `masks_synthetic_token_and_assignment_in_command_output`. |
| [platform/process-manager.ts](../src/platform/process-manager.ts) | ported | `rust/src/runtimes/process.rs`. Test: `only_exact_process_identity_allows_owned_signal`. |
| [platform/runtime.ts](../src/platform/runtime.ts) | not started | `rust/src/main.rs` starts directly; supervisor and registry reconciliation are absent. |
| [platform/schemas.ts](../src/platform/schemas.ts) | not started | |
| [platform/setup.ts](../src/platform/setup.ts) | not started | |
| [platform/system-event-transport.ts](../src/platform/system-event-transport.ts) | not started | |
| [platform/system-events.ts](../src/platform/system-events.ts) | ported | `rust/src/platform/system_events.rs` (`install`, `enabled`, `emit`); event context is absent. |
| [platform/tailscale.ts](../src/platform/tailscale.ts) | not started | |
| [platform/ui.ts](../src/platform/ui.ts) | ported | `application_page` in `rust/src/http/ui.rs`; the health page is absent. Test: `application_shell_uses_the_page_view_and_built_assets`. |
| [platform/updates/supervisor.ts](../src/platform/updates/supervisor.ts) | not started | |
| [platform/updates/update-client.ts](../src/platform/updates/update-client.ts) | not started | 501 stub. |
| [profiles/agent-profile-contracts.ts](../src/profiles/agent-profile-contracts.ts) | ported | `rust/src/http/contracts/profile.rs`. Test: `profile_validation_precedes_origin_and_session_checks`. |
| [profiles/agent-profiles.ts](../src/profiles/agent-profiles.ts) | ported | `rust/src/profiles/agent_profiles.rs`. Test: `profile_commands_keep_role_visibility_references_and_audit_atomic`. |
| [profiles/model-pricing.ts](../src/profiles/model-pricing.ts) | ported | `rust/src/profiles/model_pricing.rs`. Test: `parses_valid_prices_and_uses_source_cost_formula`. |
| [profiles/models-dev-catalog.ts](../src/profiles/models-dev-catalog.ts) | ported | `rust/src/profiles/model_pricing.rs`. Test: `catalog_read_shares_inflight_request_and_retries_failure`. |
| [profiles/provider-catalog.ts](../src/profiles/provider-catalog.ts) | not started | 501 stub. |
| [profiles/provider-connection.ts](../src/profiles/provider-connection.ts) | not started | |
| [profiles/provider-instances.ts](../src/profiles/provider-instances.ts) | ported | `list_provider_instances` in `rust/src/projects/service.rs`; instance CRUD returns 501. |
| [profiles/provider-login.ts](../src/profiles/provider-login.ts) | not started | 501 stub. |
| [profiles/provider-readiness.ts](../src/profiles/provider-readiness.ts) | not started | |
| [projects/contracts.ts](../src/projects/contracts.ts) | ported | `ProjectFailure` in `rust/src/projects/service.rs`. |
| [projects/execution-configuration.ts](../src/projects/execution-configuration.ts) | ported | Typed stored configuration in `rust/src/http/contracts/typed/projects.rs`. Test: `stored_project_nested_schemas_match_zod`. |
| [projects/integration-configuration.ts](../src/projects/integration-configuration.ts) | ported | Typed stored configuration in `rust/src/http/contracts/typed/projects.rs`; credential keys are excluded in `rust/src/tasks/host.rs`. Test: `stored_project_nested_schemas_match_zod`. |
| [projects/projects.ts](../src/projects/projects.ts) | ported | `rust/src/projects/service.rs`. Test: `local_create_audits_once_and_reads_follow_live_membership`. |
| [projects/provider-policy.ts](../src/projects/provider-policy.ts) | ported | `allowed_profile` in `rust/src/tasks/commands.rs`. |
| [projects/repository-commands.ts](../src/projects/repository-commands.ts) | ported | `infer_commands` in `rust/src/projects/provisioning.rs`. Test: `repository_commands_follow_mise_then_cargo_and_make_selection_order`. |
| [projects/repository-coordinate.ts](../src/projects/repository-coordinate.ts) | ported | `rust/src/projects/repository.rs`. Test: `repository_coordinates_preserve_host_and_reject_credentials`. |
| [projects/repository-inspection.ts](../src/projects/repository-inspection.ts) | ported | `rust/src/projects/repository.rs`; GitHub only. Test: `local_inspection_fetches_origin_and_checks_github_identity`. |
| [projects/repository-provisioning.ts](../src/projects/repository-provisioning.ts) | ported | `rust/src/projects/provisioning.rs`; GitHub only. Test: `admitted_project_create_finishes_after_request_task_is_dropped`. |
| [runtimes/claude-code/display.ts](../src/runtimes/claude-code/display.ts) | not started | |
| [runtimes/claude-code/environment.ts](../src/runtimes/claude-code/environment.ts) | not started | |
| [runtimes/claude-code/live-history.ts](../src/runtimes/claude-code/live-history.ts) | not started | |
| [runtimes/claude-code/session-reader.ts](../src/runtimes/claude-code/session-reader.ts) | not started | |
| [runtimes/claude-code/task-runtime.ts](../src/runtimes/claude-code/task-runtime.ts) | not started | |
| [runtimes/claude-code/transcript.ts](../src/runtimes/claude-code/transcript.ts) | not started | |
| [runtimes/codex/display.ts](../src/runtimes/codex/display.ts) | not started | |
| [runtimes/codex/session-reader.ts](../src/runtimes/codex/session-reader.ts) | ported | `rust/src/runtimes/codex/session_reader.rs`. Test: `reads_native_history_without_changing_it`. |
| [runtimes/codex/task-runtime.ts](../src/runtimes/codex/task-runtime.ts) | ported | `rust/src/runtimes/codex/task_runtime.rs`, `runtime.rs`, `invocation.rs` and `thread.rs`. Tests: `root_binding_and_guard_reach_child_only_after_claim`, `mise run test:journey:rust`. |
| [runtimes/codex/transcript.ts](../src/runtimes/codex/transcript.ts) | ported | `rust/src/runtimes/codex/transcript.rs`, `tool_evidence.rs` and `usage.rs`. Tests: `source_transcript_sample_projects_exact_tool_rows`, `tests/interop/root-worker-evidence.ts`. |
| [runtimes/devin/advisor-evidence.ts](../src/runtimes/devin/advisor-evidence.ts) | not started | |
| [runtimes/devin/display.ts](../src/runtimes/devin/display.ts) | not started | |
| [runtimes/devin/mcp-config.ts](../src/runtimes/devin/mcp-config.ts) | not started | |
| [runtimes/devin/session-reader.ts](../src/runtimes/devin/session-reader.ts) | not started | |
| [runtimes/devin/task-runtime.ts](../src/runtimes/devin/task-runtime.ts) | not started | |
| [runtimes/devin/transcript.ts](../src/runtimes/devin/transcript.ts) | not started | |
| [runtimes/harness-kind.ts](../src/runtimes/harness-kind.ts) | ported | `HarnessKind` in `rust/src/http/contracts/providers.rs`, `project_aux.rs` and `task_aux.rs`. |
| [runtimes/headless/turn-process.ts](../src/runtimes/headless/turn-process.ts) | ported | `rust/src/runtimes/headless.rs`. Test: `claim_precedes_detached_launch_and_record_uses_source_shape`. |
| [runtimes/opencode/client.ts](../src/runtimes/opencode/client.ts) | not started | |
| [runtimes/opencode/contracts.ts](../src/runtimes/opencode/contracts.ts) | not started | |
| [runtimes/opencode/providers.ts](../src/runtimes/opencode/providers.ts) | not started | |
| [runtimes/opencode/server.ts](../src/runtimes/opencode/server.ts) | not started | |
| [runtimes/opencode/session-history.ts](../src/runtimes/opencode/session-history.ts) | not started | |
| [runtimes/opencode/session-reader.ts](../src/runtimes/opencode/session-reader.ts) | not started | |
| [runtimes/opencode/session.ts](../src/runtimes/opencode/session.ts) | not started | |
| [runtimes/opencode/task-runtime.ts](../src/runtimes/opencode/task-runtime.ts) | not started | |
| [runtimes/project-environment.ts](../src/runtimes/project-environment.ts) | ported | Project scope in `rust/src/tasks/host.rs`. Test: `project_scope_keeps_context_and_excludes_credential_references`. |
| [runtimes/project-mcp.ts](../src/runtimes/project-mcp.ts) | not started | |
| [runtimes/task-display.ts](../src/runtimes/task-display.ts) | not started | |
| [runtimes/task-harness-registry.ts](../src/runtimes/task-harness-registry.ts) | ported | `rust/src/tasks/host.rs` routes `codex` profiles to `rust/src/runtimes/codex`; other providers are not ported. |
| [runtimes/task-harness.ts](../src/runtimes/task-harness.ts) | ported | `rust/src/runtimes/task_harness.rs`. Test: `detached_child_receives_only_its_current_bridge_capability`. |
| [server.ts](../src/server.ts) | ported | `rust/src/main.rs` binds the listener, starts recovery and shuts down gracefully. |
| [shared/abort-signal.ts](../src/shared/abort-signal.ts) | not started | |
| [shared/assert-never.ts](../src/shared/assert-never.ts) | not started | |
| [shared/canonical-json.ts](../src/shared/canonical-json.ts) | not started | |
| [shared/entrypoint.ts](../src/shared/entrypoint.ts) | not started | |
| [shared/ids.ts](../src/shared/ids.ts) | not started | |
| [shared/json.ts](../src/shared/json.ts) | ported | `serde_json` replaces `json` and `jsonRequired`; `rust/src/shared/js_json.rs` reproduces `JSON.stringify` bytes. Test: `persisted_hash_bytes_match_json_stringify`. |
| [shared/mcp-stdio.ts](../src/shared/mcp-stdio.ts) | ported | rmcp stdio in `rust/src/coordination/root_stdio.rs` and `advisor_bridge.rs`. Test: `mcp_stdio_transport_lists_and_calls_the_assigned_tool`. |
| [tasks/agent-status.ts](../src/tasks/agent-status.ts) | ported | `rust/src/http/routes/task_agents.rs`; Codex only. Test: `same_database_agent_reads_match_typescript_and_refresh_native_state` (ignored by default; needs Node). |
| [tasks/analytics/analytics.ts](../src/tasks/analytics/analytics.ts) | not started | 501 stub. |
| [tasks/analytics/collector.ts](../src/tasks/analytics/collector.ts) | not started | |
| [tasks/analytics/contracts.ts](../src/tasks/analytics/contracts.ts) | not started | |
| [tasks/analytics/metrics.ts](../src/tasks/analytics/metrics.ts) | not started | |
| [tasks/analytics/store.ts](../src/tasks/analytics/store.ts) | not started | |
| [tasks/archive/displays.ts](../src/tasks/archive/displays.ts) | not started | |
| [tasks/archive/processes.ts](../src/tasks/archive/processes.ts) | ported | `rust/src/tasks/archive/processes.rs`. Test: `cancellation_stops_live_worktree_process_without_a_display_receipt`. |
| [tasks/archive/sessions.ts](../src/tasks/archive/sessions.ts) | ported | `archive_sessions_idle` in `rust/src/tasks/archive/operations.rs`; Codex only. Tests: `archive_uses_live_native_and_git_facts_then_commits_once`, `tests/task-archive.browser.test.ts`. |
| [tasks/branch.ts](../src/tasks/branch.ts) | ported | `task_branch_name` in `rust/src/tasks/commands.rs`. |
| [tasks/contracts.ts](../src/tasks/contracts.ts) | ported | `rust/src/tasks/response.rs` and `rust/src/http/contracts/typed/mod.rs`. |
| [tasks/control.ts](../src/tasks/control.ts) | ported | Control, session and turn rows are read in `rust/src/coordination/root_session_store.rs`. |
| [tasks/dependencies.ts](../src/tasks/dependencies.ts) | ported | `set_user_task_dependencies` in `rust/src/tasks/commands.rs`. Test: `dependency_replacement_rejects_cycles_and_admits_a_released_queued_task`. |
| [tasks/duplicate-title.ts](../src/tasks/duplicate-title.ts) | not started | |
| [tasks/execution/contracts.ts](../src/tasks/execution/contracts.ts) | ported | `execution_document` in `rust/src/http/routes/task_reads.rs`. |
| [tasks/execution/execution.ts](../src/tasks/execution/execution.ts) | ported | `/api/tasks/{task_id}/execution` in `rust/src/http/routes/task_reads.rs`. Test: `task_detail_reads_follow_live_scope_and_saved_native_intent`. |
| [tasks/execution/pane-layout.ts](../src/tasks/execution/pane-layout.ts) | not started | |
| [tasks/execution/role-prompt.ts](../src/tasks/execution/role-prompt.ts) | ported | `rust/src/runtimes/codex/role_prompt.rs`; Standard roles only. |
| [tasks/history/contracts.ts](../src/tasks/history/contracts.ts) | ported | `rust/src/http/routes/task_history.rs`. Test: `history_cursor_query_uses_public_zod_findings`. |
| [tasks/history/history.ts](../src/tasks/history/history.ts) | ported | `rust/src/http/routes/task_history.rs`; Codex only. Test: `page_cursor_and_live_delta_follow_native_message_ids`. |
| [tasks/history/live.ts](../src/tasks/history/live.ts) | ported | `rust/src/http/routes/task_history.rs`; Codex only. Test: `same_database_history_page_and_live_snapshot_match_typescript` (ignored by default; needs Node). |
| [tasks/history/read.ts](../src/tasks/history/read.ts) | ported | `rust/src/http/routes/task_history.rs` with `rust/src/runtimes/codex/session_reader.rs`; Codex only. |
| [tasks/host.ts](../src/tasks/host.ts) | ported | `rust/src/tasks/host.rs`; Standard Codex only. Tests: `root_dispatch_claim_survives_reopen_without_replaying_child`, `mise run test:journey:rust`. |
| [tasks/images.ts](../src/tasks/images.ts) | verified | `rust/src/tasks/images.rs`. Tests: `decoder_rejects_noncanonical_padding_wrong_type_magic_and_decoded_oversize`, `tests/interop/root-image.ts`. |
| [tasks/inspection.ts](../src/tasks/inspection.ts) | ported | Diff and diff summary in `rust/src/http/routes/task_reads.rs`; checks return 501. |
| [tasks/integration.ts](../src/tasks/integration.ts) | not started | |
| [tasks/issue-association.ts](../src/tasks/issue-association.ts) | ported | `IssueAssociation` in `rust/src/http/contracts/typed/tasks.rs`. Test: `issue_link_clears_locally_and_reports_tracker_reads_as_not_ported`. |
| [tasks/issue-context.ts](../src/tasks/issue-context.ts) | not started | |
| [tasks/limits/attachment-limits.ts](../src/tasks/limits/attachment-limits.ts) | verified | Limits in `rust/src/tasks/images.rs`. Test: `decoder_rejects_noncanonical_padding_wrong_type_magic_and_decoded_oversize`. |
| [tasks/limits/limit-observer.ts](../src/tasks/limits/limit-observer.ts) | ported | Usage observation in `rust/src/tasks/host.rs`; Codex only. Test: `recovery_resumes_a_limit_pause_once_usage_is_within_limits`. |
| [tasks/limits/limit-store.ts](../src/tasks/limits/limit-store.ts) | ported | `answer_task_limit` and `reconcile_task_limit_pause` in `rust/src/coordination/root_session_store.rs`. |
| [tasks/limits/limits.ts](../src/tasks/limits/limits.ts) | ported | `task_limit_question` in `rust/src/coordination/root_session_store.rs`. |
| [tasks/preparation.ts](../src/tasks/preparation.ts) | not started | Only the preparation directory path is reproduced in `rust/src/tasks/host.rs`; the setup command does not run. |
| [tasks/pull-request-dependencies.ts](../src/tasks/pull-request-dependencies.ts) | ported | `PullRequestDependency` in `rust/src/http/contracts/typed/tasks.rs`, stored by `rust/src/tasks/repository.rs`. |
| [tasks/queue.ts](../src/tasks/queue.ts) | ported | `admit_queued` in `rust/src/coordination/root_session_store.rs`. Test: `scheduler_tick_admits_a_queued_task_whose_blocker_cleared`. |
| [tasks/repository.ts](../src/tasks/repository.ts) | ported | `rust/src/tasks/repository.rs`. Tests: `local_backlog_create_fetches_git_and_returns_full_task_shape`, `standard_request_hash_matches_typescript_parsed_request`. |
| [tasks/sources.ts](../src/tasks/sources.ts) | not started | 501 stub. |
| [tasks/tasks.ts](../src/tasks/tasks.ts) | ported | `rust/src/tasks/commands.rs`; Standard workflow only. Test: `live_authority_and_after_commit_wake_follow_task_start`. |
| [tasks/templates.ts](../src/tasks/templates.ts) | ported | `rust/src/tasks/templates.rs`; list only. |
| [tasks/timeline/contracts.ts](../src/tasks/timeline/contracts.ts) | ported | `rust/src/http/routes/task_timeline.rs`; company timeline returns 501. Test: `tests/interop/task-timeline.ts`. |
| [tasks/timeline/timeline.ts](../src/tasks/timeline/timeline.ts) | ported | `rust/src/tasks/timeline.rs`; company timeline returns 501. Tests: `native_overlay_and_missing_record_preserve_saved_timing`, `tests/interop/task-timeline.ts`. |
| [tasks/usage.ts](../src/tasks/usage.ts) | ported | `rust/src/runtimes/codex/usage.rs`; Codex only. Test: `cumulative_native_thread_usage_uses_dispatched_model_and_optional_pricing`. |
| [tasks/worktree-open.ts](../src/tasks/worktree-open.ts) | not started | 501 stub. |
| [tasks/worktree.ts](../src/tasks/worktree.ts) | ported | `rust/src/tasks/worktree.rs`. Tests: `prepares_and_reobserves_a_real_local_git_worktree`, `tests/task-archive.browser.test.ts`. |
