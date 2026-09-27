# Native provider runtimes

For maintainers adding or diagnosing an agent provider, this page explains native execution and its display limits.

[TaskHarness](../../rust/src/runtimes/task_harness.rs) supplies session setup,
dispatch, observation, recovery, and stop behavior. Its read-only session reader
provides history, execution detail, and usage. The
[registry](../../rust/src/runtimes/task_harness_registry.rs) selects by profile
provider. The host consumes a common prompt observation, including admission,
result state, running processes, unsettled tools, and whether retry is safe.

| Provider | Execution and session data | Display implementation |
| --- | --- | --- |
| OpenCode | A managed native server receives prompts through its API; the runtime reads native session history. A Suplex reservation is paired with the native session ID. | Native attach identity matching exists. See the attachment limitation after this table. |
| Claude Code | Headless turns use the reserved native session ID and resume the provider transcript. | A Suplex viewer follows headless turn logs; it does not start an interactive Claude session. |
| Codex CLI | Headless turns record native JSON events. A Suplex routing ID maps to the native thread ID used for resume. | A Suplex viewer renders turn events and stderr. |
| Devin CLI | Headless turns record output and export data used to discover the resumable native session identity. | A Suplex output viewer exists; it does not take interactive ownership of the native session. See the attachment limitation after this table. |

Claude and Codex dispatch call the shared display attachment path.
OpenCode has attach matching and Devin has a viewer, but the inspected runtime
paths do not call that attachment path. Do not infer automatic pane attachment
for all four providers from the presence of their modules. This is a source
limitation to investigate when working on those providers, not a new launch gate.

The runtime does not require a model warm-up turn merely to open a log
viewer. Devin can read an old warm-up export when recovering session identity;
that compatibility read is not a current warm-up workflow.

Provider code lives under [runtimes](../../rust/src/runtimes/). Shared headless
execution records process identity and per-turn files; recovery uses the native
result and process observations rather than treating a wrapper exit alone as
proof that every tool finished.

Headless processes need the host's executable path and tool configuration.
[Claude dispatch](../../rust/src/runtimes/claude_code/task_runtime.rs) starts with
the inherited environment, applies the Worker Git guard where needed, then
adds task and project settings. A dedicated Claude login keeps general host
settings such as `PATH` and `HOME` but removes inherited Claude credentials
and routing settings before selecting its own configuration directory. The
Herdr display Shell is a different process: a command succeeding there does
not establish that the headless agent has the same authentication.

[Architecture index](README.md)
