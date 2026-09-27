# Suplex

[![CI](https://github.com/meiji-industries/suplex/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/meiji-industries/suplex/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-26.7.0-brightgreen)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-11.22.0-orange)](package.json)

Suplex runs repository tasks through OpenCode, Claude Code, Devin CLI, Codex CLI, Git, and GitHub. One continuing
Root session plans and reviews the work. A scoped Worker edits, verifies, and
commits in the task worktree. Herdr displays those native sessions.

The [product guide](docs/product.md) describes the workflow. [CONTEXT.md](CONTEXT.md)
defines its terms. [Architecture decisions](docs/adr/) record the history.

An agent that never opens the web application starts at
[machine discovery and the operator handoff](docs/agents/machine-discovery.md).
Suplex serves `/llms.txt`, `/.well-known/suplex/api-catalog.json`, and
`/.well-known/suplex/agent-skills.json` without authentication. That document also
holds the operator handoff: issue, rotate, and revoke a pairing, restrict project
grants, and verify an agent integration after an upgrade.

## State ownership

| Owner | Authoritative state |
| --- | --- |
| Suplex | Task objective, configuration, start and cancel intent, questions, session assignment, prompt dispatch ownership |
| OpenCode | Native sessions, admitted messages, tool execution, and turn results |
| Git | Worktrees, branches, commits, and uncommitted changes |
| GitHub | Remote branches, pull requests, checks, reviews, and merges |
| Herdr | The visible attachment to a native session |

Suplex runs a native API and task host beside a SQLite database. There is no
phase engine, Temporal history, separate integrator agent, or completion-file
protocol. Database records preserve Suplex-owned intent and correlate native
observations. They do not require a second copy of GitHub progress.

Root delegates one Worker at a time and ends its turn. The Worker result wakes
the same Root session. Root can request a normal push, pull request creation,
review readiness, or an exact-head merge. GitHub enforces its own merge policy.
Delivery targets also include a local worktree and a remote branch.

An out-of-band edit, commit, push, or matching pull request is observed and
retained. Restart does not discard the worktree or replay an admitted prompt.
A lost prompt acknowledgment is retried only after the old dispatch process
is stopped and native history proves that the message was not admitted.

## Recovery limits

Herdr display failures do not stop native work. Suplex retries the attachment.
Provider observation failures do not turn into failed CI checks.

OpenCode can launch shell commands in separate process groups. A hard server
crash during a tool call can leave a command alive. Suplex retains that turn and
asks you to stop the old commands before explicitly confirming cleanup. It does
not infer tool completion from server death. A restart without unfinished tool
execution resumes automatically.

Root's read-only policy and Worker's Git command guard are native tool policies,
not an operating-system sandbox. Inherited MCP servers remain available except
for the Worker's Suplex Root bridge. This installation is for owner-controlled
repositories, not hostile code or untrusted multi-tenant execution.

## Providers and defaults

A provider is one of the four agent tools Suplex runs: OpenCode, Claude Code,
Devin CLI, and Codex CLI. Each owns its own sign-in. Sign in as the OS user that
runs Suplex; a Codex login does not establish OpenCode access.

OpenCode reaches several model vendors, so its models carry the vendor in the
id, such as `openai/gpt-5.6-sol`. The other three name their models directly.

`/admin/providers` shows all four rows without making a paid model request.
**Configured** means the executable is present, not that inference was tested.
Agent dialogs and project defaults use that same catalog. New installations seed
Codex CLI GPT-5.6 Sol with medium reasoning for Root and GPT-5.6 Luna with max
reasoning and priority service for Worker. An installation with task history
keeps its OpenCode profiles, converted to the vendor-qualified model id.

Suplex discovers OpenCode on its process PATH or at `~/.opencode/bin/opencode`.
`SUPLEX_OPENCODE_COMMAND`, `SUPLEX_CLAUDE_COMMAND`, `SUPLEX_DEVIN_COMMAND`, and
`SUPLEX_CODEX_COMMAND` can each specify an absolute executable path. GitHub
delivery uses the host's existing `gh` login. Suplex does not copy any provider's
credentials into task records.

## Develop locally

```sh
mise run worktree
mise run dev:status
mise run dev
```

Reuse an existing stack when `dev:status` reports one. Frontend changes use Vite
HMR. Native host changes require a restart under `mise run dev`; `mise run dev:watch`
rebuilds and restarts the native host on changes. `mise run down` stops this
checkout's owned development processes. The default development port is 4111.

Loopback and tailnet requests receive the Operator administrator session.
An empty development database receives a company, native profiles, and a project
for this checkout.

## Set up an installation

The simplest install is the desktop app: open `Suplex-<version>-arm64.dmg`
(Apple silicon) or `Suplex-<version>-x64.dmg` (Intel),
drag Suplex to Applications, and choose **Run locally**. The app
ships the native server and web assets inside the bundle. It
checks the Mac, installs Apple's developer tools if Git is missing, installs
Herdr if it is missing, prepares a database under `~/Library/Application Support/Suplex`,
and starts Suplex on `127.0.0.1`. You do not need to install Git before setup.
Homebrew, a GitHub account, and Tailscale are optional. See the [Desktop app](#desktop-app)
section below.

To run Suplex on a host from a checkout instead:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run suplex setup          # Tailscale access; add --local for a 127.0.0.1-only host
pnpm run suplex start
```

Setup writes protected local configuration. In Tailscale mode it prints a
one-time passkey enrollment URL; the service supports Tailscale Serve HTTPS or
a direct Tailscale HTTP bind and rejects public and LAN bindings. In local mode
(`SUPLEX_ACCESS_MODE=local`) the service binds only `127.0.0.1` and every
request from the loopback host is the built-in Operator administrator. Local
administration and passkey recovery use `pnpm run suplex recover --confirm-recovery`.

When switching from the retired TypeScript server, register passkeys again and
sign in to GitHub again. Existing task data and the SQL migration history are
preserved; credential formats are not shared between the two implementations.

`pnpm run suplex install --manifest` lists the install stages the desktop app
runs, and `pnpm run suplex install --stage <name> --json` runs one of them. Each
stage is idempotent and prints one JSON result on stdout.

Configure companies, projects, and native profiles in the web application.
Project creation copies a GitHub repository into the configured repository root.
`SUPLEX_REPOSITORY_ROOT` and `SUPLEX_WORKTREE_ROOT` override the default paths.
Task Details shows an **Open in** menu when the task has a worktree; it can copy
the worktree path. Suplex
lists local launchers only for a direct loopback request with the configured Host.
Forwarding does not automatically make Suplex copy-only: it is an unsupported
locality assumption because the browser and Suplex can have different filesystems.
Suplex uses no desktop bridge for these actions. On macOS, Suplex discovers Finder,
Terminal, and editor app bundles in system, standard, and user application directories.
Xcode, iTerm, Devin, and Antigravity have no verified local directory-opening mechanism,
so Suplex does not list them. On Linux, Suplex lists executable PATH entries only; Terminal
uses `x-terminal-emulator`.
Set `SUPLEX_EDITOR_COMMAND` to an executable editor command when the default
`code` command is not suitable. Suplex passes the worktree path as its argument.

The tailnet is the login boundary. A request from the loopback host, a request
that Tailscale Serve stamped with a `Tailscale-User-Login` identity, or, in
direct Tailscale mode, a request addressed to the Tailscale hostname receives
the built-in Operator administrator session. Funnel traffic and tagged devices
carry no identity header and see the passkey sign-in instead.

### Desktop app

`desktop/` is a sandboxed Electron window that either runs Suplex on this Mac
or connects to a Suplex host elsewhere. On first launch it offers those two
choices. **Run locally** runs the install stages from the bundled
runtime under `Contents/Resources/runtime`, shows each stage's progress and
log, and then starts the bundled server on `127.0.0.1` every time the app
opens; quitting the app stops that server. Data, the env file, logs, and the
install record live under `~/Library/Application Support/Suplex`; delete that
directory to start over. If a Suplex from a checkout is already answering on
the chosen port, the app uses it instead of starting its own and leaves it
running on quit. **Remote access** takes a URL, tests it, and
installs nothing.

`mise run desktop:dev` opens the app from source, `mise run desktop:dist`
bundles the runtime and packages `desktop/release/<arch>/Suplex-<version>-<arch>.dmg`
(`SUPLEX_DESKTOP_ARCH=arm64`, the default, or `x64` for Intel),
`mise run desktop:dist:signed` builds both architectures and signs, notarizes, and staples them with the
credentials in 1Password, and `mise run desktop:open` or `suplex desktop` opens
the installed app at this host's `http://localhost:<port>`. The Navigate menu
lists every Suplex the app has opened: pick one to switch, use "Add a Suplex
URL" for a new one, and "Forget this Suplex" to drop the current one. `--url`
and `SUPLEX_DESKTOP_URL` override the remembered choice. The sidebar shows the
host the window is on.

A bundled server updates only with a new Suplex.app; its self-update is
disabled. The Check for Desktop Update menu item runs only in the Electron
main process. Local builds have no update feed. See
[docs/updates.md](docs/updates.md) for feed and signing requirements.

Create a task with **Start immediately** selected to start Root without another
click. Clear the option to keep the task in Backlog. Backlog tasks support title
and description edits. Active tasks accept notes and question-specific answers.
Cancellation stops Suplex's work but preserves local and published work.

```sh
pnpm run suplex stop
pnpm run suplex restart
```

Lifecycle commands inspect recorded process identities before signaling them.
They do not kill processes by broad name or port. `/health` reports host checks.
Checkout installations use the native supervisor. Restart the development
stack after native host changes; the runtime recovers native session work from its
own evidence.

## Back up and restore

```sh
pnpm run suplex backup /path/to/suplex-backup.tar.gz
pnpm run suplex verify-backup /path/to/suplex-backup.tar.gz
pnpm run suplex restore /path/to/suplex-backup.tar.gz /path/to/empty-restore-directory
```

Backups contain Suplex's database, artifacts, and non-secret configuration.
They exclude provider credentials, generated environment files, and passkey
credentials. Restore requires an empty destination and fresh authentication.
OpenCode's native storage and Git repositories are separate host data. A Suplex
backup alone cannot restore missing native sessions or repository contents.

## Verify changes

Run the frontend, desktop and protocol tests, then the native engine tests:

```sh
pnpm test
pnpm run test:rust
```

Use the narrower projects when you need them:

```sh
pnpm test:real
pnpm desktop:dist
pnpm test:packaged
```

`test:real` runs tests that depend on installed services or credentials.
`test:packaged` requires the desktop package from `desktop:dist`.
`pnpm test:guarded` runs the default suite inside the production Worker Git
guard and confirms that the guard remains active after the suite exits.

```sh
pnpm verify
```

Verification runs typecheck, lint, TypeScript and native tests, a production frontend build, a native test build, and Playwright
browser smoke tests for session setup, project creation, and the task lifecycle.
Task creation and start run at desktop and narrow widths. Follow the
[browser test budget](AGENTS.md#browser-test-budget) when adding coverage or
choosing which browser tests to run during development.

The native tests and deterministic interop journeys exercise native session and
delivery behavior. Real provider sign-in, installed services, GitHub writes,
and packaged desktop behavior require separate verification.
Database migrations are append-only. Follow [the migration guide](docs/database-migrations.md).
