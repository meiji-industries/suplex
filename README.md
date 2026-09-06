# Forge

Forge runs repository tasks through OpenCode, Git, and GitHub. One continuing
Root session plans and reviews the work. A scoped Worker edits, verifies, and
commits in the task worktree. Herdr displays those native sessions.

The [product guide](docs/product.md) describes the workflow. [CONTEXT.md](CONTEXT.md)
defines its terms. The [cutover plan](docs/plans/2026-09-04-resumable-delivery.md)
records the architecture decisions and verification.

## State ownership

| Owner | Authoritative state |
| --- | --- |
| Forge | Task objective, configuration, start and cancel intent, questions, session assignment, prompt dispatch ownership |
| OpenCode | Native sessions, admitted messages, tool execution, and turn results |
| Git | Worktrees, branches, commits, and uncommitted changes |
| GitHub | Remote branches, pull requests, checks, reviews, and merges |
| Herdr | The visible attachment to a native session |

Forge runs a Fastify API and a task host beside a SQLite database. There is no
phase engine, Temporal history, separate integrator agent, or completion-file
protocol. Database records preserve Forge-owned intent and correlate native
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

Herdr display failures do not stop native work. Forge retries the attachment.
Provider observation failures do not turn into failed CI checks.

OpenCode can launch shell commands in separate process groups. A hard server
crash during a tool call can leave a command alive. Forge retains that turn and
asks you to stop the old commands before explicitly confirming cleanup. It does
not infer tool completion from server death. A restart without unfinished tool
execution resumes automatically.

Root's read-only policy and Worker's Git command guard are native tool policies,
not an operating-system sandbox. Inherited MCP servers remain available except
for the Worker's Forge Root bridge. This installation is for owner-controlled
repositories, not hostile code or untrusted multi-tenant execution.

## Providers and defaults

OpenCode owns provider credentials and its model catalog. Sign in with
`opencode auth login` as the OS user that runs Forge. A Codex or Claude Code
login does not establish OpenCode access.

`/admin/providers` shows configured OpenCode providers without making a paid
model request. **Configured** does not mean that inference was tested.
Agent dialogs and project defaults use that same provider-qualified catalog.
New installations seed OpenAI GPT-5.6 Sol with medium reasoning for Root and
GPT-5.6 Luna with max reasoning and priority service for Worker.

Forge discovers OpenCode on its process PATH or at `~/.opencode/bin/opencode`.
`FORGE_OPENCODE_COMMAND` can specify an absolute executable path. GitHub delivery
uses the host's existing `gh` login. Forge does not copy either provider's
credentials into task records.

## Develop locally

```sh
mise run worktree
mise run dev:status
mise run dev
```

Reuse an existing stack when `dev:status` reports one. Frontend changes use Vite
HMR. Backend changes require a restart under `mise run dev`. `mise run dev:watch`
restarts the backend on changes. `mise run down` stops this checkout's stack.

Loopback and tailnet requests receive the Operator administrator session.
An empty development database receives a company, native profiles, and a project
for this checkout.

## Set up an installation

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run forge setup
pnpm run forge start
```

Setup writes protected local configuration and prints a one-time passkey
enrollment URL. The service supports Tailscale Serve HTTPS or a direct Tailscale
HTTP bind. It rejects public and LAN bindings. Local administration and passkey
recovery use `pnpm run forge recover`.

Configure companies, projects, and native profiles in the web application.
Project creation copies a GitHub repository into the configured repository root.
`FORGE_REPOSITORY_ROOT` and `FORGE_WORKTREE_ROOT` override the default paths.
`FORGE_EDITOR_COMMAND` selects the editor opened from a task.

The tailnet is the login boundary. A request from the loopback host, a request
that Tailscale Serve stamped with a `Tailscale-User-Login` identity, or, in
direct Tailscale mode, a request addressed to the Tailscale hostname receives
the built-in Operator administrator session. Funnel traffic and tagged devices
carry no identity header and see the passkey sign-in instead.

### Desktop app

`desktop/` is a sandboxed Electron window that loads an existing Forge server.
It owns no server, database, or agent process; quitting it changes nothing on
the host. `mise run desktop:dev` opens it from source, `mise run desktop:dist`
packages `desktop/release/Forge-<version>-arm64.dmg`, and `mise run desktop:open`
or `forge desktop` opens the installed app at this host's `http://localhost:<port>`.
The Navigate menu lists every Forge the app has opened: pick one to switch, use
"Add a Forge URL" for a new one, and "Forget this Forge" to drop the current one.
`--url` and `FORGE_DESKTOP_URL` override the remembered choice. The sidebar shows
the host the window is on.

Create a task with **Start immediately** selected to start Root without another
click. Clear the option to keep the task in Backlog. Backlog tasks support title
and description edits. Active tasks accept notes and question-specific answers.
Cancellation stops Forge's work but preserves local and published work.

```sh
pnpm run forge stop
pnpm run forge restart
```

Lifecycle commands inspect recorded process identities before signaling them.
They do not kill processes by broad name or port. `/health` reports host checks.

## Back up and restore

```sh
pnpm run forge backup /path/to/forge-backup.tar.gz
pnpm run forge verify-backup /path/to/forge-backup.tar.gz
pnpm run forge restore /path/to/forge-backup.tar.gz /path/to/empty-restore-directory
```

Backups contain Forge's database, artifacts, and non-secret configuration.
They exclude provider credentials, generated environment files, and passkey
credentials. Restore requires an empty destination and fresh authentication.
OpenCode's native storage and Git repositories are separate host data. A Forge
backup alone cannot restore missing native sessions or repository contents.

## Verify changes

Run the unit-test project only with:

```sh
pnpm test
```

```sh
pnpm verify
```

Verification runs typecheck, lint, unit tests, a production build, and Playwright
browser tests at desktop and narrow widths. Installed-runtime probes live in
`scripts/probe-opencode-runtime.ts`, `scripts/probe-opencode-attachment.ts`, and
`scripts/probe-opencode-delivery.ts`. Read each script for its arguments.

The delivery probe consumes model capacity and creates visible Herdr panes.
It verifies a local commit and completion without writing to GitHub.
Database migrations are append-only. Follow [the migration guide](docs/database-migrations.md).
