# Runtime and state ownership

For maintainers tracing host and browser responsibilities, this page explains process ownership, scheduling, and cached observations.

Sources: [task host](../../apps/server/src/tasks/host.rs),
[host health](../../apps/server/src/platform/health.rs),
[setup view](../../apps/web/features/settings/setup.tsx),
[desktop local runtime](../../apps/desktop/src-tauri/src/local_runtime.rs), and
[shared task data](../../apps/web/features/tasks/task-data.tsx).

The Rust host serves the HTTP API and runs task scheduling beside SQLite. The
React frontend reads those APIs. The Tauri desktop app (a Rust shell around
WKWebView) can run the bundled host locally or connect to another installation. Development uses a native host
with Vite for frontend updates. See [instances, clients, and distribution](deployment.md) for the deployment
model and the [README](../../README.md) for setup.

| Owner | State it owns |
| --- | --- |
| Suplex / SQLite | Task intent, captured settings, authorization, role assignments, prompt dispatch ownership, and review records |
| Native agent runtime | Admitted prompts, conversation history, tool execution, and turn results |
| Git | Worktrees, branches, commits, and local changes |
| Repository service | Remote branches, PRs, checks, and merges |
| Herdr | Pane layout, terminal processes, and display observations |

The [task host](../../apps/server/src/tasks/host.rs) combines explicit wake notifications
with periodic sweeps. Sweeps recover work after startup or a lost notification.
Separate background work refreshes PR prerequisites, GitHub trigger rules, and
analytics. Native execution is not driven by terminal text or pane status.

When a sweep cannot dispatch a Coordinator or Worker turn, or the idle
Coordinator wake waits for its backoff delay, the host stores one
[dispatch notice](../../apps/server/src/coordination/dispatch_notice.rs) for
the task. The task activity read shows it, so the Chat and Activity tabs say
why no turn starts. The notice is a display observation. Dispatch never reads
it, retries continue, and the task status does not change. A prompt admission
or a task status change clears it.

The desktop app starts a bundled local host on a loopback address after its
install stages finish. It waits for `/health` before opening the application.
It adopts an existing host only when that host reports the same installation
identity; quitting the app stops only a process group that this app started.
The [desktop boot code](../../apps/desktop/src-tauri/src/boot.rs) resumes a recorded local
install and reruns install stages when the bundled runtime changes.

The authenticated [health route](../../apps/server/src/http/routes/health.rs) checks
host tools and the providers selected by a project or profile. Setup can
refresh those observations when it regains focus or the user selects Check
again. The health snapshot explains repairs; it does not authorize task
commands. Continue opens tasks even when a check is unhealthy or stale. A
command that needs an unavailable tool reports the actual prerequisite failure
at its operation boundary. Provider sign-in checks do not prove model access.

The task list and recent-task sidebar share one foreground query. Recent-task
agent rows use one company-scoped batch read through the
[task-agent route](../../apps/server/src/http/routes/task_agents.rs). The batch reduces
browser requests while native status reads still run for its tasks. While the
[company sync socket](sync.md) is open, the host pushes changes into these
caches and the reads repeat every 60 seconds; without it, they poll. The
[query client](../../apps/web/shell/server-state.tsx) is scoped to the
signed-in user and clears private data on sign-out. Query caches are display
observations: stale or failed reads do not change command authorization, and
cache update failures do not turn a successful task command into a failure.

[Architecture index](README.md)
