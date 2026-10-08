# Moves

For contributors who change Moves, this page explains what a move stores, how a
run starts work, which system owns each fact, and where each part of the
feature lives. Sources:
[domain and tests](../../apps/server/src/moves/mod.rs),
[terminal runners](../../apps/server/src/moves/shell.rs),
[input rendering](../../apps/server/src/moves/prompt.rs),
[request contracts](../../apps/server/src/http/contracts/typed/moves.rs),
[HTTP routes](../../apps/server/src/http/routes/moves.rs),
[route tests](../../apps/server/tests/routes/moves.rs), and the
[Moves page](../../apps/web/features/moves/moves.tsx).
Terminal runs use the host terminal registry; see
[host terminals](host-terminals.md).

## What a move is

A move is a saved, project-scoped prompt, script, or task that a person starts
from the Moves page. Placeholders in its text declare inputs. Each start records a
run. There is no scheduling: a person starts every run.

| Field | Meaning |
| --- | --- |
| `name` | Unique in its project. |
| `prompt` | The text: a prompt, a script, pull request instructions, or a task description. Up to 20,000 characters. |
| `runner` | What a run does. See [runners](#runners). |
| `profile_id` | The agent profile for a `prompt` or `pull_request_tasks` move. Empty means the project's default Worker. A `script` move always has none. |
| `confirm` | When true, the start asks for a confirmation ("ask before start"). A `task` move always has false. |
| `workflow`, `delivery_target`, `run_project_tests`, `visual_evidence` | The settings of the task that a `task` move starts. Save requires a workflow other than `refine_pull_request` and a delivery target (422). Other runners store the defaults: `standard`, `pull_request_ready`, tests on, proof off. |

## Runners

| Runner | What a run does |
| --- | --- |
| `prompt` | Opens a Worker agent, interactive, in a host terminal. The agent receives the rendered prompt and keeps its normal permission prompts. A login shell stays open after the agent exits. |
| `script` | Runs the rendered text as a script in a login shell, in a host terminal. A login shell stays open after the script ends. |
| `pull_request_tasks` | Creates one queued Pull request repair task for each open pull request that is not excluded and has no open task, through `creation::create_browser`. The rendered prompt is the description of each task. |
| `task` | Creates one task through `creation::create_browser` and starts it at once. The title is the move name, the description is the rendered text when it is not empty, and the task uses the saved workflow, delivery target, tests, and proof. |

`prompt` and `script` are terminal runners. Their terminal starts in a new
worktree at `<worktree root>/move-<run id>`, detached at
`origin/<base branch>`. Suplex fetches the base branch first; a failed fetch
keeps the last fetched base, and the agent or script can fetch again. The
prompt gets a short preamble that names the worktree and tells the agent to
publish with `git push HEAD:<base branch>`.

The `pull_request_tasks` runner reads open pull requests from GitHub when the
run starts, through the same discovery as the task source picker. Pull requests
that open after the start dialog loads are included unless you exclude them.
Exclusions are pull request numbers. They never enter the prompt.

## Agent selection

`profile_id` selects the agent; `crate::tasks::commands::selected_profile`
resolves it against the project's provider policy.

- **Default.** With no `profile_id`, the run uses the project's
  `worker_profile_id`. When that profile is not allowed, `selected_profile`
  falls back to the first allowed Worker profile.
- **`prompt`.** The agent must have an interactive command line. Only Claude
  Code and Codex do (`shell::check_provider`). Suplex checks this when the
  move is saved and again when a run starts, because the profile or the
  project policy can change in between.
- **`pull_request_tasks`.** The profile becomes `workerProfileId` on each
  created task. Any Worker profile that the project allows is valid.
- **`script`.** No agent. Save clears `profile_id`.
- **`task`.** The task uses the project's Coordinator and Worker, and the
  workflow's default Advisors. Save clears `profile_id`.

The editor lists Worker profiles that the project allows. For a prompt it
lists only Claude Code and Codex profiles. "The default agent" shows the
avatar of the project's default Worker.

## Recommendations

`POST /api/projects/{project_id}/move-recommendations`
([`recommend.rs`](../../apps/server/src/moves/recommend.rs)) asks the project's
default Worker to read the repository once and propose moves. It saves
nothing. The person imports the moves they want through the normal create
route.

- **Agent run.** One headless call in the project's repository clone, with the
  person's login and the reduced user environment from
  [host terminals](host-terminals.md). Claude Code runs with `-p`,
  `--output-format json`, `--tools Read,Glob,Grep`, and `--strict-mcp-config`,
  so it cannot run commands, change files, use the web, start subagents, or
  load MCP servers. Codex runs `exec` with `sandbox_mode="read-only"` and
  `approval_policy="never"`. The default Worker must be Claude Code or Codex.
- **Prompt.** It lists dozens of places where projects define commands
  (package manifests, task runners, build files, CI, deploy configs, scripts,
  and docs). It explains the runners and the placeholder syntax, and asks for
  5 to 15 moves as one JSON object. It tells the agent to use only commands it
  found.
- **Parsing.** `extract` reads the result event, alone or last in an array of
  events, then the reply text, and takes the first JSON object with a `moves`
  list. `admitted` keeps only `script` and `prompt` moves with a name and text,
  drops names that repeat or that the project uses already, and keeps at most
  20.
- **Limits.** The call has a 5-minute limit (504). A reply without moves
  returns 502 with the last line of the agent's error output. A cancelled
  request ends the agent, because the child process dies with the request.

In the browser, [`recommend-moves.tsx`](../../apps/web/features/moves/recommend-moves.tsx)
shows a spinner and rotating shimmer phrases while the agent reads, then a
card for each move, all selected, with "Select none" and "Import N moves".
Import creates the selected moves one at a time and reports any that fail. The
result is cached for each project during the session (query key
`["move-recommendations", project]`), and "Read again" runs the agent again.
Recommendations whose names the project already uses stay hidden, so an import
never starts another read. With no moves, the Moves page starts reading at
once, under the empty state. With moves, "Recommend moves" in the header opens
the same panel in a dialog.

## Inputs

Placeholders in the text declare inputs. `{{name}}` is text, and
`{{name: a | b | c}}` is a choice whose first option is the default. A name
used more than once is one input. Invalid placeholders stay as literal text.
The browser preview in `move-inputs.ts` mirrors the Rust parser. The server
parser is the authority.

`prompt::resolve` rejects unknown inputs, a choice value outside its options,
text over 2,000 characters, and NUL characters. `prompt::render` inserts a
choice as written and inserts text as a JSON string literal. Text input stays
delimited data in the prompt. In a script, that literal is a double-quoted shell
string, so the shell still expands `$` in it.

## Starting a run

`moves::start` runs these steps:

1. Read the move and its project, and check access.
2. Return the recorded run when the idempotency key already has one.
3. Resolve and render the inputs.
4. For a terminal runner: resolve the agent (prompt only), build the command,
   create the worktree, and open the host terminal `move-run:<run id>`. For
   `pull_request_tasks`: discover pull requests and create the tasks. For
   `task`: create one task with the idempotency key
   `move:<move id>:<run key>:task` and `startImmediately`, and record one
   outcome, created with the task ID or failed with the reason.
5. Insert the run row and return it.

The browser decides how a start begins (`asksForInputs` in
`start-move-dialog.tsx`):

- A move with inputs, or a `pull_request_tasks` move, opens the start form.
  The form asks for a confirmation after it when `confirm` is true.
- Any other move with `confirm` shows only the confirmation.
- Any other move without `confirm` starts at once. The page ignores a second
  click while that start is in progress.

After a terminal run starts, the page opens the run's terminal. After a `task`
run starts, the page opens the created task.

## Run lifecycle

A run row stores the rendered prompt, the resolved inputs, the exclusions, and
one outcome for each task or pull request: created, excluded, has a task, or
failed with a reason. It does not store task status. The page reads each
task's current status, so an archived, cancelled, or merged task shows its
real state. A start with a used idempotency key returns the recorded run. Task
idempotency keys include the run key, so a retry creates only missing tasks.

A terminal run has these states:

| State | Authority | Notes |
| --- | --- | --- |
| Live | The host terminal registry | `live` in a response is read from `HostTerminals::contains` at read time. It is never stored. |
| Ended | The host terminal registry | The terminal is gone: you chose Stop, the shell exited, or Suplex stopped. |
| Archived | Suplex (`archived_at`) | Hidden from the run history, the moves list `lastRun`, Activity, and the Board. Still readable by ID. |

- **Stop** (`DELETE /api/move-runs/{id}/terminal`) closes the terminal.
- **Archive** (`POST /api/move-runs/{id}/archive`) sets `archived_at` once and
  closes the terminal if it is live. A repeated archive succeeds.
- **Transcript.** When the terminal process ends, for any reason, the host
  gives the screen and scrollback (up to 2,000 lines) to the run. Suplex
  stores it in `transcript_json` as `{cols, rows, output}`.
  `GET /api/move-runs/{id}/transcript` returns it, or 404 when there is none.
  An ended run shows it read-only in `run-transcript.tsx`. The page retries
  for a short time after Stop, because the save happens after the process
  exits.
- **Worktree.** The worktree stays after the run, archived or not, so you can
  inspect it. Nothing removes it yet.

Deleting a move deletes its runs (the foreign key cascades).

## HTTP routes

| Route | Purpose |
| --- | --- |
| `GET`, `POST /api/companies/{company_id}/moves` | List moves with each one's latest unarchived run, or create a move. |
| `PATCH`, `DELETE /api/moves/{move_id}` | Edit or delete a move. |
| `GET`, `POST /api/moves/{move_id}/runs` | Read up to 50 unarchived runs, newest first, or start a run. |
| `POST /api/projects/{project_id}/move-recommendations` | Ask the default Worker to propose moves. Saves nothing. |
| `GET /api/move-runs/{run_id}` | Read one run, archived or not. |
| `POST /api/move-runs/{run_id}/archive` | Archive a run. |
| `GET /api/move-runs/{run_id}/transcript` | Read a saved terminal. |
| `GET`, `DELETE /api/move-runs/{run_id}/terminal` | WebSocket view of a live run's terminal, or Stop. |
| `GET /moves`, `/moves/{move_id}`, `/moves/{move_id}/runs/{run_id}` | Browser pages. |

Every route checks the session and the CSRF rule, then project access through
the move. Browser types come from `apps/web/contracts/generated`
(`MoveResponse`, `MoveRunResponse`, `MoveRunsResponse`, `MovesResponse`,
`MoveRunTranscript`, `MoveRunner`). Fetches live in
[`move-api.ts`](../../apps/web/features/moves/lib/move-api.ts).

## Storage

| Table | Columns | Migrations |
| --- | --- | --- |
| `suplex_moves` | `id`, `company_id`, `project_id`, `name`, `prompt`, `runner` (`prompt`, `script`, `pull_request_tasks`, `task`), `profile_id` (null on profile delete), `confirm`, `workflow`, `delivery_target`, `run_project_tests`, `visual_evidence`, `created_by_user_id`, timestamps. Unique `(project_id, name)`. | `20261001003021651_add_moves`, `20261001014053320_run_moves_in_a_shell`, `20261001030651655_move_run_types_and_providers`, `20261005000102976_task_moves` |
| `suplex_move_runs` | `id`, `move_id`, `company_id`, `project_id`, `move_name`, `runner`, `prompt`, `inputs_json`, `excluded_pull_requests_json`, `outcomes_json`, `started_by_user_id`, `started_at`, `idempotency_key`, `archived_at`, `transcript_json`. Unique `(move_id, idempotency_key)`. | `20261001003021651_add_moves`, `20261001021153679_archive_move_runs`, `20261001021832268_save_move_run_transcripts` |

`20261001030651655` rebuilds `suplex_moves` to change its runner CHECK. It
renames the `shell` runner to `prompt` in moves and in run history. Migrations
run with foreign keys off, so the rebuild keeps run history.
`20261005000102976` rebuilds it again the same way to allow the `task` runner
and add the task settings columns.

## Browser surfaces

| Surface | Source | Behavior |
| --- | --- | --- |
| Moves list | `moves.tsx`, `MoveRow` | Tabs All, Live, and Ended; the ⌘K filter; the project filter; columns Move, Project, Runs, Status, and Last run; Start; a row menu with Delete. "Recommend moves" in the header, or the empty state, shows [recommendations](#recommendations). |
| Move page | `moves.tsx`, `RunHistory` | Run history. Live rows offer Stop, ended rows offer Archive, every row offers Start again. A row opens its terminal or task. Empty history offers Run now. |
| Run view | `move-run.tsx` | The terminal inside the app frame, with a bar for project, inputs, status, starter, Stop, Start again, full screen, and Close. Full screen shows the Suplex logo. |
| Editor | `move-dialog.tsx` | The New Task layout. A plain field for a prompt, a terminal-styled `ScriptEditor` for a script, and the option bar "Run … with … and …". For a task, the bar is "Run as a task using … with … then …" and reuses the New Task dialog's workflow icons and its tests, proof, and delivery controls (`task-settings-options.tsx`). Changing the runner resets the fields that no longer apply. A "Placeholders" link (`placeholders-help.tsx`) opens on hover or click, explains the input syntax, and lists the inputs in the draft. `DeleteMoveDialog` is shared with the row menu. |
| Start | `start-move-dialog.tsx` | Inputs, pull request exclusions, and the confirmation. |
| Activity | `features/tasks/recent-tasks.tsx` | Each move's latest terminal run, sorted by time with tasks. A Live badge offers Stop on hover; an Ended badge offers Archive. |
| Board | `features/tasks/tasks.tsx` | Terminal runs are cards in Delivered, newest first with tasks. The "Tasks and moves" filter (`?show=`) selects tasks, moves, or both. |

Activity and the Board read moves through `useShellRuns` in
[`move-runs.ts`](../../apps/web/features/moves/lib/move-runs.ts), one
query keyed `["moves", user, company]`. The [sync feed](sync.md) pushes every
move into it while its socket is open; otherwise it polls. `useRunActions` performs Stop
and Archive and refreshes that query. `runsInTerminal` is the one place that
decides whether a runner has a terminal.

The Moves and Tasks lists share `ListToolbar`, `ViewTabs`, `FilterInput`,
`DataList`, and `DataListRow` from
[`data-list.tsx`](../../apps/web/components/app/data-list.tsx), and
`ProjectSelect` from
[`project-select.tsx`](../../apps/web/components/app/project-select.tsx).

## Ownership and safety

A terminal run executes in an interactive terminal that you watch, so the
Worker Git and GitHub guard does not apply. The agent asks before it runs
commands, as it does in your own terminal. A script runs with your host user's
permissions, as in your own shell.

| Fact | Authority |
| --- | --- |
| The move, its runner, agent, and confirmation | Suplex |
| Whether a run is live | The host terminal registry |
| Task status for `pull_request_tasks` and `task` outcomes | The task, read at display time |
| Worktree contents and commits | Git |
| Open pull requests | GitHub, read when the run starts |

## Development note

The development data directory `.suplex` is inside the checkout. Vite does not
watch it: the Vite root is `apps/web`, and `apps/web/vite.config.ts` also ignores
`.suplex`. Otherwise a new run worktree adds files that Vite watches, Vite
reloads the page, and the reload cancels the start request.

## Known limits

- A start request that the client cancels while it runs can leave a worktree
  without a run row, because the handler stops at the cancel point.
- A command that ends in the moment between terminal open and the run insert
  keeps no transcript.
- Run worktrees accumulate. Archive does not remove them.
- A Suplex restart ends every live terminal run.

See [unresolved work](unknowns.md).
