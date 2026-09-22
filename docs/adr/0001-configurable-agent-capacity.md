# Configurable agent capacity from the MVP

Suplex will admit concurrent, independent agent turns through configurable provider/profile capacity lanes, initially permitting two Codex turns. It prevents concurrent turns for the same issue-role session or worktree, and relies on Temporal retry backoff when a lane or provider is rate-limited. This makes throughput tunable without later redesigning admission, queueing, and capacity recovery.
