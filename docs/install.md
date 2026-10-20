# Install and operate Suplex

This guide covers installation, providers, the Linux host, the desktop app,
day-to-day lifecycle commands, backup and restore, and telemetry. For local
development of Suplex itself, see [development](development.md).

See [instances, clients, and distribution](architecture/deployment.md) for
the host model, development-server access, and desktop and Linux binary options.

## Set up an installation

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

On Linux, install the deb or rpm from
`https://suplex.sh/download?platform=linux-desktop-x64&format=deb` (or `rpm`, or
`linux-desktop-arm64`), for example `sudo apt install ./Suplex-<version>-linux-x64.deb`.
It works like the Mac app, keeps its data in `~/.local/share/Suplex`, and needs
Git installed first. On Windows, run this in PowerShell, or download the installer from
`https://suplex.sh/download?platform=windows-x64` (or `windows-arm64`):

```powershell
irm https://suplex.sh/install.ps1 | iex
```

The Windows app connects to a Suplex host on another computer; it cannot run
one itself.

### Linux host

To run Suplex on a new cloud server, run this on your own computer (macOS or Linux):

```sh
curl -fsSL https://suplex.sh/bootstrap.sh | sh
```

It installs `suplex-bootstrap` and starts its wizard, which creates or connects to the server, sets up
everything below, and prints a login link. See [apps/bootstrap](../apps/bootstrap/README.md).

To set up a host by hand, start Suplex as a dedicated non-root user.
Keep its data directory, repository roots, worktree roots, Herdr, and agent tool installs under this user's ownership.
Provision privileged steps once, without blanket sudo access for this user.
For a systemd service, set `User=suplex`, `HOME=/home/suplex`, and a `PATH` that includes the user's tool manager shims.
For example, include `/home/suplex/.local/share/mise/shims` and `/home/suplex/.local/bin` before `/usr/local/bin:/usr/bin:/bin`.
Check `pnpm --version` with that service user's environment before task setup.
The Linux installer and the `suplex up`, `restart`, `down`, and `serve` commands refuse to run as root.

To run Suplex on a host from a checkout instead:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run suplex setup          # Tailscale access; add --local for a 127.0.0.1-only host
pnpm run suplex start
```

Setup writes protected local configuration. In Tailscale mode the service supports Tailscale Serve HTTPS or
a direct Tailscale HTTP bind and rejects public and LAN bindings. In local mode
(`SUPLEX_ACCESS_MODE=local`) the service binds only `127.0.0.1` and every
request from the loopback host is the built-in Operator administrator. Local
administration and recovery use `pnpm run suplex recover --confirm-recovery`.

When switching from the retired TypeScript server, sign in to GitHub again. Existing task data and the SQL migration history are
preserved; credential formats are not shared between the two implementations.

`pnpm run suplex install --manifest` lists the install stages the desktop app
runs, and `pnpm run suplex install --stage <name> --json` runs one of them. Each
stage is idempotent and prints one JSON result on stdout.

### Accounts, projects, and access

On first open, Suplex asks an administrator to log in to a Suplex account with
Google, GitHub, or email. The login runs in the system browser against
`suplex.sh`. One account covers the host and everyone on it. **Profile → Log out**
unlinks it. Set `SUPLEX_ACCOUNT_SERVICE_URL=` (empty) to turn the requirement off
for a self-hosted checkout; development roots never ask. See
[Suplex accounts](accounts.md).

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
carry no identity header and see the account login instead.

See [billing setup and recovery](billing.md) for Suplex Free and Pro operations.

## Providers and defaults

A provider is one of the six agent tools Suplex runs: OpenCode, Claude Code,
Devin CLI, Codex CLI, Pi, and OMP. Each owns its own sign-in. Sign in as the OS user that
runs Suplex; a Codex login does not establish OpenCode access.

OpenCode, Pi, and OMP reach several model vendors, so their models carry the
vendor in the id, such as `openai/gpt-5.6-sol`. The other three name their
models directly. Pi lists the models its credentials and `~/.pi/agent/models.json`
make available, so a local OpenAI-compatible server configured there appears as
`<provider>/<id>`. Sign in to Pi by running `pi` and typing `/login`, or by
setting a provider API key in the environment.

Install OMP with `curl -fsSL https://omp.sh/install | sh`. OMP lists the models
that its credentials and `~/.omp/agent/models.yml` make available, and Suplex
reads that list with `omp models --json`. Sign in to OMP with `omp login`, or set
a provider API key in the environment.

`/admin/providers` shows all six rows without making a paid model request.
**Configured** means the executable is present, not that inference was tested.

### Local or custom endpoints

A local or custom endpoint is an OpenAI-compatible server, such as
llama-server, MLX, oMLX, Ollama, LM Studio, or vLLM. Add one in the **Your
stack** step of onboarding (**Local or custom endpoint**, then **Add**) or in
**Settings > Providers** (**Add Provider**, then **Local or custom endpoint**).
Suplex asks for three values:

- **Base URL**: the OpenAI-compatible root, usually ending in `/v1`, such as
  `http://127.0.0.1:8080/v1`.
- **API key (optional)**: sent as `Authorization: Bearer <key>`. Leave it empty
  for a server without authentication.
- **Model id**: the id the server lists at `GET <base URL>/models`, such as
  `qwen3-coder`.

**Check** calls `GET <base URL>/models` with a 5 second timeout and saves
nothing. It reports **Model listed** when the server answers and lists the
model, **Reachable** when it answers without listing the model, or **Error**
with the reason, such as a refused connection, HTTP 401, or HTTP 404 for a base
URL without `/v1`. **Add** saves the endpoint in the Suplex database. The
label is "Local endpoint" and the host and port.

Each endpoint is its own row in `/admin/providers`, below the six tools, and in
the **Endpoints** group of **Settings > Providers**. Its status is
**Connected** when the same models check lists the model, so it counts toward
**Continue** in onboarding. Its model id is `<endpoint id>/<model id>`, such
as `local-1a2b3c4d5e6f/qwen3-coder`, and the Team step and agent dialogs list
it. The row runs the model with OpenCode when OpenCode is installed, else with
Pi or OMP; the Pi and OMP rows also list it. **Delete** removes the endpoint
and its key after a confirmation, unless an agent still selects its model.

When a task starts an agent with an endpoint model, Suplex writes the provider
configuration for that process only and does not change the user's own
configuration files:

- OpenCode receives, in `OPENCODE_CONFIG_CONTENT`, a `provider.<endpoint id>`
  entry with `npm` `@ai-sdk/openai-compatible`, the endpoint label as `name`,
  `options.baseURL`, `options.apiKey` when a key is set, and
  `models.<model id>`. Suplex leaves the reasoning and service tier options out
  for these models.
- Pi and OMP load `<session runtime>/suplex-endpoint.ts` with `-e`. The
  extension calls `pi.registerProvider("<endpoint id>", …)` with the base URL,
  the `openai-completions` API, and the model. The file holds no key: Pi reads
  `$SUPLEX_ENDPOINT_API_KEY` and OMP reads `process.env.SUPLEX_ENDPOINT_API_KEY`
  from the process environment.

No response, log line, task record, or sync frame holds the API key.
Agent dialogs and project defaults use that same catalog. New installations seed
Codex CLI GPT-5.6 Sol with medium reasoning for Coordinator and GPT-5.6 Luna with max
reasoning and priority service for Worker. An installation with task history
keeps its OpenCode profiles, converted to the vendor-qualified model id.

Suplex discovers OpenCode on its process PATH or at `~/.opencode/bin/opencode`.
`SUPLEX_OPENCODE_COMMAND`, `SUPLEX_CLAUDE_COMMAND`, `SUPLEX_DEVIN_COMMAND`,
`SUPLEX_CODEX_COMMAND`, `SUPLEX_PI_COMMAND`, and `SUPLEX_OMP_COMMAND` can each
specify an absolute executable path. GitHub
delivery uses Suplex's GitHub sign-in or the host's available GitHub credentials.
Suplex does not copy provider credentials into task records.

## Desktop app

Suplex.app is a Tauri 2 shell written in Rust (`apps/desktop/src-tauri`, crate
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

A bundled host updates only with a new Suplex.app; its self-update is disabled.
**Check for updates** in the app menu and the menu-bar item uses the app's own
update feed. Local builds have no feed. See [updates](updates.md)
for the feeds and the signing requirements.

To build, test, or install the desktop app from a checkout, see the
[desktop app commands](development.md#desktop-app-commands).

## Run tasks and the host

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

## Recovery limits

An out-of-band edit, commit, push, or matching pull request is observed and
retained. Restart does not discard the worktree or replay an admitted prompt.
A lost prompt acknowledgment is retried only after the old dispatch process
is stopped and native history proves that the message was not admitted.

Herdr display failures do not stop native work. Suplex retries the attachment.
Provider observation failures do not turn into failed CI checks.

OpenCode can launch shell commands in separate process groups. A hard server
crash during a tool call can leave a command alive. Suplex retains that turn and
asks you to stop the old commands before explicitly confirming cleanup. It does
not infer tool completion from server death. A restart without unfinished tool
execution resumes automatically.

Coordinator's read-only policy and Worker's Git command guard are native tool
policies, not an operating-system sandbox. MCP access depends on the provider
and project configuration; see [project execution](project-execution.md).
This installation is for owner-controlled repositories and trusted local tools.

## Back up and restore

```sh
pnpm run suplex backup /path/to/suplex-backup.tar.gz
pnpm run suplex verify-backup /path/to/suplex-backup.tar.gz
pnpm run suplex restore /path/to/suplex-backup.tar.gz /path/to/empty-restore-directory
```

Backups contain Suplex's database, artifacts, and non-secret configuration.
They exclude provider credentials, and generated environment files. Restore requires an empty destination and fresh authentication.
OpenCode's native storage and Git repositories are separate host data. A Suplex
backup alone cannot restore missing native sessions or repository contents.
See [backup and restore](architecture/backup-and-restore.md) for the design.

## Telemetry

Release builds send event names and counts to PostHog after an administrator
answers the first-use notice. Suplex never sends code, prompts, names,
repository names, or file paths. Turn it off in **Settings → Environment**, or
set `DO_NOT_TRACK=1`. [Telemetry](telemetry.md) lists every event
and property.
