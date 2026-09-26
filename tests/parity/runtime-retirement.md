# TypeScript runtime test retirement

The TypeScript production engine is being retired. This ledger maps backend-only test files to native Rust tests before deletion. The TypeScript files are dated implementation evidence; a Rust test must exercise the same user-visible or recovery condition to replace one. Deterministic native tests, browser journeys, installed provider checks, and real Herdr checks are separate evidence layers.

Source comparison revision: `6bb0a43f`. `cargo test --lib` runs the embedded Rust unit and route tests. Paths below are relative to `rust/src` unless shown otherwise.

| Retired TypeScript file | Native test owner and preserved guarantee | Status |
| --- | --- | --- |
| `claude-code-display.test.ts` | `runtimes/claude_code/display.rs`: directory-scoped command, secret clearing, catch-up/follow, partial UTF-8/JSON, oversized records, tool/web-search rendering, ordered large turns | direct |
| `claude-code-environment.test.ts` | `runtimes/claude_code/task_runtime.rs`: dedicated config isolation, caller configuration, bridge environment, Worker permission boundary | direct |
| `claude-code-live-history.test.ts` | `runtimes/claude_code/live_history.rs`: block replacement, transcript completion, partial JSON and split UTF-8 | direct; split UTF-8 ported |
| `claude-code-runtime.test.ts` | `runtimes/claude_code/{task_runtime,session_reader,display}.rs`: dispatch, busy/uncertain exits, local instance, role policy, evidence and native session lookup | direct |
| `claude-code-transcript.test.ts` | `runtimes/claude_code/transcript.rs`: tools/plans/history, immutable block identity, usage, cross-project lookup | direct |
| `codex-analytics.test.ts` | `runtimes/codex/usage.rs`, `tasks/analytics/collector.rs`: cumulative counters, dispatched model, pricing/missing usage | direct |
| `codex-transcript.test.ts` | `runtimes/codex/{transcript,tool_evidence,usage}.rs`: malformed lines, tools, unsettled work, cumulative usage and pricing | direct |
| `devin-analytics.test.ts` | `runtimes/devin/session_reader.rs`: native session usage in the runtime directory | direct |
| `devin-runtime.test.ts` | `runtimes/devin/{task_runtime,session_reader,display,harness,mcp_config}.rs`: resume, busy/errors, timeline, display, routing, config, Advisor result recovery | direct |
| `opencode-attachment.test.ts` | `runtimes/opencode/task_runtime.rs`: pane/server/session/directory ownership and safe attachment recovery | direct |
| `opencode-client.test.ts` | `runtimes/opencode/{client,contracts}.rs`: native v1 routes, envelopes, auth, redaction, abort, MCP GET and failures | direct |
| `opencode-dispatch-recovery.test.ts` | `runtimes/opencode/{session,task_runtime}.rs`: fenced admission, absent/admitted/busy/tool-error/unknown history, replacement server | direct |
| `opencode-server.test.ts` | `runtimes/opencode/server.rs`: role permissions, idle-only bridge refresh, attach secrets and process identity | direct |
| `opencode-session-history.test.ts` | `runtimes/opencode/{session_history,session_reader}.rs`: immutable spend/history, session binding, large output and tool/text IDs | direct |
| `opencode-session.test.ts` | `runtimes/opencode/session.rs`: native final/tool state, compaction, lost acknowledgment, status errors, idle confirmation, exact prompt correlation | direct |
| `worker-turn-evidence.test.ts` | `coordination/worker_evidence.rs`: selected native tool IDs, head/tail cursors, UTF-16 budget and failure text | direct |
| `task-archive-sessions.test.ts` | `tasks/archive/operations.rs`: incomplete/stale launch identity, missing server, native busy versus stale database state, idle native server stop, and active operation ownership | direct |
| `worker-environment.test.ts` | `runtimes/git_guard.rs`: read and mutation policy, atomic executable refresh, real task rebase and conflict abort, all blocked push forms against an unchanged remote | rebase and refresh ported |
| `task-archive-displays.test.ts` | `tasks/archive/displays.rs`: workspace and pane discovery, live ownership, missing observations, shell cleanup, command termination and escalation, group refusal fallback and retry | direct; escalation and unowned process ported |
| `task-archive-displays.real.test.ts` | Ignored `tasks/archive/displays.rs::archive_closes_a_real_owned_herdr_workspace_and_its_process`: isolated live workspace, two metadata-bound panes, real sleep process, workspace/pane closure, process death, idempotent close | native real proof ported; unrun here |
| `worker-replacement.test.ts` | `coordination/root_session_store.rs` via `rust/tests/coordination/store.rs`: profile policy and dedicated login, saved handoff and native readiness, idempotency, reopen, repeated/stopped replacement and frozen Coordinator prompt hashes | policy and stopped-session cases ported |
| `worker-replacement-api.test.ts` | `http/routes/tasks.rs` via `rust/tests/routes/tasks.rs`: authenticated route, durable replacement, status and budget pause preservation, idempotent response, cleanup readiness | auth and pause cases ported |
| `workflows-intake.test.ts` | `coordination/{workflows,workflow_records,advisor_bridge,root_prompts}.rs`, `tasks/{commands,sources}.rs`, `rust/tests/routes/{tasks,task_templates,workflows,agent_api}.rs`, `rust/tests/platform/migrations.rs`: catalog, normalization, report parsing, review gate, fixed repair target/open same-repo source, hash, templates, legacy rows, exact prompts | repair source case ported |
| `root-bridge.test.ts` | `coordination/{root_bridge,root_stdio,root_controller}.rs`, `rust/tests/coordination/{host,store}.rs`, `tests/interop/root-{image,worker-evidence,worker-replacement,delivery-inspection}.ts`: authenticated MCP initialization, advertised typed tool, durable task-scoped calls, image integrity and ownership, stale root binding, bounded Worker evidence, Worker replacement, reviewed delivery, invalid request combinations | direct; invalid evidence and PR text table ported |
| `task-worktree.test.ts` | `tasks/worktree.rs`, `tasks/archive/operations.rs`, `runtimes/headless.rs`, `rust/tests/coordination/host.rs`: authoritative Git reobservation, retained commits/dirty/rebase work, foreign path and branch ownership, concurrent materialization, archive process ownership, detached shutdown child, session and dispatch cleanup | concurrency and exact recovery cases ported |
| `task-host.test.ts` | `tasks/{host,preparation,worktree,issue_context}.rs`, `delivery/{operations,completed_pull_requests,tests}.rs`, `rust/tests/coordination/host.rs`: admission/preparation/restart, linked issue failures, GitHub outage and wait observation, out-of-band delivery before native launch, ambiguous prompt recovery, delivered PR batch refresh and one-minute polling | conflicted rebase and stopped-session PR polling ported |

The five Claude files above are retired. `cargo test --lib runtimes::claude_code` passed 25/25 on this checkout. The old live-history test also asserted the identity of a cached JavaScript array; Rust returns an owned value, while the observable completed-line behavior remains covered.

The Codex analytics/transcript, Devin, OpenCode, and Worker evidence files in the table are also retired. `cargo test --lib runtimes::` passed 156/156 native runtime tests on this checkout; the file-by-file mapping above identifies the corresponding assertions. `codex-runtime.test.ts` remains under review because its headless lifecycle cases are broader than the direct native runtime tests.

The archive-session file is retired. `cargo test --lib archive_uses_live_native_and_git_facts_then_commits_once` passed; its native operation test covers all six TS session-ownership cases against the database and native server fixture.

The Worker Git guard file is retired. `cargo test --lib runtimes::git_guard` passed 4/4, including the new filesystem replacement and local-remote rebase regressions.

The deterministic and real Herdr archive-display files are retired. `cargo test --lib tasks::archive::displays` passed 12 tests with one ignored live test. The live test compiles but was not run: `HERDR_ENV` is absent, and `HERDR.md` permits Herdr control only from a managed pane. Run its ignored Rust test from a Herdr-managed pane to renew the external proof.

The Worker replacement service and API files are retired. `cargo test --lib worker_and_coordinator_replacement_preserve_handoffs_and_native_readiness` and `cargo test --lib local_backlog_create_fetches_git_and_returns_full_task_shape` both passed with the new policy, stopped-session, authenticated-route, and limit-pause assertions.

The workflow-intake file is retired. `cargo test --lib workflow` passed 16/16, `advisor_reports` 2/2, and `standard_request_hash` 1/1. The focused `repair_pull_request_rejects_closed_and_foreign_sources_and_pins_the_open_head` native source test also passed. Existing native template and migration fixture tests provide the remaining persisted/legacy coverage; they were not rerun in this focused wave.

The Root bridge file is retired. `coordination::root_stdio` and `coordination::root_bridge` native tests cover the tool schema, argument validation, binding identity and token handling. Private-binary `root-image`, `root-worker-evidence`, `root-worker-replacement`, and `root-delivery-inspection` journeys passed against Rust MCP stdio, including invalid-token rejection before initialization and durable task-scoped operations. The native invalid evidence query and pull request text table was added before retirement.

The task-worktree file is retired. `cargo test --lib tasks::worktree::tests` passed 4/4 after a bounded native retry fixed a real concurrent Git branch lock race. Focused native `stop_rescans_and_stops_a_detached_child_created_during_shutdown`, `retired_session_cleanup_preserves_another_session_in_the_same_worktree`, and `dispatch_recovery_stops_the_old_execution_without_stopping_its_replacement` tests passed. The worktree tests assert exact Git status, conflict/rebase files, retained out-of-band commit bytes, foreign directory contents, and convergence of simultaneous creation; the archive operation test covers detached worktree process ownership.

The task-host file is retired. The native sweep reads delivery state before deciding whether an active task needs worktree preparation or a native session, and keeps delivery-wait observation separate from ordinary observation. Host/preparation tests cover native dispatch, durable claims, setup context and failure recovery; issue-context tests cover provider failures. The worktree conflicted-rebase test and delivered-PR refresh integration were added in this retirement wave. The missing one-minute refresh after all sessions stop was fixed in `tasks::host::tests::delivered_pull_refresh_starts_immediately_retries_and_stops_with_host`, which passed; the native delivered-PR integration also covers in-flight resumption, missing receipts, provider failures, reopening, and merged facts.

## Remaining assigned files under review

`codex-runtime.test.ts`, `delivery-operations.test.ts`, `github-delivery.test.ts`, `root-controller-delegation.test.ts`, `root-controller-lifecycle.test.ts`, `root-controller-limits.test.ts`, `root-controller-recovery.test.ts`, `workflows-delegation.test.ts`, `workflows-delivery-repairs.test.ts`, and `workflows-delivery.test.ts`. These need a file-by-file coverage decision before deletion.
