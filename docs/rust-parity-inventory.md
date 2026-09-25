# Rust parity inventory

Baseline: TypeScript backend at `a57a47f5` (2026-09-24). This is a development status record, never a runtime input. The implementation scope includes milestones 4a and 4b.

States: `not started` means no complete Rust equivalent; `ported` means implementation exists with verification outstanding; `verified` means the relevant parity and integration checks pass. Tests for a smaller helper do not verify its containing route or workflow. The [PRD](plans/2026-09-24-experimental-rust-backend.md) defines release criteria; keep completion and test evidence here.

The table lists all 238 backend TypeScript modules present at the baseline (10 not started, 158 ported, 70 verified), including contracts, routes, and each provider adapter. Contract extractions already committed during M0 are tracked with their source rows; no further extraction is required. Shared SQL migrations remain unchanged. Inventory introduced in `ea44af63`.

Current sequence: the next phase is [the Rust polish brief](plans/2026-09-25-rust-polish-brief.md).

Request corpus: 1,141 fixtures across 95 request exports in `tests/parity/`; `rust/tests/contract_parity.rs` checks every schema that Rust implements.

| TypeScript source | Status | Rust equivalent and evidence |
|---|---|---|
| [app.ts](../src/app.ts) | ported | `rust/src/http/mod.rs` (`router`) and `rust/src/main.rs`; `scripts/rust-route-coverage.ts` finds every TypeScript route registered. Test: `committed_callback_can_reenter_shared_database`. |
| [cli.ts](../src/cli.ts) | ported | `rust/src/cli.rs` and `rust/src/main.rs` dispatch serve, help, migrate, doctor, task, backup, verify-backup, restore, logs and mcp. Test: `doctor_reports_schema_references_health_and_waiting_tasks`. |
| [coordination/advisor-evidence.ts](../src/coordination/advisor-evidence.ts) | verified | `rust/src/coordination/advisor_evidence.rs`. Test: `mise run test:journey:rust` (independent_review phase). |
| [coordination/advisor-report-bridge.ts](../src/coordination/advisor-report-bridge.ts) | verified | `rust/src/coordination/advisor_bridge.rs`. Tests: `mcp_stdio_transport_lists_and_calls_the_assigned_tool`, `mise run test:journey:rust` (independent_review phase). |
| [coordination/advisor-report.ts](../src/coordination/advisor-report.ts) | verified | `rust/src/coordination/advisor_bridge.rs`. Test: `structured_submissions_outrank_prose_and_error_envelopes`. |
| [coordination/bridge-auth.ts](../src/coordination/bridge-auth.ts) | verified | `rust/src/coordination/bridge_auth.rs`. Tests: `token_binding_requires_exact_uuid_without_exposing_it`, `tests/interop/root-worker-evidence.ts`. |
| [coordination/controller-reports.ts](../src/coordination/controller-reports.ts) | ported | `observe_worktree` in `rust/src/tasks/worktree.rs`; Advisor report resolution in `rust/src/coordination/root_controller.rs` and `advisor_evidence.rs`. Test: `prepares_and_reobserves_a_real_local_git_worktree`. |
| [coordination/coordinator-replacement-contracts.ts](../src/coordination/coordinator-replacement-contracts.ts) | verified | `rust/src/http/contracts/typed/tasks.rs`. Test: `task_coordinator_replacement_matches_public_zod_contract`. |
| [coordination/coordinator-replacement.ts](../src/coordination/coordinator-replacement.ts) | ported | `replace_coordinator` in `rust/src/coordination/root_session_store.rs`; Standard Codex only. Test: `worker_and_coordinator_replacement_preserve_handoffs_and_native_readiness`. |
| [coordination/human-question.ts](../src/coordination/human-question.ts) | ported | `HumanOption` in `rust/src/coordination/root_stdio.rs` validates `ask_human` options. |
| [coordination/persistence/row-values.ts](../src/coordination/persistence/row-values.ts) | ported | `parse_json` in `rust/src/tasks/response.rs`; `text` and `integer` use rusqlite row accessors. |
| [coordination/persistence/session-operations.ts](../src/coordination/persistence/session-operations.ts) | ported | Claim, prompt and requeue operations in `rust/src/coordination/root_session_store.rs`. Test: `committed_claim_survives_reopen_and_budget_pause_never_dispatches`. |
| [coordination/root-bridge.ts](../src/coordination/root-bridge.ts) | verified | `rust/src/coordination/root_bridge.rs`. Tests: `root_binding_tracks_current_identity_and_reuses_valid_token`, `tests/interop/root-worker-evidence.ts`. |
| [coordination/root-contracts.ts](../src/coordination/root-contracts.ts) | ported | `rust/src/coordination/root_stdio.rs`, including Advisor, planner, Direct and verification delegation. Tests: `advertised_kinds_match_the_root_tool_contract`, `advisor_and_planner_requests_follow_the_root_tool_contract`. |
| [coordination/root-controller.ts](../src/coordination/root-controller.ts) | ported | `rust/src/coordination/root_controller.rs`; all workflows. Tests: `worker_evidence_reads_only_the_admitted_native_turn`, `mise run test:journey:rust` (direct_build, independent_review and competing_plans phases). |
| [coordination/root-session-store.ts](../src/coordination/root-session-store.ts) | ported | `rust/src/coordination/root_session_store.rs`; all workflows. Tests: `human_note_reuses_root_and_resumes_delivered_intent_without_replay`, `planner_pair_reserves_both_roles_and_wakes_coordinator_once_both_settle`. |
| [coordination/session-recovery.ts](../src/coordination/session-recovery.ts) | ported | `rust/src/coordination/session_recovery.rs` and recovery in `rust/src/tasks/host.rs`. Tests: `a_failed_reviewer_turn_records_an_invalid_review_and_wakes_coordinator`, `mise run test:journey:rust` (restart phase). |
| [coordination/task-agent-selection-contracts.ts](../src/coordination/task-agent-selection-contracts.ts) | verified | `rust/src/http/contracts/typed/tasks.rs`. Test: `task_agent_selection_request_fixtures_match_public_zod_contract`. |
| [coordination/task-agent-selection.ts](../src/coordination/task-agent-selection.ts) | ported | `select_user_task_agent` in `rust/src/tasks/commands.rs`. Test: `agent_selection_starts_a_coordinator_and_records_a_worker_profile`. |
| [coordination/worker-environment.ts](../src/coordination/worker-environment.ts) | ported | `rust/src/runtimes/git_guard.rs`. Test: `guarded_git_allows_observation_and_blocks_destructive_operations`. |
| [coordination/worker-replacement-contracts.ts](../src/coordination/worker-replacement-contracts.ts) | verified | `rust/src/http/contracts/typed/tasks.rs`. Test: `task_worker_replacement_matches_public_zod_contract`. |
| [coordination/worker-replacement.ts](../src/coordination/worker-replacement.ts) | ported | `replace_worker` in `rust/src/coordination/root_controller.rs` and `root_session_store.rs`; Standard Codex only. Test: `tests/interop/root-worker-replacement.ts`. |
| [coordination/worker-turn-evidence.ts](../src/coordination/worker-turn-evidence.ts) | verified | `rust/src/coordination/worker_evidence.rs`. Tests: `selected_tail_and_head_cursors_preserve_native_failure_text`, `tests/interop/root-worker-evidence.ts`. |
| [coordination/workflow-evidence.ts](../src/coordination/workflow-evidence.ts) | verified | `rust/src/coordination/workflow_evidence.rs`. Test: `evidence_is_published_complete_and_any_change_breaks_verification`. |
| [coordination/workflow-prompts.ts](../src/coordination/workflow-prompts.ts) | verified | `rust/src/coordination/root_prompts.rs`. Test: `workflow_prompts_match_pinned_typescript_bytes`. |
| [coordination/workflow-records.ts](../src/coordination/workflow-records.ts) | verified | `rust/src/coordination/workflow_records.rs`. Test: `workflow_api_edits_default_agents_validates_them_and_archives`. |
| [coordination/workflows.ts](../src/coordination/workflows.ts) | verified | `rust/src/coordination/workflows.rs`. Tests: `delivery_decision_names_the_first_unsafe_condition`, `mise run test:journey:rust` (competing_plans phase). |
| [delivery/agent-delivery.ts](../src/delivery/agent-delivery.ts) | ported | `rust/src/delivery/agent_delivery.rs`. Test: `merge_blocker_reports_reasons_in_source_order`. |
| [delivery/completed-pull-requests.ts](../src/delivery/completed-pull-requests.ts) | ported | `rust/src/delivery/completed_pull_requests.rs`; GitHub only. |
| [delivery/failure.ts](../src/delivery/failure.ts) | ported | `DeliveryOperationFailure` in `rust/src/delivery/operations.rs`. |
| [delivery/issue-evidence.ts](../src/delivery/issue-evidence.ts) | ported | `rust/src/delivery/issue_evidence.rs`. Test: `evidence_manifest_is_strict_and_defaults_screenshots`. |
| [delivery/operations.ts](../src/delivery/operations.ts) | verified | `rust/src/delivery/operations.rs`; Bitbucket delivery returns 501. Tests: `standard_task_pushes_and_opens_a_draft_pull_request`, `local_workflow_completion_requires_the_review_for_the_exact_range`, `mise run test:journey:rust` (deliver_pr phase). |
| [delivery/publication.ts](../src/delivery/publication.ts) | verified | Publication in `rust/src/delivery/operations.rs`. Test: `standard_task_pushes_and_opens_a_draft_pull_request`. |
| [delivery/pull-reference.ts](../src/delivery/pull-reference.ts) | ported | `rust/src/delivery/operations.rs`. |
| [delivery/pull-request-ownership.ts](../src/delivery/pull-request-ownership.ts) | ported | `assert_pull_request_available` in `rust/src/tasks/repository.rs`. |
| [delivery/review.ts](../src/delivery/review.ts) | ported | `rust/src/delivery/inspection.rs`, including review equivalence and pull request base ranges. Test: `tests/interop/root-delivery-inspection.ts`. |
| [delivery/target-capabilities.ts](../src/delivery/target-capabilities.ts) | ported | `supports_delivery_target` in `rust/src/delivery/operations.rs`. Test: `target_capabilities_and_titles_match_source_schemas`. |
| [http/agent-api-runtime.ts](../src/http/agent-api-runtime.ts) | ported | `rust/src/http/agent_api_runtime.rs`. Test: `runtime_task_codes_follow_the_typescript_mapping`. |
| [http/contracts/agent-api.ts](../src/http/contracts/agent-api.ts) | verified | `rust/src/http/contracts/typed/agent_api.rs`. Test: `agent_api_request_fixtures_match_public_zod_contracts`. |
| [http/contracts/auth.ts](../src/http/contracts/auth.ts) | verified | `rust/src/http/contracts/typed/auth.rs`. Test: `ported_contracts_match_zod_fixtures` (all five schemas). |
| [http/contracts/avatars.ts](../src/http/contracts/avatars.ts) | verified | `rust/src/http/contracts/typed/avatars.rs`. Test: `ported_contracts_match_zod_fixtures`. |
| [http/contracts/common.ts](../src/http/contracts/common.ts) | ported | `rust/src/http/contracts/common.rs` and `common_commands.rs`. Test: `ported_contracts_match_zod_fixtures`. |
| [http/contracts/github-triggers.ts](../src/http/contracts/github-triggers.ts) | verified | `rust/src/http/contracts/typed/github_triggers.rs`. Test: `ported_contracts_match_zod_fixtures`. |
| [http/contracts/oauth.ts](../src/http/contracts/oauth.ts) | verified | `rust/src/http/contracts/typed/oauth.rs`. Test: `oauth_request_fixtures_match_public_zod_contracts`. |
| [http/contracts/projects.ts](../src/http/contracts/projects.ts) | verified | `rust/src/http/contracts/typed/projects.rs` and `project_aux.rs`. Tests: `serde_dtos_project_all_accepted_project_request_fixtures`, `ported_contracts_match_zod_fixtures`. |
| [http/contracts/providers.ts](../src/http/contracts/providers.ts) | ported | `rust/src/http/contracts/providers.rs`. Test: `ported_contracts_match_zod_fixtures`. |
| [http/contracts/system-events.ts](../src/http/contracts/system-events.ts) | verified | `rust/src/http/contracts/typed/system.rs`. Test: `system_contracts_match_zod_request_fixtures`. |
| [http/contracts/task-templates.ts](../src/http/contracts/task-templates.ts) | verified | `rust/src/http/contracts/typed/task_templates.rs`. Test: `ported_contracts_match_zod_fixtures`. |
| [http/contracts/tasks.ts](../src/http/contracts/tasks.ts) | ported | `rust/src/http/contracts/typed/tasks.rs`, `typed/task_answers.rs` and `task_aux.rs`. Test: `task_create_request_fixtures_match_public_zod_contract`. |
| [http/contracts/update.ts](../src/http/contracts/update.ts) | verified | `rust/src/http/contracts/typed/system.rs`. Test: `system_contracts_match_zod_request_fixtures`. |
| [http/contracts/workflows.ts](../src/http/contracts/workflows.ts) | verified | `rust/src/http/contracts/typed/workflows.rs`. Test: `ported_contracts_match_zod_fixtures`. |
| [http/errors.ts](../src/http/errors.ts) | ported | `rust/src/http/validation.rs`. Test: `public_findings_keep_issue_order_and_paths`. |
| [http/oauth-runtime.ts](../src/http/oauth-runtime.ts) | ported | No Rust file: the `/oauth/*` and `/mcp` handlers in `rust/src/http/routes/oauth.rs` and `mcp.rs` do not call the board origin check. |
| [http/routes/administration.ts](../src/http/routes/administration.ts) | ported | `rust/src/http/routes/admin_identity.rs`, `admin_platform.rs` and `profiles.rs`; providers and models in `rust/src/profiles/provider_catalog.rs`. Test: `administrators_create_list_download_and_restore_backups`. |
| [http/routes/agent-api.ts](../src/http/routes/agent-api.ts) | verified | `rust/src/http/routes/agent_api.rs` with `rust/src/tasks/agent_api.rs`; pull request prerequisites and non-Standard notes return 501. Tests: `lifecycle_commands_use_revisions_receipts_note_attribution_and_duplicate_provenance`, `reads_poll_conditionally_page_by_cursor_and_keep_commands_creator_only`. |
| [http/routes/agent-pairing.ts](../src/http/routes/agent-pairing.ts) | verified | `rust/src/http/routes/agent_pairing.rs`. Test: `admin_lifecycle_creates_lists_scopes_reissues_rotates_and_revokes`. |
| [http/routes/assets.ts](../src/http/routes/assets.ts) | ported | `/assets/{filename}` in `rust/src/http/mod.rs` with `rust/src/platform/embedded.rs`. Test: `bundled_frontend_entry_is_readable_when_built`. |
| [http/routes/auth.ts](../src/http/routes/auth.ts) | ported | `rust/src/http/routes/auth.rs`. Tests: `status_cookie_and_sign_out_follow_existing_order`, `signed_fresh_passkey_over_isolated_tcp_listener`. |
| [http/routes/authenticated.ts](../src/http/routes/authenticated.ts) | ported | Client lifecycle route in `rust/src/http/routes/update.rs`. Test: `client_lifecycle_reports_are_bounded_and_authenticated`. |
| [http/routes/avatars.ts](../src/http/routes/avatars.ts) | verified | `rust/src/http/routes/avatars.rs`. Test: `avatars_share_one_table_directory_and_image_route`. |
| [http/routes/companies.ts](../src/http/routes/companies.ts) | ported | `rust/src/http/routes/companies.rs`. Test: `company_routes_apply_live_user_and_membership_scope`. |
| [http/routes/discovery.ts](../src/http/routes/discovery.ts) | verified | `rust/src/http/routes/discovery.rs`. Test: `public_artifacts_are_anonymous_secret_free_and_name_closed_runtime_routes`. |
| [http/routes/external-agent-administration.ts](../src/http/routes/external-agent-administration.ts) | verified | `rust/src/http/routes/external_agent_administration.rs`. Test: `admin_lifecycle_creates_lists_scopes_reissues_rotates_and_revokes`. |
| [http/routes/github-triggers.ts](../src/http/routes/github-triggers.ts) | verified | `rust/src/http/routes/github_triggers.rs` with `rust/src/integrations/github_triggers.rs`. Test: `routes_create_disabled_rules_check_without_tasks_and_scope_access`. |
| [http/routes/health.ts](../src/http/routes/health.ts) | ported | `rust/src/http/routes/health.rs`. Test: `health_uses_live_owned_checks_and_authorizes_requested_context`. |
| [http/routes/mcp.ts](../src/http/routes/mcp.ts) | verified | `rust/src/http/routes/mcp.rs`. Tests: `oauth_mcp_lists_tools_and_calls_the_agent_task_service`, `bearer_checks_follow_live_host_authority_grants_and_token_state`. |
| [http/routes/oauth.ts](../src/http/routes/oauth.ts) | verified | `rust/src/http/routes/oauth.rs`. Tests: `denial_keeps_state_and_consent_needs_csrf_admin_and_session`, `tests/oauth.browser.test.ts` with `SUPLEX_BROWSER_BACKEND=rust`. |
| [http/routes/pages.ts](../src/http/routes/pages.ts) | verified | `rust/src/http/routes/pages.rs`. Tests: `root_and_application_pages_follow_live_session_and_project_state`, `tests/task-detail.browser.test.ts` with `SUPLEX_BROWSER_BACKEND=rust`. |
| [http/routes/projects.ts](../src/http/routes/projects.ts) | verified | `rust/src/http/routes/projects.rs`; Bitbucket connections return 501. Tests: `project_reads_serialize_normalized_configuration_and_enforce_scope`, `project_patch_replaces_or_patches_and_checks_git_only_for_repository_changes`. |
| [http/routes/provider-login.ts](../src/http/routes/provider-login.ts) | ported | `rust/src/http/routes/provider_login.rs`. Test: `provider_login_and_instance_routes_create_reuse_and_close_sign_in_panes`. |
| [http/routes/task-pane.ts](../src/http/routes/task-pane.ts) | ported | `rust/src/http/routes/task_pane.rs`. Test: `observers_are_read_only_and_close_when_the_pane_binding_changes`. |
| [http/routes/task-templates.ts](../src/http/routes/task-templates.ts) | verified | `rust/src/http/routes/task_templates.rs`. Test: `templates_use_profile_defaults_support_reset_and_delete`. |
| [http/routes/task-worktree.ts](../src/http/routes/task-worktree.ts) | ported | `rust/src/http/routes/task_worktree.rs`. Test: `opening_runs_the_resolved_launcher_and_audits_only_successful_launches`. |
| [http/routes/tasks.ts](../src/http/routes/tasks.ts) | ported | `rust/src/http/routes/tasks.rs`, `task_reads.rs`, `task_history.rs`, `task_timeline.rs`, `task_agents.rs`, `task_artifacts.rs` and `analytics.rs`; Bitbucket checks and pull request prerequisites return 501. Tests: `tests/task-detail.browser.test.ts`, `tests/task-archive.browser.test.ts` with `SUPLEX_BROWSER_BACKEND=rust`. |
| [http/routes/update.ts](../src/http/routes/update.ts) | ported | `rust/src/http/routes/update.rs` reports the unsupervised Rust shape. Test: `update_reports_the_current_build_and_restart_needs_an_administrator`. |
| [http/routes/workflows.ts](../src/http/routes/workflows.ts) | verified | `rust/src/http/routes/workflows.rs`. Test: `workflow_api_edits_default_agents_validates_them_and_archives`. |
| [http/session.ts](../src/http/session.ts) | ported | `rust/src/http/session.rs`. Test: `session_lookup_keeps_trusted_sign_in_before_legacy_rollover`. |
| [identity/auth-contracts.ts](../src/identity/auth-contracts.ts) | ported | Types in `rust/src/identity/auth.rs`, `admin.rs`, `ceremony.rs` and `companies.rs`. |
| [identity/auth-identifiers.ts](../src/identity/auth-identifiers.ts) | ported | `new_session_token` in `rust/src/identity/auth.rs`; cookie and header names in `rust/src/http/session.rs`. |
| [identity/auth-repository.ts](../src/identity/auth-repository.ts) | ported | Queries are inline in `rust/src/identity/auth.rs`, `admin.rs`, `ceremony.rs` and `companies.rs`. Test: `session_lookup_development_sign_in_sign_out_and_legacy_rollover`. |
| [identity/auth-schema.ts](../src/identity/auth-schema.ts) | ported | Tables come from the shared SQL migrations that `rust/src/platform/database.rs` applies. Test: `migrates_shared_sql_and_reopens_read_only`. |
| [identity/auth-webauthn.ts](../src/identity/auth-webauthn.ts) | verified | `rust/src/identity/webauthn.rs` and `ceremony.rs`. Test: `signed_fresh_passkey_survives_reopen_and_updates_counter`. |
| [identity/auth.ts](../src/identity/auth.ts) | ported | `rust/src/identity/auth.rs`, `admin.rs` and `companies.rs`. Test: `session_lookup_development_sign_in_sign_out_and_legacy_rollover`. |
| [identity/avatar-kinds.ts](../src/identity/avatar-kinds.ts) | ported | Inside `rust/src/identity/avatars.rs`. |
| [identity/avatars.ts](../src/identity/avatars.ts) | verified | `rust/src/identity/avatars.rs`. Test: `avatars_share_one_table_directory_and_image_route`. |
| [identity/external-agents.ts](../src/identity/external-agents.ts) | verified | `rust/src/identity/external_agents.rs`. Tests: `canonical_identity_pairs_once_persists_only_hashes_and_audits_actors`, `concurrent_exchanges_on_separate_connections_consume_one_code`. |
| [identity/oauth.ts](../src/identity/oauth.ts) | verified | `rust/src/identity/oauth.rs`. Tests: `discovery_registration_consent_pkce_rotation_replay_revocation_and_reapproval`, `tests/oauth.browser.test.ts` with `SUPLEX_BROWSER_BACKEND=rust`. |
| [identity/registration.ts](../src/identity/registration.ts) | verified | `begin_registration` and `complete_registration` in `rust/src/identity/ceremony.rs`. Tests: `signed_fresh_passkey_survives_reopen_and_updates_counter`, `signed_fresh_passkey_over_isolated_tcp_listener`. |
| [integrations/bitbucket.ts](../src/integrations/bitbucket.ts) | ported | `rust/src/integrations/bitbucket.rs`; delivery does not call it yet. Test: `release_port_reads_pages_statuses_and_classifies_failures`. |
| [integrations/github/client.ts](../src/integrations/github/client.ts) | ported | `rust/src/integrations/github.rs`. Test: `current_user_and_encoded_branch_use_token_backed_api`. |
| [integrations/github/delivery.ts](../src/integrations/github/delivery.ts) | verified | `rust/src/integrations/github_delivery.rs` and `github.rs`. Tests: `ready_and_merged_targets_complete_through_github_state`, `mise run test:journey:rust` (deliver_pr phase). |
| [integrations/github/failure.ts](../src/integrations/github/failure.ts) | ported | `GithubFailure` in `rust/src/integrations/github_delivery.rs`. |
| [integrations/github/issues.ts](../src/integrations/github/issues.ts) | ported | `rust/src/integrations/github_delivery.rs`. Test: `issue_context_lists_every_comment`. |
| [integrations/github/pull-request-states.ts](../src/integrations/github/pull-request-states.ts) | ported | `pull_request_states` in `rust/src/integrations/github_delivery.rs`. |
| [integrations/github/trigger-delivery-policy.ts](../src/integrations/github/trigger-delivery-policy.ts) | ported | `trigger_delivery_policy` in `rust/src/integrations/github_triggers_dispatches.rs`; delivery does not call it yet. |
| [integrations/github/trigger-dispatches.ts](../src/integrations/github/trigger-dispatches.ts) | ported | `rust/src/integrations/github_triggers_dispatches.rs`; task admission has no end-to-end test. |
| [integrations/github/trigger-inspection.ts](../src/integrations/github/trigger-inspection.ts) | verified | `rust/src/integrations/github_triggers_inspection.rs`. Test: `inspection_pages_files_rechecks_the_revision_and_rejects_malformed_data`. |
| [integrations/github/trigger-paths.ts](../src/integrations/github/trigger-paths.ts) | verified | `rust/src/integrations/github_triggers_inspection.rs`. Test: `unsafe_protected_paths_and_filenames_are_rejected`. |
| [integrations/github/trigger-poller.ts](../src/integrations/github/trigger-poller.ts) | ported | `spawn_poller` in `rust/src/integrations/github_triggers.rs`, started by the task host. |
| [integrations/github/trigger-repository.ts](../src/integrations/github/trigger-repository.ts) | verified | `rust/src/integrations/github_triggers.rs`. Test: `preview_records_exclusions_failures_and_the_latest_provider_retry`. |
| [integrations/github/triggers.ts](../src/integrations/github/triggers.ts) | ported | `rust/src/integrations/github_triggers.rs`; the dispatch admission path has no end-to-end test. Test: `routes_create_disabled_rules_check_without_tasks_and_scope_access`. |
| [integrations/herdr/client.ts](../src/integrations/herdr/client.ts) | ported | `rust/src/integrations/herdr.rs`. Test: `client_validates_json_envelopes_and_passes_unambiguous_argv`. |
| [integrations/herdr/readiness.ts](../src/integrations/herdr/readiness.ts) | ported | `rust/src/integrations/herdr_readiness.rs`. Test: `reports_a_reachable_matching_client_and_server`. |
| [integrations/herdr/terminal-bridge.ts](../src/integrations/herdr/terminal-bridge.ts) | ported | `rust/src/integrations/herdr_bridge.rs`. Test: `control_mode_writes_ndjson_commands_and_releases_the_controller`. |
| [integrations/issue-tracker.ts](../src/integrations/issue-tracker.ts) | ported | `rust/src/integrations/issue_tracker.rs`. Test: `issue_text_flattens_documents_and_stringifies_unknown_objects`. |
| [integrations/provider-http.ts](../src/integrations/provider-http.ts) | verified | `rust/src/integrations/provider_http.rs`. Test: `requests_stay_on_origin_fail_on_status_and_bound_the_body`. |
| [integrations/suplex/mcp-bridge.ts](../src/integrations/suplex/mcp-bridge.ts) | verified | `rust/src/integrations/suplex/bridge.rs`, run as `suplex mcp`. Test: `the_bridge_drives_the_paired_runtime_api_end_to_end`. |
| [integrations/suplex/mcp-runtime.ts](../src/integrations/suplex/mcp-runtime.ts) | verified | `rust/src/integrations/suplex/runtime.rs`. Test: `oauth_mcp_lists_tools_and_calls_the_agent_task_service`. |
| [platform/artifacts.ts](../src/platform/artifacts.ts) | ported | `rust/src/platform/artifacts.rs`; task images only. Tests: `task_image_file_and_row_share_commit_and_rollback_cleanup`, `tests/interop/root-image.ts`. |
| [platform/backup.ts](../src/platform/backup.ts) | ported | `rust/src/platform/backup.rs`. Test: `administrators_create_list_download_and_restore_backups`. |
| [platform/command-runner.ts](../src/platform/command-runner.ts) | ported | No shared runner; callers such as `rust/src/tasks/preparation.rs` spawn bounded processes directly. Test: `project_setup_runs_once_in_the_prepared_worktree_before_the_root_starts`. |
| [platform/config.ts](../src/platform/config.ts) | ported | `rust/src/platform/config.rs`. Test: `paths_stay_under_experimental_root`. |
| [platform/database.ts](../src/platform/database.ts) | verified | `rust/src/platform/database.rs`. Test: `opens_typescript_database_and_creates_reverse_fixture_when_requested`. |
| [platform/development.ts](../src/platform/development.ts) | ported | `rust/src/platform/development.rs`. Test: `seeding_creates_one_company_for_the_operator_and_is_idempotent`. |
| [platform/diagnostics/doctor.ts](../src/platform/diagnostics/doctor.ts) | ported | `rust/src/cli.rs`. Test: `doctor_reports_schema_references_health_and_waiting_tasks`. |
| [platform/diagnostics/task.ts](../src/platform/diagnostics/task.ts) | ported | `rust/src/cli.rs`; native status is not observed. Test: `task_diagnostic_formats_durable_control_sessions_and_turns`. |
| [platform/environment-settings.ts](../src/platform/environment-settings.ts) | ported | `rust/src/platform/environment_settings.rs`. Test: `environment_settings_default_and_persist_partial_administrator_updates`. |
| [platform/executable-resolver.ts](../src/platform/executable-resolver.ts) | ported | Codex only in `rust/src/runtimes/codex/executable.rs`; Git in `rust/src/runtimes/git_guard.rs`. Test: `override_path_precedes_path_and_home_and_requires_executable_file`. |
| [platform/factory-reset.ts](../src/platform/factory-reset.ts) | ported | `rust/src/platform/factory_reset.rs`. Test: `factory_reset_waits_for_live_sessions_then_restores_a_first_start_database`. |
| [platform/frontend-development.ts](../src/platform/frontend-development.ts) | ported | Development asset refresh in `rust/src/http/mod.rs`. Test: `development_assets_refresh_without_restarting_the_server`. |
| [platform/health-contract.ts](../src/platform/health-contract.ts) | ported | Check ids and provider labels in `rust/src/http/routes/health.rs`. |
| [platform/health.ts](../src/platform/health.ts) | ported | `rust/src/http/routes/health.rs`. Test: `health_uses_live_owned_checks_and_authorizes_requested_context`. |
| [platform/host-health.ts](../src/platform/host-health.ts) | ported | `rust/src/http/routes/health.rs`; the pnpm check is omitted. Test: `health_uses_live_owned_checks_and_authorizes_requested_context`. |
| [platform/install/command.ts](../src/platform/install/command.ts) | not started | Node installer; the Rust binary has no installer. |
| [platform/install/stages.ts](../src/platform/install/stages.ts) | not started | Node installer; the Rust binary has no installer. |
| [platform/log-viewer.ts](../src/platform/log-viewer.ts) | ported | `rust/src/platform/log_viewer.rs`; reads the system log segments. Test: `merges_segments_in_time_order_and_filters_task_and_errors`. |
| [platform/logging.ts](../src/platform/logging.ts) | ported | `redact` only, as `rust/src/platform/redaction.rs`. Test: `masks_synthetic_token_and_assignment_in_command_output`. |
| [platform/process-manager.ts](../src/platform/process-manager.ts) | ported | `rust/src/runtimes/process.rs`. Test: `only_exact_process_identity_allows_owned_signal`. |
| [platform/runtime.ts](../src/platform/runtime.ts) | not started | The process registry belongs to the Node launcher; `rust/src/main.rs` starts directly. |
| [platform/schemas.ts](../src/platform/schemas.ts) | ported | Health snapshot shape and Tailscale status parsing in `rust/src/http/routes/health.rs`. |
| [platform/setup.ts](../src/platform/setup.ts) | not started | Writes the Node `suplex.env`; the Rust binary reads `SUPLEX_RUST_*` only. |
| [platform/system-event-transport.ts](../src/platform/system-event-transport.ts) | ported | `rust/src/platform/system_event_transport.rs`. Test: `bridge_events_cross_the_socket_with_producer_identity_after_restart`. |
| [platform/system-events.ts](../src/platform/system-events.ts) | ported | `rust/src/platform/system_events.rs`; request context is absent. Test: `rotation_prunes_old_archives_and_enforces_total_bytes`. |
| [platform/tailscale.ts](../src/platform/tailscale.ts) | ported | Hostname parsing and health reporting in `rust/src/http/routes/health.rs`. |
| [platform/ui.ts](../src/platform/ui.ts) | ported | `application_page` in `rust/src/http/ui.rs`; the health page in `rust/src/http/routes/pages.rs`. Tests: `application_shell_uses_the_page_view_and_built_assets`, `denied_company_page_and_health_keep_session_cookies`. |
| [platform/updates/supervisor.ts](../src/platform/updates/supervisor.ts) | not started | Node self-update supervisor; not applicable to the Rust binary. |
| [platform/updates/update-client.ts](../src/platform/updates/update-client.ts) | ported | `rust/src/http/routes/update.rs` reports the unsupervised Rust shape. Test: `update_reports_the_current_build_and_restart_needs_an_administrator`. |
| [profiles/agent-profile-contracts.ts](../src/profiles/agent-profile-contracts.ts) | ported | `rust/src/http/contracts/profile.rs`. Test: `profile_validation_precedes_origin_and_session_checks`. |
| [profiles/agent-profiles.ts](../src/profiles/agent-profiles.ts) | ported | `rust/src/profiles/agent_profiles.rs`. Test: `profile_commands_keep_role_visibility_references_and_audit_atomic`. |
| [profiles/model-pricing.ts](../src/profiles/model-pricing.ts) | ported | `rust/src/profiles/model_pricing.rs`. Test: `parses_valid_prices_and_uses_source_cost_formula`. |
| [profiles/models-dev-catalog.ts](../src/profiles/models-dev-catalog.ts) | ported | `rust/src/profiles/model_pricing.rs`. Test: `catalog_read_shares_inflight_request_and_retries_failure`. |
| [profiles/provider-catalog.ts](../src/profiles/provider-catalog.ts) | verified | `rust/src/profiles/provider_catalog.rs`. Test: `provider_routes_require_an_administrator_and_models_any_session`. |
| [profiles/provider-connection.ts](../src/profiles/provider-connection.ts) | ported | `rust/src/profiles/provider_connection.rs`. Test: `health_maps_onto_the_sign_in_vocabulary`. |
| [profiles/provider-instances.ts](../src/profiles/provider-instances.ts) | ported | `rust/src/profiles/provider_instances.rs`, routes in `rust/src/http/routes/provider_login.rs`. Test: `provider_login_and_instance_routes_create_reuse_and_close_sign_in_panes`. |
| [profiles/provider-login.ts](../src/profiles/provider-login.ts) | ported | `rust/src/profiles/provider_login.rs`. Test: `sign_ins_reuse_a_live_pane_and_close_the_previous_session`. |
| [profiles/provider-readiness.ts](../src/profiles/provider-readiness.ts) | ported | `rust/src/profiles/provider_readiness.rs`. Test: `opencode_reports_absent_signed_out_signed_in_and_indeterminate_states`. |
| [projects/contracts.ts](../src/projects/contracts.ts) | ported | `ProjectFailure` in `rust/src/projects/service.rs`. |
| [projects/execution-configuration.ts](../src/projects/execution-configuration.ts) | ported | Typed stored configuration in `rust/src/http/contracts/typed/projects.rs`. Test: `stored_project_nested_schemas_match_zod`. |
| [projects/integration-configuration.ts](../src/projects/integration-configuration.ts) | ported | Typed stored configuration in `rust/src/http/contracts/typed/projects.rs`; credential keys are excluded in `rust/src/tasks/host.rs`. Test: `stored_project_nested_schemas_match_zod`. |
| [projects/projects.ts](../src/projects/projects.ts) | verified | `rust/src/projects/service.rs`. Tests: `local_create_audits_once_and_reads_follow_live_membership`, `project_patch_replaces_or_patches_and_checks_git_only_for_repository_changes`. |
| [projects/provider-policy.ts](../src/projects/provider-policy.ts) | ported | `allowed_profile` in `rust/src/tasks/commands.rs`. |
| [projects/repository-commands.ts](../src/projects/repository-commands.ts) | verified | `infer_commands` in `rust/src/projects/provisioning.rs`. Test: `package_checks_use_the_locked_package_manager`. |
| [projects/repository-coordinate.ts](../src/projects/repository-coordinate.ts) | verified | `rust/src/projects/repository.rs`. Test: `repository_coordinates_preserve_host_and_reject_credentials`. |
| [projects/repository-inspection.ts](../src/projects/repository-inspection.ts) | ported | `rust/src/projects/repository.rs` with git2 and the GitHub REST API; GitHub only. Test: `local_inspection_fetches_origin_and_checks_github_identity`. |
| [projects/repository-provisioning.ts](../src/projects/repository-provisioning.ts) | ported | `rust/src/projects/provisioning.rs` with git2 and the GitHub REST and GraphQL APIs; GitHub only. Test: `admitted_project_create_finishes_after_request_task_is_dropped`. |
| [runtimes/claude-code/display.ts](../src/runtimes/claude-code/display.ts) | ported | `rust/src/runtimes/claude_code/display.rs`. Test: `the_display_catches_up_turns_follows_later_turns_and_renders_tools_without_duplicate_text`. |
| [runtimes/claude-code/environment.ts](../src/runtimes/claude-code/environment.ts) | ported | `rust/src/runtimes/claude_code/environment.rs`. Test: `dedicated_auth_removes_inherited_tokens_and_cloud_routing`. |
| [runtimes/claude-code/live-history.ts](../src/runtimes/claude-code/live-history.ts) | ported | `rust/src/runtimes/claude_code/live_history.rs`. Test: `live_history_replaces_only_the_completed_blocks_of_a_shared_native_message`. |
| [runtimes/claude-code/session-reader.ts](../src/runtimes/claude-code/session-reader.ts) | ported | `rust/src/runtimes/claude_code/session_reader.rs`. Test: `workflow_evidence_reads_only_the_requested_native_turn`. |
| [runtimes/claude-code/task-runtime.ts](../src/runtimes/claude-code/task-runtime.ts) | ported | `rust/src/runtimes/claude_code/task_runtime.rs`. Tests: `a_headless_turn_is_dispatched_once_observed_from_its_stream_and_reported_as_the_result`, `mise run test:journey:rust` (deliver_claude phase). |
| [runtimes/claude-code/transcript.ts](../src/runtimes/claude-code/transcript.ts) | ported | `rust/src/runtimes/claude_code/transcript.rs`. Test: `history_omits_thinking_and_joins_completed_failed_and_running_tools_by_native_id`. |
| [runtimes/codex/display.ts](../src/runtimes/codex/display.ts) | ported | `rust/src/runtimes/codex/display.rs`. Test: `renders_codex_events_for_the_passive_display`. |
| [runtimes/codex/session-reader.ts](../src/runtimes/codex/session-reader.ts) | ported | `rust/src/runtimes/codex/session_reader.rs`. Test: `reads_native_history_without_changing_it`. |
| [runtimes/codex/task-runtime.ts](../src/runtimes/codex/task-runtime.ts) | ported | `rust/src/runtimes/codex/task_runtime.rs`, `runtime.rs`, `invocation.rs` and `thread.rs`. Tests: `root_binding_and_guard_reach_child_only_after_claim`, `mise run test:journey:rust`. |
| [runtimes/codex/transcript.ts](../src/runtimes/codex/transcript.ts) | ported | `rust/src/runtimes/codex/transcript.rs`, `tool_evidence.rs` and `usage.rs`. Tests: `source_transcript_sample_projects_exact_tool_rows`, `tests/interop/root-worker-evidence.ts`. |
| [runtimes/devin/advisor-evidence.ts](../src/runtimes/devin/advisor-evidence.ts) | ported | `rust/src/runtimes/devin/advisor_evidence.rs`. Test: `captured_report_becomes_the_only_tool_evidence`. |
| [runtimes/devin/display.ts](../src/runtimes/devin/display.ts) | ported | `rust/src/runtimes/devin/display.rs`. Test: `display_follows_two_turns_once_each_and_splits_utf8_safely`. |
| [runtimes/devin/mcp-config.ts](../src/runtimes/devin/mcp-config.ts) | ported | `rust/src/runtimes/devin/mcp_config.rs`. Test: `config_outside_a_git_worktree_is_refused`. |
| [runtimes/devin/session-reader.ts](../src/runtimes/devin/session-reader.ts) | ported | `rust/src/runtimes/devin/session_reader.rs`. Test: `timeline_keeps_completed_execution_time_when_the_output_log_changes`. |
| [runtimes/devin/task-runtime.ts](../src/runtimes/devin/task-runtime.ts) | ported | `rust/src/runtimes/devin/task_runtime.rs` and `harness.rs`. Test: `devin_starts_without_resume_persists_its_assigned_id_then_resumes`. |
| [runtimes/devin/transcript.ts](../src/runtimes/devin/transcript.ts) | ported | `rust/src/runtimes/devin/transcript.rs`. Test: `history_keeps_only_turns_with_text_and_usage_counts_completed_steps`. |
| [runtimes/harness-kind.ts](../src/runtimes/harness-kind.ts) | ported | `HarnessKind` in `rust/src/http/contracts/providers.rs`, `project_aux.rs` and `task_aux.rs`. |
| [runtimes/headless/turn-process.ts](../src/runtimes/headless/turn-process.ts) | ported | `rust/src/runtimes/headless.rs`. Test: `claim_precedes_detached_launch_and_record_uses_source_shape`. |
| [runtimes/opencode/client.ts](../src/runtimes/opencode/client.ts) | verified | `rust/src/runtimes/opencode/client.rs`. Test: `client_uses_the_installed_v1_routes_and_validates_native_envelopes`. |
| [runtimes/opencode/contracts.ts](../src/runtimes/opencode/contracts.ts) | verified | `rust/src/runtimes/opencode/contracts.rs`. Test: `envelopes_keep_unknown_keys_and_reject_malformed_native_records`. |
| [runtimes/opencode/providers.ts](../src/runtimes/opencode/providers.ts) | verified | `rust/src/runtimes/opencode/providers.rs`. Test: `provider_observation_lists_connected_vendors_and_disposes_its_server`. |
| [runtimes/opencode/server.ts](../src/runtimes/opencode/server.ts) | verified | `rust/src/runtimes/opencode/server.rs`. Test: `refreshes_a_live_opencode_server_for_authenticated_bridge_environment_only_after_native_work_is_idle`. |
| [runtimes/opencode/session-history.ts](../src/runtimes/opencode/session-history.ts) | verified | `rust/src/runtimes/opencode/session_history.rs`. Test: `an_export_from_another_session_cannot_replace_spend_history`. |
| [runtimes/opencode/session-reader.ts](../src/runtimes/opencode/session-reader.ts) | verified | `rust/src/runtimes/opencode/session_reader.rs`. Test: `retired_worker_spend_remains_readable_without_its_server_or_worktree`. |
| [runtimes/opencode/session.ts](../src/runtimes/opencode/session.ts) | verified | `rust/src/runtimes/opencode/session.rs`. Test: `a_failed_post_after_durable_claim_stays_ambiguous_and_cannot_be_replayed`. |
| [runtimes/opencode/task-runtime.ts](../src/runtimes/opencode/task-runtime.ts) | ported | `rust/src/runtimes/opencode/task_runtime.rs`; attach is excluded. Test: `dispatch_fencing_retains_the_replacement_server_and_reads_native_history`. |
| [runtimes/project-environment.ts](../src/runtimes/project-environment.ts) | ported | Project scope in `rust/src/tasks/host.rs`. Test: `project_scope_keeps_context_and_excludes_credential_references`. |
| [runtimes/project-mcp.ts](../src/runtimes/project-mcp.ts) | ported | `rust/src/runtimes/project_mcp.rs`. Test: `mcp_grants_are_exact_and_role_scoped`. |
| [runtimes/task-display.ts](../src/runtimes/task-display.ts) | ported | `rust/src/runtimes/task_display.rs`. Test: `refreshes_lost_metadata_on_a_matching_display`. |
| [runtimes/task-harness-registry.ts](../src/runtimes/task-harness-registry.ts) | ported | `rust/src/runtimes/task_harness_registry.rs` selects Codex, Claude Code, OpenCode or Devin by profile provider. Test: `harness_selection_follows_the_profile_provider_and_the_native_session_identity`. |
| [runtimes/task-harness.ts](../src/runtimes/task-harness.ts) | ported | `rust/src/runtimes/task_harness.rs`. Test: `detached_child_receives_only_its_current_bridge_capability`. |
| [server.ts](../src/server.ts) | ported | `rust/src/main.rs` binds the listener, starts recovery and shuts down gracefully. |
| [shared/abort-signal.ts](../src/shared/abort-signal.ts) | not started | No Rust caller; Tokio cancellation replaces it. |
| [shared/assert-never.ts](../src/shared/assert-never.ts) | not started | No Rust caller; exhaustive `match` replaces it. |
| [shared/canonical-json.ts](../src/shared/canonical-json.ts) | not started | No production TypeScript caller. |
| [shared/entrypoint.ts](../src/shared/entrypoint.ts) | not started | No Rust caller; binary dispatch in `rust/src/main.rs` replaces it. |
| [shared/ids.ts](../src/shared/ids.ts) | not started | No production TypeScript caller. |
| [shared/json.ts](../src/shared/json.ts) | ported | `serde_json` replaces `json` and `jsonRequired`; `rust/src/shared/js_json.rs` reproduces `JSON.stringify` bytes. Test: `persisted_hash_bytes_match_json_stringify`. |
| [shared/mcp-stdio.ts](../src/shared/mcp-stdio.ts) | ported | rmcp stdio in `rust/src/coordination/root_stdio.rs` and `advisor_bridge.rs`. Test: `mcp_stdio_transport_lists_and_calls_the_assigned_tool`. |
| [tasks/agent-status.ts](../src/tasks/agent-status.ts) | ported | `rust/src/http/routes/task_agents.rs`; Codex only. Test: `same_database_agent_reads_match_typescript_and_refresh_native_state` (ignored by default; needs Node). |
| [tasks/analytics/analytics.ts](../src/tasks/analytics/analytics.ts) | verified | `rust/src/tasks/analytics/mod.rs` and `rust/src/http/routes/analytics.rs`. Test: `company_analytics_costs_and_timeline_read_saved_usage_for_visible_tasks`. |
| [tasks/analytics/collector.ts](../src/tasks/analytics/collector.ts) | verified | `rust/src/tasks/analytics/collector.rs`. Test: `a_failed_read_keeps_saved_usage_marks_the_session_stale_and_retries_after_five_minutes`. |
| [tasks/analytics/contracts.ts](../src/tasks/analytics/contracts.ts) | ported | `rust/src/tasks/analytics/mod.rs`. |
| [tasks/analytics/metrics.ts](../src/tasks/analytics/metrics.ts) | verified | `rust/src/tasks/analytics/mod.rs`. Test: `metrics_count_correlated_turns_once_and_union_overlapping_time_in_each_session`. |
| [tasks/analytics/store.ts](../src/tasks/analytics/store.ts) | verified | `rust/src/tasks/analytics/mod.rs`. Test: `a_session_observation_replaces_its_old_rows_without_deleting_another_session`. |
| [tasks/archive/displays.ts](../src/tasks/archive/displays.ts) | ported | `rust/src/tasks/archive/displays.rs`. Test: `archive_preserves_unrelated_and_unproven_panes`. |
| [tasks/archive/processes.ts](../src/tasks/archive/processes.ts) | ported | `rust/src/tasks/archive/processes.rs`. Test: `cancellation_stops_live_worktree_process_without_a_display_receipt`. |
| [tasks/archive/sessions.ts](../src/tasks/archive/sessions.ts) | ported | `archive_sessions_idle` in `rust/src/tasks/archive/operations.rs`. Tests: `archive_uses_live_native_and_git_facts_then_commits_once`, `tests/task-archive.browser.test.ts`. |
| [tasks/branch.ts](../src/tasks/branch.ts) | ported | `task_branch_name` in `rust/src/tasks/commands.rs`. |
| [tasks/contracts.ts](../src/tasks/contracts.ts) | ported | `rust/src/tasks/response.rs` and `rust/src/http/contracts/typed/mod.rs`. |
| [tasks/control.ts](../src/tasks/control.ts) | ported | Control, session and turn rows are read in `rust/src/coordination/root_session_store.rs`. |
| [tasks/dependencies.ts](../src/tasks/dependencies.ts) | ported | `set_user_task_dependencies` in `rust/src/tasks/commands.rs`. Test: `dependency_replacement_rejects_cycles_and_admits_a_released_queued_task`. |
| [tasks/duplicate-title.ts](../src/tasks/duplicate-title.ts) | verified | `rust/src/tasks/duplicate_title.rs`. Test: `duplicates_increment_the_copy_number_past_used_titles`. |
| [tasks/execution/contracts.ts](../src/tasks/execution/contracts.ts) | ported | `execution_document` in `rust/src/http/routes/task_reads.rs`. |
| [tasks/execution/execution.ts](../src/tasks/execution/execution.ts) | ported | `/api/tasks/{task_id}/execution` in `rust/src/http/routes/task_reads.rs`. Test: `task_detail_reads_follow_live_scope_and_saved_native_intent`. |
| [tasks/execution/pane-layout.ts](../src/tasks/execution/pane-layout.ts) | ported | `rust/src/tasks/pane_layout.rs`. Test: `chooses_a_tallest_row_and_balances_split_ratios_by_descendant_counts`. |
| [tasks/execution/role-prompt.ts](../src/tasks/execution/role-prompt.ts) | ported | `rust/src/runtimes/codex/role_prompt.rs`; Standard roles only. |
| [tasks/history/contracts.ts](../src/tasks/history/contracts.ts) | ported | `rust/src/http/routes/task_history.rs`. Test: `history_cursor_query_uses_public_zod_findings`. |
| [tasks/history/history.ts](../src/tasks/history/history.ts) | ported | `rust/src/http/routes/task_history.rs` reads through the harness registry. Test: `page_cursor_and_live_delta_follow_native_message_ids`. |
| [tasks/history/live.ts](../src/tasks/history/live.ts) | ported | `rust/src/http/routes/task_history.rs`. Test: `same_database_history_page_and_live_snapshot_match_typescript` (ignored by default; needs Node). |
| [tasks/history/read.ts](../src/tasks/history/read.ts) | ported | `rust/src/http/routes/task_history.rs` with the native session readers in `rust/src/runtimes/task_harness_registry.rs`. |
| [tasks/host.ts](../src/tasks/host.ts) | ported | `rust/src/tasks/host.rs`; non-Standard Coordinators and Advisor or Direct build sessions run on Codex only. Tests: `root_dispatch_claim_survives_reopen_without_replaying_child`, `mise run test:journey:rust`. |
| [tasks/images.ts](../src/tasks/images.ts) | verified | `rust/src/tasks/images.rs`. Tests: `decoder_rejects_noncanonical_padding_wrong_type_magic_and_decoded_oversize`, `tests/interop/root-image.ts`. |
| [tasks/inspection.ts](../src/tasks/inspection.ts) | ported | Diff, diff summary and checks in `rust/src/http/routes/task_reads.rs`; Bitbucket checks return 501. |
| [tasks/integration.ts](../src/tasks/integration.ts) | ported | `rust/src/tasks/integration.rs`. Test: `conflicts_failures_and_missing_pull_requests_name_the_owner`. |
| [tasks/issue-association.ts](../src/tasks/issue-association.ts) | ported | `IssueAssociation` in `rust/src/http/contracts/typed/tasks.rs`. Test: `issue_link_stores_the_tracker_issue_and_clears_unstarted_context`. |
| [tasks/issue-context.ts](../src/tasks/issue-context.ts) | ported | `rust/src/tasks/issue_context.rs`. Test: `tracker_defaults_to_task_repository_issues_only_without_integration`. |
| [tasks/limits/attachment-limits.ts](../src/tasks/limits/attachment-limits.ts) | verified | Limits in `rust/src/tasks/images.rs`. Test: `decoder_rejects_noncanonical_padding_wrong_type_magic_and_decoded_oversize`. |
| [tasks/limits/limit-observer.ts](../src/tasks/limits/limit-observer.ts) | verified | Usage observation in `rust/src/tasks/host.rs`. Test: `observed_usage_matches_the_typescript_limit_observer`. |
| [tasks/limits/limit-store.ts](../src/tasks/limits/limit-store.ts) | ported | `answer_task_limit` and `reconcile_task_limit_pause` in `rust/src/coordination/root_session_store.rs`. |
| [tasks/limits/limits.ts](../src/tasks/limits/limits.ts) | ported | `task_limit_question` in `rust/src/coordination/root_session_store.rs`. |
| [tasks/preparation.ts](../src/tasks/preparation.ts) | ported | `rust/src/tasks/preparation.rs`. Test: `project_setup_runs_once_in_the_prepared_worktree_before_the_root_starts`. |
| [tasks/pull-request-dependencies.ts](../src/tasks/pull-request-dependencies.ts) | ported | `PullRequestDependency` in `rust/src/http/contracts/typed/tasks.rs`, stored by `rust/src/tasks/repository.rs`. |
| [tasks/queue.ts](../src/tasks/queue.ts) | ported | `admit_queued` in `rust/src/coordination/root_session_store.rs`. Test: `scheduler_tick_admits_a_queued_task_whose_blocker_cleared`. |
| [tasks/repository.ts](../src/tasks/repository.ts) | ported | `rust/src/tasks/repository.rs`. Tests: `local_backlog_create_fetches_git_and_returns_full_task_shape`, `standard_request_hash_matches_typescript_parsed_request`. |
| [tasks/sources.ts](../src/tasks/sources.ts) | ported | `rust/src/tasks/sources.rs`. Test: `branch_discovery_reads_remote_refs_without_changing_the_checkout`. |
| [tasks/tasks.ts](../src/tasks/tasks.ts) | ported | `rust/src/tasks/commands.rs` and agent API methods in `rust/src/tasks/agent_api.rs`. Tests: `live_authority_and_after_commit_wake_follow_task_start`, `creation_is_idempotent_scoped_and_validated_and_dry_runs_write_nothing`. |
| [tasks/templates.ts](../src/tasks/templates.ts) | verified | `rust/src/tasks/templates.rs`. Test: `templates_use_profile_defaults_support_reset_and_delete`. |
| [tasks/timeline/contracts.ts](../src/tasks/timeline/contracts.ts) | ported | `rust/src/http/routes/task_timeline.rs`. Test: `tests/interop/task-timeline.ts`. |
| [tasks/timeline/timeline.ts](../src/tasks/timeline/timeline.ts) | ported | `rust/src/tasks/timeline.rs`; company timeline in `rust/src/http/routes/analytics.rs`. Tests: `native_overlay_and_missing_record_preserve_saved_timing`, `tests/interop/task-timeline.ts`. |
| [tasks/usage.ts](../src/tasks/usage.ts) | ported | `rust/src/runtimes/codex/usage.rs`; Codex only. Test: `cumulative_native_thread_usage_uses_dispatched_model_and_optional_pricing`. |
| [tasks/worktree-open.ts](../src/tasks/worktree-open.ts) | ported | `rust/src/tasks/worktree_open.rs`. Test: `discovers_resolved_macos_applications_with_fixed_argument_arrays`. |
| [tasks/worktree.ts](../src/tasks/worktree.ts) | ported | `rust/src/tasks/worktree.rs`. Tests: `prepares_and_reobserves_a_real_local_git_worktree`, `tests/task-archive.browser.test.ts`. |
