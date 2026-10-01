# Moves

For contributors changing Moves, this page explains what a move stores, how a
run starts work, and which system owns each fact. Sources:
[domain and tests](../../rust/src/moves/mod.rs),
[input rendering](../../rust/src/moves/prompt.rs),
[HTTP routes](../../rust/src/http/routes/moves.rs), and
[Moves page](../../src/frontend/features/moves/moves.tsx).

## Runners

A move is a project-scoped prompt or script with a runner.

| Runner | What a run does |
| --- | --- |
| `prompt` | Opens a Worker agent, interactive, in a host terminal. The agent is the move's agent profile, or the project's default Worker when the move has none. The agent receives the rendered prompt and keeps its normal permission prompts. A login shell stays open after it exits. |
| `script` | Runs the rendered text as a script in a login shell, in a host terminal. A login shell stays open after the script ends. A script move keeps no agent profile. |
| `pull_request_tasks` | Creates one queued Pull request repair task for each open pull request that is not excluded and has no open task, through `creation::create_browser`. The rendered prompt is the description of each task. The move's agent profile, when set, is the Worker of each task. |

A `prompt` or `script` terminal starts in a new worktree detached at
`origin/<base branch>`. A `prompt` run supports Claude Code and Codex agent
profiles that the project allows; Suplex checks the profile when you save the
move and again when a run starts. The terminal survives a closed browser tab,
and idle cleanup does not close it. It ends when you choose Stop, when you exit
the shell, or when Suplex stops. The run is live while its host terminal is
open. Suplex reads that from the terminal registry, not from a stored status.
When the terminal ends, Suplex stores its screen and scrollback with the run,
so an ended run still shows its output. The worktree stays after the run so you
can inspect it.

The Pull request repair runner reads open pull requests from GitHub when the
run starts, through the same discovery as the task source picker. Pull requests
that open after the start dialog loads are included unless you exclude them.
Exclusions are pull request numbers. They never enter the prompt.

## Inputs

Placeholders in the prompt declare inputs. `{{name}}` is text, and
`{{name: a | b | c}}` is a choice whose first option is the default. A name
used more than once is one input. Invalid placeholders stay as literal text.
The browser preview in `move-inputs.ts` mirrors the Rust parser. The server
parser is the authority.

`prompt::resolve` rejects unknown inputs, a choice value outside its options,
text over 2,000 characters, and NUL characters. `prompt::render` inserts a
choice as written and inserts text as a JSON string literal. Text input stays
delimited data in the prompt. In a script, that literal is a double-quoted shell
string, so the shell still expands `$` in it.

## History and ownership

A run row stores the rendered prompt, the resolved inputs, the exclusions, and
one outcome for each task or pull request: created, excluded, has a task, or
failed with a reason. It does not store task status. The page reads each
task's current status, so an archived, cancelled, or merged task shows its
real state. A start with a used idempotency key returns the recorded run. Task
idempotency keys include the run key, so a retry creates only missing tasks.

Archiving a run hides it from the run history and Activity, and ends its
terminal if it is live. The run stays readable by its ID.

A `prompt` or `script` run executes in an interactive terminal that you watch, so the Worker
Git and GitHub guard does not apply. The agent asks before it runs commands,
as it does in your own terminal.
