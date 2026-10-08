# Session recovery

For maintainers diagnosing interrupted work, this page explains prompt recovery and safe process cleanup.

[Session recovery](../../apps/server/src/coordination/session_recovery.rs) reconciles saved
intent with native execution. An ambiguous dispatch is observed before retry;
an admitted prompt is not replayed simply because Suplex restarted. Recovery
requeues a claimed prompt only when the native runtime reports that retry is
safe. An admitted turn that stopped before a final answer leads to a new
continuation from current task and repository state, not a replay of its message.
A lost OpenCode server can restart while retaining its native session.

Process cleanup is separate from prompt admission. Recovery inspects a saved
launch owner's current process identity before stopping a retired session.
[Worktree cleanup](../../apps/server/src/tasks/archive/processes.rs) discovers likely
task processes from ownership markers, working directories, and descendants,
then checks the live process identity again before each signal. An uncertain
owner is left alone; a reused PID is not authority to stop a process. A
detached process that loses its markers, directory, and ancestry may be
impossible to attribute, and resources outside the process tree need their
own ownership record. Uncertain tool execution after a hard crash can require
cleanup confirmation. See [recovery](../recovery-hardening.md).

[Architecture index](README.md)
