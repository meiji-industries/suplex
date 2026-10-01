# Command-line interface

For contributors and operators, this page explains how the `suplex` command
finds an installation and what each command owns. Sources:
[entry point](../../rust/src/main.rs),
[commands](../../rust/src/cli.rs),
[installation configuration](../../rust/src/platform/config.rs),
[process supervisor](../../rust/src/platform/supervisor.rs), and
[desktop updater](../../desktop/src/desktop-updater.ts).

## One binary, many roles

The same `suplex` executable is the server, the operator CLI, the MCP bridges,
and the pane display processes. The desktop app bundles it at
`Suplex.app/Contents/Resources/runtime/bin/suplex`. The app does not put it on
`PATH`; an operator can link it, for example from `/usr/local/bin/suplex`. The
CLI version is then the bundled host version. From a checkout,
`pnpm suplex <command>` builds and runs the debug binary.

Running `suplex` with no command prints grouped help and exits. It does not
start a server. The server starts only through an explicit command:

| Command | Behavior |
| --- | --- |
| `up` (`start`) | Starts a supervised server in the background. `--foreground` runs the supervisor in the current process. |
| `down` (`stop`) | Stops the supervised server for this installation. |
| `restart` | Stops, then starts. |
| `serve` | Runs the server in the current process without a supervisor. |
| `update` (`upgrade`) | Installs the newest `Suplex.app` and restarts what was running. See [Updates](#updates). |
| `doctor` | Read-only installation report. See [Doctor](#doctor). |
| `version` (`--version`, `-V`) | Prints the version of this `suplex` binary. |
| `logs`, `task` | Read the log directory and one task's durable state. |
| `setup`, `install`, `migrate`, `recover` | Configure, install dependencies, migrate, and issue a recovery link. |
| `backup`, `verify-backup`, `restore` | See [Backup and restore](backup-and-restore.md). |

Help omits internal commands: `mcp`, `mcp root`, `mcp advisor`, `display …`,
`codex-display`, `update-apply`, and `github-store-credential`. Agent runtimes,
the supervisor, and the updater start them.

## Finding the installation

`Installation::load` resolves one configuration file, then reads each
setting from the environment first and the file second:

1. `SUPLEX_ENV_FILE`, when set. The desktop app, the development stack, and
   tests always set it.
2. `.suplex/suplex.env` in the current directory, when it exists. This is a
   checkout or a supervised source installation.
3. `~/Library/Application Support/Suplex/suplex.env`, when it exists. This is
   the desktop installation. Its root also supplies the default `data` and
   `logs` directories.

If none exists and no `SUPLEX_ROOT` or `SUPLEX_ACCESS_MODE` is set, the command
fails with the paths it checked. It does not fall back to Tailscale defaults
for a directory that has no installation.

A `.suplex` directory in the current directory takes precedence over the
desktop installation. Run desktop-installation commands from a directory
without one, or set `SUPLEX_ENV_FILE`.

## Doctor

`suplex doctor` opens the database read-only and never migrates it. `--fix` is
rejected; a restart applies pending migrations. The report groups checks into
Installation, Database, Storage, Integrations, Agents, and Tasks. Non-passing
checks also appear first under Notes. Each check shows its status, summary, the
detail fields from its health record, and a remedy when one exists. `--summary`
hides the detail fields. Color is used only when stdout is a terminal and
`NO_COLOR` is unset. The exit status is 1 when any check fails.

Database, storage, integration, and agent checks come from the same
[health snapshot](../../rust/src/platform/health.rs) as the web health page.
Of those, only the database, artifact root, Git, and Herdr checks can fail;
the others warn. The schema, reference, and task control checks can also fail. Read-only mode skips the database write probe and reports that writes are
not tested, so a healthy schema is not reported as a failure.

The server check observes processes, not a stored status. The server is running
when a supervised `serve` process has this installation's database open and
answers HTTP on the configured port. When it is not running and another process
listens on that port, doctor names that process. A server for another
installation on the same port is therefore reported as a port conflict, not as
this installation's server.

## Updates

`suplex update` resolves its own executable through symlinks. When the
executable is inside an `.app` bundle, the command reads the feed URL from the
bundle's `app-update.yml` and downloads `latest-mac.yml` from it. When the feed
has a newer version, it downloads the archive, checks its SHA-512 against the
feed, extracts it next to the installed bundle, and checks that the new bundle
passes `codesign` and Gatekeeper and has the same team identifier.

If `Suplex.app` or a host for the installation is running, the command asks
before it continues; `--yes` skips the question. It quits the app, stops a host
that is still running, swaps the bundle, then starts the host and reopens the
app. Every download and check completes before anything stops. The app's
**Check for updates** menu item still uses the in-app updater.

macOS refuses the quit event while the app shows a dialog. The command then
sends SIGTERM, and SIGKILL if the app still runs. A killed app leaves its host
running; the command stops that host and lets the reopened app start it. See
[replacing a running Suplex.app](../updates.md#replacing-a-running-suplexapp).

Outside an app bundle, the command exits with instructions to update the
checkout with Git and restart. The checkout's Git-based updater runs only
under the server's supervisor, through the web application. See
[updates and release publication](../updates.md).

## Limits

- The desktop app passes some settings to its host only through the
  environment. It does not write them to `suplex.env`. The Tailscale selection
  lives in `network-access.json`. The CLI therefore reads the desktop
  installation as local access. `suplex up` run while the app is closed starts
  a loopback-only server.
- When the preferred port is busy, the desktop app starts its host on another
  free port and does not record it in `suplex.env`. The CLI then checks the
  configured port, so doctor can report the server as not running while the
  app's host runs elsewhere.

[Architecture index](README.md)
