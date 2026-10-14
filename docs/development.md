# Develop Suplex

This guide covers the local development stack, build caches, desktop app
commands, and verification. Read [AGENTS.md](../AGENTS.md) before you change
code. To install and operate Suplex, see [install](install.md).

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

The repository root is one Cargo workspace for the crates in `apps/`. Mise keeps Rust build artifacts
in each checkout's root `target/` and uses
`sccache` when it is on `PATH` to reuse compiled dependencies across worktrees.
Install it with `cargo install sccache --locked`; without it, builds use rustc
directly. Cargo downloads remain in the normal shared `CARGO_HOME` cache.
Leave `CARGO_TARGET_DIR` unset for cross-worktree cache hits: sccache hashes
that variable, so a different absolute path in every checkout causes misses.
The compiler cache uses sccache's machine-wide configuration and defaults to
a 10 GiB limit. Run `sccache --show-stats` to inspect hits and storage.
Development and test builds keep backtrace line numbers but omit full debugger
data. Rustc keeps incremental artifacts in each checkout for faster rebuilds
after edits. The wrapper sends incremental compilations directly to rustc and
uses sccache for eligible dependencies. The first build warms these caches;
new worktrees still link their own binaries.
Check the wrapper with `mise run test:sccache-wrapper`.

The Vite development stack sets `SUPLEX_DEV_EMBED_FRONTEND=0` so changes to
`apps/web/dist` do not trigger Rust rebuilds. Other builds embed the frontend by
default, and release builds always embed it. Migrations remain embedded in
every build.

Loopback and tailnet requests receive the Operator administrator session.
An empty development database receives a company, native profiles, and a project
for this checkout.

## Desktop app commands

The [desktop app](install.md#desktop-app) section describes what the app does.
These commands build and test it from a checkout.

| Command | Result |
| --- | --- |
| `mise run desktop:dev` | Runs the shell against this checkout's dev stack. Reuses the stack when it is running, or starts `pnpm dev:watch` and stops it on exit. React edits use Vite HMR; edits under `apps/desktop/src-tauri` or the setup pages rebuild and restart only the shell. Uses the bundle ID `dev.suplex.desktop.dev` and data under `.context/tauri-migration/desktop-dev-data`. |
| `pnpm desktop:typecheck`, `pnpm desktop:test` | `cargo check` and the Rust behavior and IPC authorization tests of the shell. |
| `pnpm desktop:test:native` | The macOS WKWebView smoke tests, against an app built with a test-only driver and isolated data. |
| `mise run desktop:dist` | Builds `apps/desktop/release/<arch>/Suplex.app`, the DMG, and the ZIP (`SUPLEX_DESKTOP_ARCH=arm64`, the default, or `x64`). Never publishes. |
| `pnpm test:packaged` | Checks the built app, its bundled host, and its archives. |
| `mise run desktop:install` | Builds this checkout and replaces `/Applications/Suplex.app` without a release. It quits, swaps, and relaunches the app, keeps its data, and refuses uncommitted changes unless `SUPLEX_INSTALL_DIRTY=1`. |
| `mise run desktop:dist:signed` | Builds both architectures signed, notarized, and stapled, with both update feeds, from the credentials in 1Password. |
| `pnpm desktop:verify:release` | Checks the built release files and runs the publisher without uploads. |
| `mise run desktop:open`, `suplex desktop` | Opens the installed app at this host's `http://localhost:<port>`. |

See [updates](updates.md) for the update feeds and the signing requirements.

## Verify changes

Run the frontend, desktop and protocol tests, then the native engine tests:

```sh
pnpm test
pnpm run test:rust
```

Use the narrower projects when you need them:

```sh
pnpm desktop:dist
pnpm test:packaged
```

`test:packaged` requires the desktop package from `desktop:dist`.
`pnpm test:guarded` runs the default suite inside the production Worker Git
guard and confirms that the guard remains active after the suite exits.

```sh
pnpm verify
```

Verification runs typecheck, lint, TypeScript and native tests, a production frontend build, a native test build, and Playwright
browser smoke tests for session setup, project creation, and the task lifecycle.
Task creation and start run at desktop and narrow widths. Follow the
[browser test budget](../AGENTS.md#browser-test-budget) when adding coverage or
choosing which browser tests to run during development.

The native tests and deterministic interop journeys exercise native session and
delivery behavior. Real provider sign-in, installed services, GitHub writes,
and packaged desktop behavior require separate verification.
Database migrations are append-only. Follow [the migration guide](database-migrations.md).
