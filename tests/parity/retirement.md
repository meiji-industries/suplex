# TypeScript engine test retirement

Status: complete. The TypeScript engine and its backend test harnesses are removed. The 74 root TypeScript test files that remain cover the frontend, SQL migration files, native-browser journeys, and standalone tooling. None imports a retired backend module.

Frozen parity inputs remain checked in and immutable. Rust tests consume the captured TypeScript database, route list, schema cases, JSON/hash bytes, task response, task reads, task agents, task templates, task history, and Coordinator replacement data. Their one-shot TypeScript generators and live oracle programs are removed; no Rust test starts Node or `tsx` as an oracle.

## Native coverage retained for the final backend suites

| Removed TypeScript suite | Retained native evidence |
| --- | --- |
| `native-tasks.test.ts` | `http::routes::tasks::tests::local_backlog_create_fetches_git_and_returns_full_task_shape` and `frozen_full_task_response_matches_typescript_source_revision`; task command, repository, image, artifact, issue-context, profile-policy, source, and archive tests cover authorization, idempotency, edits, provider rules, artifacts, issue capture, lifecycle, and recency. |
| `task-history-live.test.ts`, `task-session-history.test.ts` | `http::routes::task_history::tests::frozen_history_page_live_update_and_reconnect_match_typescript_source_revision`, cursor/live-delta coverage, and native OpenCode, Claude Code, and Devin reader tests cover scoped reads, revocation, reconnect, recovery, shutdown, native failures, and timestamp normalization. The page test also pins TypeScript Map semantics for duplicate IDs: the first slot is retained and the latest value wins. |
| `task-issues.integration.test.ts` | `integrations::github_delivery::tests::issue_reads_keep_the_gh_issue_shape_and_context_text`, task source tests, `tasks::issue_context` tests, and the native task-create route cover current issue context, comments, branch capture, user instructions, replay, and the absence of a pull request. |
| `task-timeline.test.ts` | `tasks::analytics` and collector tests plus `http::routes::task_timeline::tests::saved_timeline_obeys_live_company_membership_and_session_scope` cover durable timing, native observations, idle-gap exclusion, failure handling, authorization, and read-only behavior. |
| `task-queue.test.ts` | `tasks::commands::tests::dependency_replacement_rejects_cycles_and_admits_a_released_queued_task`, coordination store/host queue tests, and `tasks::response::dependency_tests::queue_waits_explain_cancelled_human_archived_and_unobserved_merge_blockers` cover admission and every wait reason. `task-queue-ui.test.ts` retains the frontend copy and rendering checks. |
| `task-agent-selection-api.test.ts` | `tasks::commands` selection tests and `rust/tests/coordination/agent_selection.rs` cover authentication boundaries, idempotency, future-profile selection, direction delivery, role constraints, and session replacement. |
| `task-templates-api.test.ts` | `http::routes::task_templates::tests::templates_use_profile_defaults_support_reset_and_delete`, stored-configuration validation, and the frozen template-list response cover create/update/reset/delete and response compatibility. |
| `workflow-records.test.ts` | `http::routes::workflows::tests::workflow_api_edits_default_agents_validates_them_and_archives` and seeded-list coverage preserve built-in records, edit validation, duplication, engine changes, and archive filtering. |
| `tests/helpers/test-database.test.ts` | `platform::database` tests cover current-schema creation, reopening, isolation, migration modes, and the frozen TypeScript migration ledger. |

## Domain retirement ledgers

- `auth-retirement.md`: identity, sessions, recovery, OAuth, and WebAuthn.
- `platform-retirement.md`: database, backup, install, configuration, diagnostics, and host lifecycle.
- `agent-api-retirement.md` and `agent-protocol-retirement.md`: agent routes, authorization, idempotency, commands, and protocol behavior.
- `github-trigger-retirement.md`: trigger admission, polling, dispatch, and GitHub observations.
- `herdr-runtime-retirement.md` and `runtime-retirement.md`: provider runtimes, transcripts, coordination, workflow, and delivery behavior.
- `task-agent-selection-retirement.md` and `task-observation-retirement.md`: role selection, task reads, panes, worktrees, archive observation, and integration state.

Local fixture results do not prove live provider, CI, deployment, or external-service behavior. Those remain separate opt-in verification layers.

The Rust source-count baseline was refreshed after reviewing the added native
CLI/lifecycle support and migrated regression checks. The scanner is unchanged;
its counts include inline tests, including their database setup and JSON assertions.

Final local verification (2026-09-26): TypeScript typecheck and lint passed; 344 TypeScript tests, 728 Rust all-target tests (three intentional ignores), 11 browser tests, and all ten deterministic workflow journeys passed. Rust formatting, clippy with warnings denied, source-count checks, and the 222-route inventory passed. Both unsigned macOS architectures passed packaged launch/URL checks and disposable install/migrate/start/HTTP/stop checks; see `../../.context/typescript-retirement/packaging_verification.md`. The SQL migrations are byte-identical to the pre-retirement revision `6bb0a43f`.
