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

The five Claude files above are retired. `cargo test --lib runtimes::claude_code` passed 25/25 on this checkout. The old live-history test also asserted the identity of a cached JavaScript array; Rust returns an owned value, while the observable completed-line behavior remains covered.

The Codex analytics/transcript, Devin, OpenCode, and Worker evidence files in the table are also retired. `cargo test --lib runtimes::` passed 156/156 native runtime tests on this checkout; the file-by-file mapping above identifies the corresponding assertions. `codex-runtime.test.ts` remains under review because its headless lifecycle cases are broader than the direct native runtime tests.

The archive-session file is retired. `cargo test --lib archive_uses_live_native_and_git_facts_then_commits_once` passed; its native operation test covers all six TS session-ownership cases against the database and native server fixture.

## Remaining assigned files under review

`codex-runtime.test.ts`, `delivery-operations.test.ts`, `github-delivery.test.ts`, `root-bridge.test.ts`, `root-controller-delegation.test.ts`, `root-controller-lifecycle.test.ts`, `root-controller-limits.test.ts`, `root-controller-recovery.test.ts`, `task-archive-displays.real.test.ts`, `task-archive-displays.test.ts`, `task-host.test.ts`, `worker-environment.test.ts`, `worker-replacement-api.test.ts`, `worker-replacement.test.ts`, `workflows-delegation.test.ts`, `workflows-delivery-repairs.test.ts`, `workflows-delivery.test.ts`, and `workflows-intake.test.ts`. These need a file-by-file coverage decision before deletion. The real Herdr test requires a separate native real-environment equivalent; fake Rust tests do not claim it.
