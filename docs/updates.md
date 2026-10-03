# Suplex updates

Suplex updates the host and desktop app independently. See
[instances, clients, and distribution](architecture/deployment.md) for where
each process runs.

## Host updates

The native host supervises checkout installations. An administrator can check for an update and select **Restart Suplex** when the checkout is supervised. The updater observes the pinned `meiji-industries/suplex` `main` branch, verifies a fast-forward, applies it, installs frozen dependencies, builds the native binary and web assets, then restarts the host. It does not own or signal native agent sessions.

Git protects local work. Suplex never resets, stashes, cleans, or rebases the checkout. A conflicting local edit or divergent branch stops the update. The runtime records status in its `runtime/update-status.json` and writes an update log there. Inspect Git and that status before retrying an interrupted update.

A host bundled in Suplex.app updates only when the desktop app is replaced. Its checkout update control is disabled.

## Desktop app updates

The Electron main process uses `electron-updater`. The remote Suplex page remains sandboxed and receives no updater IPC.

Desktop updates are disabled unless the package build receives an HTTPS generic feed:

```sh
SUPLEX_DESKTOP_UPDATE_URL=https://releases.example.com/suplex/ mise run desktop:dist
```

The configured feed must host the generated `latest-mac.yml`, macOS ZIP, and ZIP blockmap at the same base URL. The DMG is useful for manual installation but is not the updater payload. Keep the application version newer than every published version.

After `mise run desktop:dist:signed`, publish with `mise run desktop:publish`. Both tasks fetch their Apple signing and R2 values through the Suplex 1Password service account. The publisher verifies the signed app and stapled DMG, uploads immutable versioned artifacts to `stable/mac/arm64` (Apple silicon) and `stable/mac/x64` (Intel), checks their public URLs, then uploads each folder's `latest-mac.yml` last with `no-cache`. Each build updates only from its own folder.

`mise run release:major`, `release:minor`, and `release:patch` run the release pipeline: verify a clean checkout, fetch the service account, bump the frontend, desktop, and native versions, sign and notarize the Mac builds, build Linux archives for both architectures,
commit, tag, push, then publish. The bump starts from the highest stable version
in the checkout, local tags, and live `origin` tags. Remote lookup failures stop
the release before version files change or builds start. The pipeline rechecks
that the tag is unused before committing, then pushes the branch and tag
atomically. A concurrent tag collision stops the push and publication; it never
replaces an existing tag. The manifest is published last.

Run `node scripts/test-release-version.mjs` to check version selection and tag
collisions with temporary Git repositories.

A distributable macOS update requires a consistent Developer ID signature on the existing application and downloaded ZIP, plus notarization and stapling. Production distribution requires the external signing and feed inputs.

### In-app updater

`DesktopUpdater` in `desktop/src/desktop-updater.ts` checks the feed at launch and every hour while the app is open. It downloads and installs only after a click: `autoDownload` and `autoInstallOnAppQuit` are off.

| Event | What the viewer sees |
| --- | --- |
| An automatic check finds a newer version | A notification, once for each version in an app run. A click opens the download dialog. |
| **Check for updates** finds a newer version | The download dialog. |
| **Check for updates** finds no newer version | A dialog that says the app is current. |
| The download finishes | A notification. A click opens the restart dialog. **Check for updates** opens the restart dialog again. |
| The download or the installation fails | A notification. A click opens the error. |
| A check fails | An error dialog for a manual check. Nothing for an automatic check. |

Automatic checks stay silent when no feed is configured. A manual check explains that desktop app updates are not configured. **Restart Suplex** in the restart dialog replaces the app. A bundled host started by Suplex.app restarts with it; an independent host remains untouched.

If macOS notifications are off for Suplex, automatic checks show nothing. **Check for updates** still works.

### Dialog rules

Two rules keep the app replaceable. Both come from an incident: versions 1.2.0 and earlier opened the download dialog from the hourly check, and an app left open at release time could not be quit by `install.sh` or `suplex update`.

1. **Attach every message box to the window.** Use `ask` in `desktop/src/suplex-desktop.ts`, not `dialog.showMessageBox` directly. Electron shows a message box that has no visible parent window as an app-modal alert.
2. **Open a dialog only as the direct answer to a click.** An event that arrives later posts a notification, and a click on it opens the dialog. macOS refuses a quit request while any dialog is open, and `ask` takes the window to the front.

Measured with Electron 44.2.0 on Darwin 25.5, with the app in the background:

| Message box | Visible | Main process | Quit event | SIGTERM |
| --- | --- | --- | --- | --- |
| No parent window | No, opacity 0 | Stopped until answered | Refused, error -128 | Ignored |
| Attached to the window | Yes | Runs | Refused, error -128 | Quits normally |

A stopped main process does not reap its children, does not drain the host's log pipe, and does not answer a second launch. In the test, the second launch killed the stopped app after about 20 seconds and left its host running.

To put a 1.2.0 or earlier app in the stopped state for a test, run `open -n -a /Applications/Suplex.app --args --url=bogus`, then kill the second `Suplex` process.

### Replacing a running Suplex.app

Three paths replace the app:

| Path | Source | Starts from |
| --- | --- | --- |
| In-app updater | `desktop/src/desktop-updater.ts` | **Restart Suplex** in the app |
| `suplex update` | `rust/src/platform/app_update.rs`, see [the CLI](architecture/cli.md#updates) | A terminal |
| `install.sh` | `src/web/public/install.sh`, compiled into `suplex hosted serve` and served at `https://suplex.sh/install.sh` | `curl -fsSL https://suplex.sh/install.sh \| sh` |

`suplex update` and `install.sh` stop the app with the same sequence:

1. Send the quit event. Wait 10 seconds only if macOS accepts it.
2. Send SIGTERM and wait 10 seconds. The app quits normally and stops the host it started.
3. Send SIGKILL and wait 10 seconds. Only an app stopped by an app-modal alert needs this.

A killed app leaves its host running. `suplex update` stops that host and does not start it from the CLI, so the reopened app starts and owns it. `install.sh` runs `suplex down` before each replacement, from a directory that has no `.suplex`, so it stops the desktop installation's host and not a checkout's. It does not start a stopped host again; the app or `suplex up` does.

## Linux binary distribution

`mise run linux:dist` builds arm64 and x64 native binaries with embedded web
assets and migrations. Each architecture produces a versioned tarball, SHA-256
checksum file, and `latest-linux.yml` under `dist/linux/<arch>`.
`mise run linux:publish` publishes them to `stable/linux/<arch>` using the
configured release credentials. These are host binaries, not Linux Electron
packages.

The combined release publisher uploads immutable Mac and Linux artifacts before
updating their download manifests. Linux's manifest describes the available
archive; it does not implement automatic replacement of a running binary.
The host's Git-based checkout updater is a separate mechanism and must not be
presented as an archive updater. Preserve installation data when replacing a
binary, and verify the destination host separately from artifact publication.
