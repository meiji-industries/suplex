# Suplex

[![CI](https://github.com/meiji-industries/suplex/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/meiji-industries/suplex/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-26.7.0-brightgreen)](package.json)
[![pnpm](https://img.shields.io/badge/pnpm-11.22.0-orange)](package.json)

Suplex coordinates software-development tasks through existing coding agents,
Git, and repository services. A Coordinator plans and reviews; a Worker implements
in a task worktree. Suplex is a copilot: you can intervene directly, and it
adapts to the work you change or merge.

Start with the [product guide](docs/product.md) for current capabilities,
integration limits, and positioning. [CONTEXT.md](CONTEXT.md) defines the terms.
[Current architecture](docs/architecture/README.md) records how the system works.
[Architecture decisions](docs/adr/) explain why.
See [billing setup and recovery](docs/billing.md) for Suplex Free and Pro operations.

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
| Native agent provider | Sessions, admitted messages, tool execution, and turn results |
| Git | Worktrees, branches, commits, and uncommitted changes |
| GitHub | Remote branches, pull requests, checks, reviews, and merges |
| Herdr | The visible attachment to a native session |

Suplex runs a native API and task host beside a SQLite database. Database records
preserve Suplex-owned intent and correlate native observations. Delivery decisions read
current Git and repository-provider state.

Coordinator delegates work and ends its turn. Results wake the same session;
Combined planning runs two independent Advisors before combining their results. Coordinator can request a normal push,
pull request creation,
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

Coordinator's read-only policy and Worker's Git command guard are native tool
policies, not an operating-system sandbox. MCP access depends on the provider
and project configuration; see [project execution](docs/project-execution.md).
This installation is for owner-controlled repositories and trusted local tools.

## Providers and defaults

A provider is one of the four agent tools Suplex runs: OpenCode, Claude Code,
Devin CLI, and Codex CLI. Each owns its own sign-in. Sign in as the OS user that
runs Suplex; a Codex login does not establish OpenCode access.

OpenCode reaches several model vendors, so its models carry the vendor in the
id, such as `openai/gpt-5.6-sol`. The other three name their models directly.

`/admin/providers` shows all four rows without making a paid model request.
**Configured** means the executable is present, not that inference was tested.
Agent dialogs and project defaults use that same catalog. New installations seed
Codex CLI GPT-5.6 Sol with medium reasoning for Coordinator and GPT-5.6 Luna with max
reasoning and priority service for Worker. An installation with task history
keeps its OpenCode profiles, converted to the vendor-qualified model id.

Suplex discovers OpenCode on its process PATH or at `~/.opencode/bin/opencode`.
`SUPLEX_OPENCODE_COMMAND`, `SUPLEX_CLAUDE_COMMAND`, `SUPLEX_DEVIN_COMMAND`, and
`SUPLEX_CODEX_COMMAND` can each specify an absolute executable path. GitHub
delivery uses Suplex's GitHub sign-in or the host's available GitHub credentials.
Suplex does not copy provider credentials into task records.

## Develop locally

```sh
mise run worktree
mise run dev:status
mise run dev
```

Reuse an existing stack when `dev:status` reports one. Frontend changes use Vite
HMR. Native host changes require a restart under `mise run dev`; `mise run dev:watch`
rebuilds and restarts the native host on changes. `mise run down` stops this
checkout's owned development processes. The default development port is 14111; 4111 stays free for the desktop app and installed hosts.
Conductor's Run command uses `http://127.0.0.1:<port>` with its assigned port.
Other development launches keep the default Tailscale access mode.

Mise keeps Rust build artifacts in each checkout's `rust/target` and uses
`sccache` when it is on `PATH` to reuse compiled dependencies across worktrees.
Install it with `cargo install sccache --locked`; without it, builds use rustc
directly. Cargo downloads remain in the normal shared `CARGO_HOME` cache.
Leave `CARGO_TARGET_DIR` unset for cross-worktree cache hits: sccache hashes
that variable, so a different absolute path in every checkout causes misses.
The compiler cache uses sccache's machine-wide configuration and defaults to
a 10 GiB limit. Run `sccache --show-stats` to inspect hits and storage.
Development and test builds keep backtrace line numbers but omit full debugger
data and incremental artifacts to reduce disk use. The first build with these
settings warms the cache; new worktrees still link their own binaries.
Check the wrapper with `mise run test:sccache-wrapper`.

Loopback and tailnet requests receive the Operator administrator session.
An empty development database receives a company, native profiles, and a project
for this checkout.

## Set up an installation

See [instances, clients, and distribution](docs/architecture/deployment.md) for
the host model, development-server access, and desktop/Linux binary options.

The simplest install is the desktop app: open `Suplex-<version>-arm64.dmg`
(Apple silicon) or `Suplex-<version>-x64.dmg` (Intel),
drag Suplex to Applications, and choose **Run locally**. The app
ships the native server and web assets inside the bundle. It
checks the Mac, installs Apple's developer tools if Git is missing, installs
Herdr if it is missing, prepares a database under `~/Library/Application Support/Suplex`,
and starts Suplex on `127.0.0.1`. You do not need to install Git before setup.
Homebrew, a GitHub account, and Tailscale are optional. Install and connect
Tailscale only if you select **Tailscale** under **Network access**. See the
[Desktop app](#desktop-app) section below.

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

On first open, Suplex asks an administrator to log in to a Suplex account with
Google, GitHub, or email. The login runs in the system browser against
`suplex.sh`. One account covers the host and everyone on it. **Profile → Log out**
unlinks it. Set `SUPLEX_ACCOUNT_SERVICE_URL=` (empty) to turn the requirement off
for a self-hosted checkout; development roots never ask. See
[Suplex accounts](docs/accounts.md).

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

Suplex.app is a Tauri 2 shell written in Rust (`desktop/src-tauri`, crate
`suplex-desktop`) around the bundled `suplex` host. Its window is the system
WKWebView, so the app needs macOS 14 or later. The window shows either the
bundled setup pages or the web app served by the selected host; the host keeps
serving all data, sessions, and terminals over HTTP and WebSockets. A browser
needs no desktop app and works as before.

On first launch the app offers two choices. **Run locally** runs the install
stages of the bundled host under `Contents/Resources/runtime`, shows each
stage's progress and log, and then starts that host on `127.0.0.1` each time
the app opens. Closing the window keeps the app, its menu-bar item, and the host
running; **Quit Suplex** stops the host that the app started. Use **Suplex >
Settings > Network access** or the menu-bar item to select **This Mac only**,
**Tailscale**, or **All networks**, then select **Restart** to apply it. The
Tailscale option keeps the host on loopback and creates an HTTPS Serve route;
the menu can copy the active Tailscale URL. **Remote access** takes the URL of a
Suplex host elsewhere, tests it, and installs nothing.

Data, the env file, logs, the install record, saved hosts, window size, and
network access files live under `~/Library/Application Support/Suplex`, the same
directory the earlier Electron app used; delete it to start over. Web sign-ins
are not carried over from the Electron app, so sign in again once. If a running
host reports this installation's identity, the app adopts it and leaves it
running on quit. A host of another installation, or another program, on the
preferred port is left alone, and the app starts its own host on a free port.

The host bar at the bottom of the window and **Suplex > Settings** list the
remembered hosts (at most eight origins); select one to switch, or select
**Manage Suplex hosts…** to add or remove one. `--url` and `SUPLEX_DESKTOP_URL`
override the remembered choice for a launch, and a second launch with `--url`
switches the open window. A company invitation link, `suplex://join?url=<https URL>`,
opens that host. Other `suplex://` links only bring the app to the front.

| Command | Result |
| --- | --- |
| `mise run desktop:dev` | Runs the shell against this checkout's dev stack. Reuses the stack when it is running, or starts `pnpm dev:watch` and stops it on exit. React edits use Vite HMR; edits under `desktop/src-tauri` or the setup pages rebuild and restart only the shell. Uses the bundle ID `dev.suplex.desktop.dev` and data under `.context/tauri-migration/desktop-dev-data`. |
| `pnpm desktop:typecheck`, `pnpm desktop:test` | `cargo check` and the Rust behavior and IPC authorization tests of the shell. |
| `pnpm desktop:test:native` | The macOS WKWebView smoke tests, against an app built with a test-only driver and isolated data. |
| `mise run desktop:dist` | Builds `desktop/release/<arch>/Suplex.app`, the DMG, and the ZIP (`SUPLEX_DESKTOP_ARCH=arm64`, the default, or `x64`). Never publishes. |
| `pnpm test:packaged` | Checks the built app, its bundled host, and its archives. |
| `mise run desktop:install` | Builds this checkout and replaces `/Applications/Suplex.app` without a release. It quits, swaps, and relaunches the app, keeps its data, and refuses uncommitted changes unless `SUPLEX_INSTALL_DIRTY=1`. |
| `mise run desktop:dist:signed` | Builds both architectures signed, notarized, and stapled, with both update feeds, from the credentials in 1Password. |
| `pnpm desktop:verify:release` | Checks the built release files and runs the publisher without uploads. |
| `mise run desktop:open`, `suplex desktop` | Opens the installed app at this host's `http://localhost:<port>`. |

A bundled host updates only with a new Suplex.app; its self-update is disabled.
**Check for updates** in the app menu and the menu-bar item uses the app's own
update feed. Local builds have no feed. See [docs/updates.md](docs/updates.md)
for the feeds and the signing requirements.

Create a task with **Start immediately** selected to queue it. Suplex starts
it when its prerequisites are complete. Clear the option to keep it in Backlog. Backlog tasks support title
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

## Telemetry

Release builds send event names and counts to PostHog after an administrator
answers the first-use notice. Suplex never sends code, prompts, names,
repository names, or file paths. Turn it off in **Settings → Environment**, or
set `DO_NOT_TRACK=1`. [docs/telemetry.md](docs/telemetry.md) lists every event
and property.

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
