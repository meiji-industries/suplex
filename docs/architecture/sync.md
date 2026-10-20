# Company sync feed

For maintainers who change what the browser shows without a reload, this page
explains the company sync socket: what the host observes, what it pushes, and
how the browser falls back to HTTP polling. Sources:
[feed](../../apps/server/src/sync.rs),
[socket route](../../apps/server/src/http/routes/sync.rs),
[wire types](../../apps/server/src/http/contracts/task_reads.rs),
[socket client](../../apps/web/features/tasks/lib/task-sync-api.ts),
[cache writes](../../apps/web/features/tasks/task-data.tsx),
[query timing](../../apps/web/shell/sync.ts), and
[task queries](../../apps/web/features/tasks/lib/task-queries.ts).
The [feed tests](../../apps/server/tests/sync/feed.rs),
[route tests](../../apps/server/tests/routes/sync.rs), and
[browser tests](../../apps/web/tests/task-sync.test.tsx) pin the behavior below.

## What the feed observes

`CompanyFeed` keeps one channel for each company with an open socket and one
watch for each socket that shows tasks. Two threads read the values. Each opens
its own read-only database connection and stops when nothing subscribes.

| Signal | What it reports | Thread and interval |
| --- | --- | --- |
| `PRAGMA data_version` | A commit by any other connection: the host, or another process such as `suplex mcp root` ([internal commands](cli.md)). A hook inside the host process does not see commits from other processes. | Tail, every 50 ms |
| Host terminal registry | A move run's terminal or a task Shell opened or closed. The registry is in memory, so no commit reports it. | Tail, every 50 ms |
| Timer | Native runtime session files, which report no change. | Runtime observer, every second |

`data_version` is database-wide. Any commit makes the tail read again the lists
of every subscribed company and the stored values of every open task.

## What is pushed

| Value | Scope | Read again on | Frame field | Browser query key |
| --- | --- | --- | --- | --- |
| Active task list, including each task's first recorded native execution timestamp | Company | Commit | `tasks` and `removedTaskIds`, diffed by task id | `taskListKey(user, company)` |
| Moves, each with its last run | Company | Commit, or a last run's terminal opens or closes | `moves`, whole | `movesKey(user, company)` |
| Task costs | Company | Change of the stored usage rows that the costs read. The recompute runs apart from the tail thread. | `costs`, whole | `taskCostsKey(user, company)` |
| Projects | Company | Commit that changes a project of the company | `projects`, whole | `projectsKey(user, company)` |
| Agents of watched tasks | Watch | Each observer pass (1 s) | `agents`, one entry per changed task | Each `["task-agents", user, company, ids]` batch that holds the task |
| Task health of watched tasks: `health.providers` (provider, sign-in status, summary, and probe time of each login that the task's profiles use), `health.retries`, `health.lastProgressAt`, and `health.usualTurnSeconds` | Watch | Each observer pass (1 s), in the same entry as the agents. A provider probe runs at most once per login in 60 s. | `agents[].health` | Same batches as the agents |
| Open task | Watch | Commit | `openTask.task` | `taskObservationKey(...)` + `"task"` |
| Open task activity | Watch | Commit, its task Shell opens or closes, or setup state changes | `openTask.activity` | `+ "activity"` |
| Open task execution and timeline | Watch | Every second observer pass (2 s) | `openTask.execution`, `openTask.timeline` | `+ "execution"`, `+ "timeline"` |

Each pushed value is the body of its HTTP endpoint; the route tests compare
them. A published value keeps its allocation while it does not change, so a
socket compares pointers to decide what to send. The feed test asserts that a
turn committed by another connection reaches the watch within 500 ms.

**Task health.** [`tasks::health`](../../apps/server/src/tasks/health.rs)
defines each value. `retries` adds the requeues of each current session's
newest turn, its run of interrupted-execution continuations, the Worker and
Advisor replacements of the same assignment, and the native OpenCode retry
attempt. `lastProgressAt` is the newest turn completion or native update of an
active task, to the minute, so a busy session does not send a frame each
second. `usualTurnSeconds` is the median turn time. The browser shows no
progress when the time since `lastProgressAt` is more than 10 minutes and more
than twice `usualTurnSeconds`. The sign-in comes from one host-wide cache in
[`connection_cache`](../../apps/server/src/profiles/connection_cache.rs) that
calls the probe of Settings. Tasks on one login share one probe. A read never
waits for a probe: before the first probe ends it returns `unknown`, and after
60 s it starts one probe in the background and returns the previous
observation. A later observer pass sends the result.
These values are display observations. No command, control, or task status
depends on them. Active board cards (at most 50) and the open active task watch
them; without the socket they poll the agents route in batches of 10.

**Watches.** Components declare what they show with `useSyncWatch`.
`TaskDataProvider` sends one `watch` request with every declared agent task and
the first declared open task, 50 ms after the last declaration changes. Each
request replaces the socket's watch, and the client sends the last request again
after each reconnect. The server reads agents for the first 50 ids and keeps an
id only when the user can read the task, it belongs to the socket's company,
and it is not archived. The open task can be archived. A watch without a
remaining id sends nothing.

**What still polls.**

| Request | Interval | Why it is not pushed |
| --- | --- | --- |
| Task setup log | 1 s while setup runs or a read fails | Reads the setup log from the preparation directory. Stops after the runner records completion. |
| [Checks](../../apps/web/features/tasks/lib/task-checks.ts) | 15 s while a run is pending or the read failed, else 60 s. Read again when the pull request number, state, or head SHA of the task changes. | The route reads GitHub at request time. |
| [Diff summary and patch](../../apps/web/features/tasks/lib/task-queries.ts) | 5 s, or 60 s while the socket is live. Read again when a pushed task or execution changes, at most one time in 5 s. | The route reads the worktree; the feed has no worktree signal. |
| [A move run that is not the last run](../../apps/web/features/moves/move-run.tsx) | 3 s | The feed carries only each move's last run. |
| [Archived task list](../../apps/web/features/tasks/tasks.tsx) | 3 s, or 60 s while live. Read again when a task enters or leaves the active list. | The feed publishes active tasks only. |
| [Today](../../apps/web/features/today/today.tsx), [Analytics](../../apps/web/features/analytics/analytics.tsx), and [Timeline](../../apps/web/features/timeline/timeline.tsx) pages | 30 s, 30 s, and 60 s, with or without the socket | The feed publishes no value for these pages. |

## Frames

| Frame | From | Content |
| --- | --- | --- |
| `snapshot` | Server | Every active task, every move, and every project, and the task costs when the feed has them. The first frame of a connection, sent once the feed has read the company. If the first cost read is not complete, a later `changes` frame carries the costs. |
| `changes` | Server | Tasks that are new or different, ids that left the active list, and `moves`, `costs`, or `projects` when one of them changed. An empty `changes` frame every 15 s is the heartbeat. |
| `agents` | Server | `TaskAgents` for each watched task whose agents changed. The first one after a `watch` has every watched task the server could read. |
| `openTask` | Server | `taskId` and each of `task`, `activity`, `execution`, and `timeline` that changed. The first one after a `watch` has every value the server could read. |
| `watch` | Browser | The tasks that the tab shows now. |

The first frames of a watch wait until each reader tried each watched value
once. A new watch wakes the runtime observer. A value that another socket's
watch already read goes out at once.

A frame carries current values, not events. Applying it replaces the cached
value, so applying the same frame twice gives the same cache. The feed's
channels hold only the newest value. A slow socket skips intermediate states
and sends the difference between what it last sent and the newest value. Task
changes that arrive before the browser has a list are ignored; the HTTP read or
the next snapshot fills the list.

The browser opens the socket on every page except admin, profile, and company
settings ([`showRecentTasks`](../../apps/web/features/tasks/lib/task-list.ts)).
A pushed value cancels an HTTP read of the same key that is in flight, so an
older read cannot replace it. A command response and a pushed task resolve by
`updatedAt`; the newer one stays. A pushed execution change reads the diff
again. A change in which tasks are active reads the archived list again.

## Authority

The feed follows [read the owner; never add mirror gates](principles.md#read-the-owner-never-add-mirror-gates).
A published value and the browser cache that it fills are display observations.
The socket accepts only `watch`. Every command stays a REST route that
authorizes on the server when it runs, and a failed cache write does not turn a
successful command into a failure (`useTaskCache`).

`syncedPolling` sets each synced query's interval. While the socket delivers
frames, each query reads again every 60 s to repair a missed frame. When the
socket closes, goes silent, or is not available, each query polls at its HTTP
interval: 3 s by default, 5 s for execution, timeline, and the diff, and 30 s
for costs. Do not disable a control, reject a command, or ask for a reconnect
because the socket is down or a pushed value is old. Test a new pushed value
with the socket open, closed, and never opened, as
[verify the action, not the mirror](principles.md#verify-the-action-not-the-mirror)
describes.

## Adding a pushed value

1. **Reader.** Add a `pub(crate)` read without a user beside the HTTP read in
   the owning domain module, documented "for the sync feed. The caller
   authorizes.", such as [`list_active`](../../apps/server/src/tasks/repository.rs),
   [`list_company`](../../apps/server/src/moves/mod.rs), or
   [`company_analytics`](../../apps/server/src/tasks/analytics/mod.rs). The HTTP route
   keeps its own access check. The socket checks company access at upgrade and
   on each heartbeat, and checks watched ids in `start_watch`.
2. **Publish.** For a company value, read it in `publish`, add an `Arc` field
   to `CompanyLists`, keep the previous allocation with `kept` (or `kept_json`
   for a type without `PartialEq`), and add it to the comparison there. For a
   task value, read a stored value in `tail` or a native value in `observe`,
   add it to `OpenValues`, keep it with `kept_json`, and compare it in
   `publish_watched`. A value that changes without a commit needs its own
   signal, as the terminal registry checks do, or the observer timer.
3. **Send.** In the route, put the value whole in `Snapshot`, and in `Changes`
   only when `Arc::ptr_eq` reports a change; for a watch, use `fresh` in
   `watch_frames`. Add it to the check for an empty frame, and set it to `None`
   in the heartbeat frame.
4. **Wire.** Add the field to `SyncMessage` with the response type of its HTTP
   endpoint. An optional field uses `skip_serializing_if = "Option::is_none"`
   and `#[ts(optional)]`. `cargo test` writes
   [`SyncMessage.ts`](../../apps/web/contracts/generated/SyncMessage.ts);
   commit it.
5. **Browser.** In `TaskDataProvider`, `push` the value into the query key that
   the HTTP query for the same value uses, and give that query
   `syncedPolling(useSyncLive(), interval)`. A task value also needs
   `useSyncWatch` in the component that shows it.
6. **Tests.** Show that the feed publishes a commit from another connection,
   that the frame equals the HTTP body, and that the browser applies the frame
   and polls without a socket.

## Failure and recovery

| Condition | Server | Browser |
| --- | --- | --- |
| The feed cannot open the database or read `data_version` | Drops every company channel and its connection. | The socket closes with 1013 `feed stopped`. The browser polls and reconnects; the new subscription starts a new read. |
| One company's lists cannot be read | Drops that company's channel. | Same as above. |
| A watched value, the projects, or the costs cannot be read | Keeps the previous value. | No change. |
| A send takes more than 10 s | Closes with 1013 `client too slow`. | Reconnects and starts from a snapshot. |
| The session ends or the membership is removed | The heartbeat check, every 15 s, closes with 4403 `access revoked`. | Reconnects; the upgrade fails its access check, as HTTP reads do. |
| Unknown company, or a foreign origin | The upgrade fails with the HTTP error, or the socket closes with 4403 `origin`. | Reconnects. |
| A browser frame that is not a valid `watch` | Closes with 1008 `invalid request`. | Reconnects. |
| Server shutdown or restart | Closes with 1012 `server closing`. The feed keeps no state across a restart. | Polls, and reconnects after 1 s, doubling to at most 10 s. Any frame resets the delay. On open, sends the last watch again and receives a snapshot. |
| Half-open socket | Sends a frame at least every 15 s. | Treats 45 s without a frame as a closed socket. |
| No `WebSocket` in the browser | None. | Polls. |

## Known ceilings

- Each commit, from any company, makes the tail read again the whole active
  task list, every move, and every project of each subscribed company, and hash
  all of the company's stored usage. The ignored test `refresh_time_at_scale`
  measures one refresh and one cost read at 500, 2,000, and 5,000 active tasks,
  each with a Coordinator session and 10 usage records. The comment on `tail`
  records 4 ms, 15 ms, and 39 ms per refresh in a release build.
- A cost read computes the analytics of every task of the company. It runs on
  its own thread, so it does not delay a refresh. The comment on `read_costs`
  records 0.08 s, 0.33 s, and 0.8 s for one read at those sizes.
- Each socket diffs the whole task list by id. Moves, costs, and projects go
  out whole when one entry changes.
- A watch reads agents for at most 50 tasks, and one open task.
- The runtime observer parses the native files again on each pass, even when
  they did not change.

[Architecture index](README.md)
