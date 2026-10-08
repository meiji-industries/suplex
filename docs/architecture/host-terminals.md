# Host terminals

For contributors who change a terminal that the Suplex host runs, this page
explains the registry, the kinds of host terminal, how a browser connects, and
the quick shell. Sources:
[registry and tests](../../apps/server/src/terminals/host.rs),
[terminal bindings](../../apps/server/src/terminals/mod.rs),
[WebSocket bridge](../../apps/server/src/http/routes/task_pane.rs),
[quick shell route and tests](../../apps/server/src/http/routes/quick_shell.rs),
[browser terminal](../../apps/web/features/tasks/task-chat/live-pane-terminal.tsx), and
[quick shell console](../../apps/web/shell/quick-shell.tsx).
Herdr panes are a separate transport; see [Herdr](herdr.md).

## The registry

`HostTerminals` keeps each terminal that the Suplex process owns: a PTY, its
child process, and a `vt100` emulator with 2,000 lines of scrollback. The
registry is the only authority for these terminals. Terminal IDs are derived
from the owner, not stored. An empty registry after a restart means the next
open starts a new terminal.

- `open(id, spec, cols, rows)` attaches to a running terminal, or starts one
  from `spec`.
- `attach(id)` attaches only to a running terminal.
- `contains(id)` is the live check. Move runs read it to report `live`.
- `close(id)` sends SIGHUP to the process group, and SIGKILL after one second.

A viewer that connects late, or falls behind, starts from a replay of the
emulator screen and scrollback. The replay never repeats the child's terminal
queries.

## Kinds of host terminal

| Kind | ID | Spec | Starts in | Lifetime |
| --- | --- | --- | --- | --- |
| Task Shell (experiment on) | `host-shell-<task>` | `Spec::shell` | Task worktree | Closed on archive, and when idle after the task finishes. |
| Session Mirror (experiment on) | from the session | `Spec::mirror` | Task worktree | Read-only; closes 5 seconds after its last viewer. |
| Provider sign-in | from the login | `Spec::sign_in` | Host | Ends when the sign-in command exits; idle cleanup closes it when the experiment is off. |
| Move run | `move-run:<run>` | `Spec::move_run` | Run worktree | Persistent. See [Moves](moves.md). |
| Quick shell | `quick-shell:<user>` | `Spec::quick_shell` | Home directory | Persistent. See [quick shell](#quick-shell). |

The Terminal settings page turns the host terminal experiment on for task
Shells and Mirrors; see [Herdr](herdr.md#host-terminals). Move runs and the
quick shell always use host terminals.

A persistent terminal stays open while no browser shows it. Idle cleanup
(`close_idle`) and task cleanup (`close_task`) leave it alone. It ends when
its process exits, when someone closes it, or when Suplex stops
(`close_all` at shutdown, which waits up to three seconds for each process).

Every spec starts its program with a reduced environment: `HOME`, `USER`,
`LOGNAME`, `PATH`, `TMPDIR`, `LANG`, `SSH_AUTH_SOCK`, `LC_*`, `SHELL`, `TERM`,
and `COLORTERM`. Suplex credentials, provider keys, and Herdr or Conductor
variables do not reach the terminal.

## Transcripts

`Spec::with_transcript(save)` gives the terminal's final screen and scrollback
to `save` when the process ends, for any reason, including shutdown. `save`
runs on a blocking thread before the terminal reports that it finished, so
shutdown waits for it. Move runs use this to store a transcript. Other kinds
keep none.

## Browser connections

A route upgrades to a WebSocket and calls `run_terminal` with
`Bridge::Host(viewer)`. The bridge sends `open`, then a replay, then live
output. Browser input and resize go to the terminal. When the terminal ends,
the socket closes, and `PaneTerminal` shows "Pane ended" unless its owner
passes `onEnded`. Each route checks the session, the CSRF rule, and the
origin, then its own access rule:

| Route | Access rule | Missing terminal |
| --- | --- | --- |
| Task pane routes | Task access | Starts a new one. |
| `/api/move-runs/{run}/terminal` | Project access through the move | Closes with 4404; the page shows the transcript. |
| `/api/quick-shell/terminal` | Admin | Starts a new one. |

## Quick shell

The quick shell is one persistent login shell for each admin, in their home
directory on the host. A Quake-style console shows it.

- **Access.** Only admins. The shell runs as the Suplex process user, so the
  route returns 403 to a member, and the sidebar button shows only for admins.
- **Persistence.** Closing the console only hides it. The shell keeps running
  and its scrollback returns on the next open, after a page change, or after a
  reload. Typing `exit` ends it; the console then closes, and the next open
  starts a new shell. A Suplex restart ends it.
- **Console.** `QuickShell` mounts once in the application shell. Ctrl+`
  toggles it, from anywhere, including from inside the shell (a capture-phase
  key listener runs before the terminal). The sidebar button calls
  `toggleQuickShell()`. The console slides down in 140 ms. Its height is 55%
  of the window, at most 640 px. The terminal mounts on open and unmounts after close.
- **Closing gestures.** Drag the bottom handle up: more than a quarter of the
  height, or a fast flick, snaps it shut; less springs back. A click below the
  console also closes it.
- **Look.** Phosphor-green chrome with a glow and faint scanlines, a very
  faint Suplex mark behind the terminal, and the normal terminal colors. With
  reduced motion, nothing animates.

## Known limits

- A Suplex restart ends every host terminal, persistent ones included. Herdr
  would keep a shell across restarts, but a shell outside a task has no Herdr
  binding yet.
- Scrollback, and so a transcript, keeps the last 2,000 lines.

See [unresolved work](unknowns.md).
