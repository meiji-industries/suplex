# Recovery

Suplex persists task intent, native session identity, and prompt dispatch ownership in SQLite. The native host resumes work from that intent and reads provider sessions, Git, and GitHub for execution and delivery evidence. A missing Herdr display token or a stale local observation is not a reason to block a task.

After a restart, session recovery reconnects to the current native session. If a prompt was prepared but its acknowledgment is uncertain, the runtime observes the native session before sending it again. It retries only when native evidence shows the prompt was not admitted. An ambiguous, already claimed turn is never replayed just because the host restarted. A lost OpenCode server can restart without replacing its native session.

Use the task's refresh action to obtain current task and delivery observations. For a stalled task, inspect the native session, worktree, Git branch, and GitHub pull request before retrying any operation. Keep commands scoped to the affected task. See [operations](agents/operations.md) for logs and development stack controls.
