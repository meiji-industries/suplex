# Suplex updates

Suplex updates the host and desktop app independently. See
[instances, clients, and distribution](architecture/deployment.md) for where
each process runs.

## Host updates

The native host supervises checkout installations. An administrator can check for an update and select **Restart Suplex** when the checkout is supervised. The updater observes the pinned `meiji-industries/suplex` `main` branch, verifies a fast-forward, applies it, installs frozen dependencies, builds the native binary and web assets, then restarts the host. It does not own or signal native agent sessions.

Git protects local work. Suplex never resets, stashes, cleans, or rebases the checkout. A conflicting local edit or divergent branch stops the update. The runtime records status in its `runtime/update-status.json` and writes an update log there. Inspect Git and that status before retrying an interrupted update.

A host bundled in Suplex.app updates only when the desktop app is replaced. Its checkout update control is disabled.

## Desktop app updates

The Tauri shell (`apps/desktop/src-tauri/src/updater.rs`) checks for, downloads, and
installs desktop app updates in Rust with the official Tauri updater plugin. No
page, bundled or remote, receives an updater command.

### Feeds

Each architecture has one feed folder, `stable/mac/arm64/` (Apple silicon) and
`stable/mac/x64/` (Intel). Every release publishes two manifests there that
describe the same signed app:

| File | Readers | Contents |
| --- | --- | --- |
| `latest-tauri.json` | The app's updater | A Tauri static manifest: `version`, `notes`, `pub_date`, and one `platforms` entry (`darwin-aarch64` or `darwin-x86_64`) with the immutable HTTPS URL of `Suplex-<version>-<arch>.app.tar.gz` and its updater signature |
| `latest-mac.yml` | `suplex update` (`apps/server/src/platform/app_update.rs`) and the download handler in `apps/server/src/hosted/site.rs`; `install.sh` downloads through `/download` and does not read it | `version`, `path`, and `sha512` of the ZIP, and a `files` list with the ZIP and the DMG. The name and format are the ones the Electron app published; only the fields these readers use are written. |

The release files are `Suplex-<version>-<arch>-mac.zip`,
`Suplex-<version>-<arch>.dmg`, `Suplex-<version>-<arch>.app.tar.gz`, and its
`.sig`. There are no blockmaps. `pnpm desktop:dist` writes them, with both
manifests, to `apps/desktop/release/<arch>/`. Hashes come from the final ZIP, and the
updater archive and signature are copied from the Tauri bundler without change.

`SUPLEX_DESKTOP_UPDATE_URL` is the HTTPS feed base for Apple silicon
(`…/stable/mac/arm64/`); the Intel build uses the `x64` folder beside it. The
build writes it to `Contents/Resources/app-update.yml`, which the app and
`suplex update` read. The app checks `<feed>latest-tauri.json`.

The updater is enabled only when the build has both the feed and the Tauri
updater public key (`SUPLEX_DESKTOP_UPDATER_PUBKEY`, written to the Tauri
configuration at build time). Without them, automatic checks do nothing and
**Check for updates** explains that updates are not configured. A local
`pnpm desktop:dist` without these inputs builds no update files and says so.
The plugin rejects a download whose signature does not verify against the
public key, and `requireSignedVersion` rejects a signature made for another
version. A Developer ID signature or a checksum does not replace the updater
signature.

### Signing prerequisites

| Input | Used by | Source |
| --- | --- | --- |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Notarization | 1Password, `apps/desktop/signing.env` |
| Developer ID Application certificate | `codesign` (`APPLE_SIGNING_IDENTITY`, default `Developer ID Application`) | The login keychain |
| `SUPLEX_DESKTOP_UPDATE_URL` | Both feeds | 1Password, `apps/desktop/signing.env` |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `SUPLEX_DESKTOP_UPDATER_PUBKEY` | The updater archive signature and the app's public key | 1Password, `apps/desktop/signing.env`. The public key is also tracked in `apps/desktop/updater-production.pub`; a signed release stops when the two differ. Losing the private key strands every installed app on its version. |

`mise run desktop:dist:signed` runs `apps/desktop/scripts/dist-signed.sh` for each
architecture. It stops with the list of missing inputs when any of these is
absent. It signs the bundled host with the hardened runtime, builds and
notarizes the app with the Tauri bundler, notarizes and staples the DMG, and
then runs `pnpm desktop:verify:release`, which confirms that the ZIP and the
updater archive hold that same final app. The app needs no entitlements.

`pnpm desktop:verify:release` checks the built release files without uploading:
the bundle and bundled host, Gatekeeper and stapling when signed, the extracted
ZIP, both manifests, and a dry run of the publisher
(`SUPLEX_PUBLISH_DRY_RUN=1 bash scripts/publish-desktop-release.sh`).

### Publication

After `mise run desktop:dist:signed`, publish with `mise run desktop:publish`.
The publisher verifies the signed app, the stapled DMG, the extracted ZIP, and
both manifests, then uploads the ZIP, DMG, and updater archive as immutable
objects and checks their public URLs. Only then does it upload `latest-mac.yml`
and `latest-tauri.json` with `no-cache`, after checking that every file they
name is present. A retry after a partial publication accepts an object that is
already live only when its public bytes equal the local file; it never
overwrites a different object. `SUPLEX_PUBLISH_PHASE=files` or `manifest` runs
one phase; the combined release runs all files for Mac, Linux, and Windows
before any manifest.

`mise run release:major`, `release:minor`, and `release:patch` run the release pipeline: verify a clean checkout, fetch the service account, bump the frontend, desktop, desktop shell crate, and native versions, build every target, commit, tag, push, then publish every target, files before manifests.
A target is `mac`, `linux-cli`, `linux-desktop`, or `windows`, each optionally
`-arm64` or `-x64`. Arguments pick the targets, so `mise run release:patch
linux-cli-x64` ships one Linux CLI archive and leaves every other feed on the
previous version; a later full release catches them up. Without arguments the
release runs every target. `scripts/release-target.sh` runs one target through
one phase; `SUPLEX_RELEASE_DRY_RUN=1` prints the targets and stops. A rerun after a failure keeps Linux and Windows
desktop builds already signed from the same commit. The Tauri app version comes from
`apps/desktop/package.json`. The bump starts from the highest stable version
in the checkout, local tags, and live `origin` tags. Remote lookup failures stop
the release before version files change or builds start. The pipeline rechecks
that the tag is unused before committing, then pushes the branch and tag
atomically. A concurrent tag collision stops the push and publication; it never
replaces an existing tag. The manifests are published last.

Run `node scripts/test-release-version.mjs` to check version selection and tag
collisions with temporary Git repositories.

`mise run mobile:release` ships the iOS and Android shells in `apps/mobile/` at the
latest `v*` tag. It checks out the tag in a reusable worktree under
`~/.cache/suplex/mobile-release`, then:

- builds and signs the iOS app with the App Store Connect API key, uploads it,
  waits until Apple processes the build, and submits it for App Review
  (`scripts/submit-app-store.mjs`). The script moves the editable App Store
  version to the tag's version, attaches the build, and sets the update notes
  from `SUPLEX_APP_STORE_WHATS_NEW` (default "Fixes and improvements.");
- builds the Android App Bundle, signs it with the Play upload key, and releases
  it on the Play track in `SUPLEX_PLAY_TRACK` (default `internal`).

The signed `.ipa` and `.aab` stay in `apps/mobile/release/<tag>`. Credentials come
from the "Mobile store release" item in the 1Password Suplex vault through
`apps/mobile/release.env`. Without a Play service account, the task signs the bundle
and stops before the upload; Google Play requires the first bundle to be
uploaded by hand in the Play Console. The App Store version and the Android
version code come from the tag (1.6.1 is version code 1006001), so one tag can
be uploaded to each store only once. `SUPLEX_MOBILE_PLATFORMS=ios` or `android`
ships one platform.

The Electron app is not updated in place to the Tauri app. An installed Electron
Suplex.app is replaced by `install.sh`, `suplex update`, or a new download, and
keeps its data directory.

### In-app updater

The app checks the feed at launch and every hour while it is open. It downloads
only after **Start download** and installs only after **Restart Suplex**; there
is no install on quit.

| Event | What the viewer sees |
| --- | --- |
| An automatic check finds a newer version | A notification, once for each version in an app run. A click opens the download dialog. |
| **Check for updates** finds a newer version | The download dialog. |
| **Check for updates** finds no newer version | A dialog that says the app is current. |
| The download finishes | A notification. A click opens the restart dialog. **Check for updates** opens the restart dialog again. |
| The download fails, including a signature that does not verify | A notification. A click opens the error. |
| The installation fails | An error dialog. The installed app is unchanged and the update must be downloaded again. |
| A check fails | An error dialog for a manual check. Nothing for an automatic check. |

**Restart Suplex** replaces the app bundle first. Only after that succeeds does
the app stop the host it started, remove its Tailscale route, and relaunch; an
adopted or remote host remains untouched. If notifications are off for Suplex,
automatic checks show nothing and **Check for updates** still reaches the
pending download.

### Dialog rules

Two rules keep the app replaceable. Both come from an incident: versions 1.2.0 and earlier opened the download dialog from the hourly check, and an app left open at release time could not be quit by `install.sh` or `suplex update`.

1. **Attach every message box to a visible window.** Use `Effects::dialog` in `apps/desktop/src-tauri/src/effects.rs`, which shows the window and attaches the dialog to it. A message box with no visible parent window blocks quitting while nobody can see it.
2. **Open a dialog only as the direct answer to a click.** An event that arrives later posts a notification, and a click on it opens the dialog. macOS refuses a quit request while any dialog is open.

The Electron measurements behind these rules (Electron 44.2.0 on Darwin 25.5,
with the app in the background) showed an unattached message box invisible,
the main process stopped until it was answered, and the quit event and SIGTERM
refused. The Tauri shell shows dialogs asynchronously, so its event loop keeps
running, and it quits in order on SIGTERM.

### Replacing a running Suplex.app

Three paths replace the app:

| Path | Source | Starts from |
| --- | --- | --- |
| In-app updater | `apps/desktop/src-tauri/src/updater.rs` | **Restart Suplex** in the app |
| `suplex update` | `apps/server/src/platform/app_update.rs`, see [the CLI](architecture/cli.md#updates) | A terminal |
| `install.sh` | `apps/server/src/hosted/install.sh`, compiled into `suplex hosted serve` and served at `https://suplex.sh/install.sh` | `curl -fsSL https://suplex.sh/install.sh \| sh` |
| `install.ps1` (Windows) | `apps/server/src/hosted/install.ps1`, compiled into `suplex hosted serve` and served at `https://suplex.sh/install.ps1`. It installs for the current user, checks the Authenticode signer, and stops a running app first; the Windows app owns no host | `irm https://suplex.sh/install.ps1 \| iex` in PowerShell |

`suplex update` and `install.sh` stop the app with the same sequence:

1. Send the quit event. Wait 10 seconds only if macOS accepts it.
2. Send SIGTERM and wait 10 seconds. The app quits normally and stops the host it started.
3. Send SIGKILL and wait 10 seconds. Only an app that does not answer needs this.

A killed app leaves its host running. `suplex update` stops that host and does not start it from the CLI, so the reopened app starts and owns it. `install.sh` runs `suplex down` before each replacement, from a directory that has no `.suplex`, so it stops the desktop installation's host and not a checkout's. It does not start a stopped host again; the app or `suplex up` does.

## Linux binary distribution

`mise run server:dist:linux` builds arm64 and x64 native binaries with embedded web
assets and migrations. Each architecture produces a versioned tarball, SHA-256
checksum file, and `latest-linux.yml` under `dist/linux/<arch>`.
`mise run server:publish:linux` publishes them to `stable/linux/<arch>` using the
configured release credentials. These are host binaries for servers and
terminals; the Linux desktop app below bundles the same host.

The combined release publisher uploads immutable Mac and Linux artifacts before
updating their download manifests. Linux's manifest describes the available
archive; it does not implement automatic replacement of a running binary.
The host's Git-based checkout updater is a separate mechanism and must not be
presented as an archive updater. Preserve installation data when replacing a
binary, and verify the destination host separately from artifact publication.

## Linux and Windows desktop apps

`mise run desktop:dist:linux` builds the Linux desktop app for arm64 and x64 in
Docker (`apps/desktop/linux/Dockerfile`, Ubuntu 22.04): a deb and an rpm, each with
the bundled host, under `apps/desktop/release/linux-<arch>/`. Each deb is then
installed and launched in a clean Ubuntu 22.04 container
(`apps/desktop/scripts/test-packaged-linux.sh`). The x64 build runs under emulation
and takes longer. The packages run on Ubuntu 22.04, Debian 12, Fedora 36, and
newer, and install the app as `/usr/bin/Suplex` with its resources in
`/usr/lib/Suplex`. There is no AppImage: agents keep the bundled host's path,
and an AppImage mounts at a new path on every launch.

`mise run desktop:dist:windows` builds the Windows installer (NSIS, per-user,
no administrator) for arm64 and x64 by cross-compiling in Docker. See
[the Windows build](../apps/desktop/windows/README.md). The
Windows app connects to Suplex hosts on other computers only; it has no local
host, because the host does not run on Windows.

Both builds read the same variables as the Mac build. Each platform has its
own feed folder beside the Mac ones: `stable/linux/<arch>/` and
`stable/windows/<arch>/`. With `SUPLEX_DESKTOP_UPDATE_URL` the app gets an
`app-update.yml` for its folder. With the updater key pair the Mac signs each
package (`apps/desktop/scripts/finish-platform-release.sh`) and writes
`latest-tauri.json`, with one entry per package type
(`linux-<arch>-deb`, `linux-<arch>-rpm`, `windows-<arch>-nsis`). The private
key never enters the container. `latest-linux-desktop.yml` and
`latest-windows.yml` list the files for `suplex.sh/download`
(`platform=linux-desktop-x64`, `linux-desktop-arm64`, `windows-x64`,
`windows-arm64`).

`scripts/publish-desktop-platform-release.sh` publishes one folder with the
same immutable-file and manifest-last rules as the Mac publisher. The deb and
rpm updates install through `pkexec`, so Linux asks for an administrator
password. The release Authenticode signs the Windows app and installer with
Azure Trusted Signing, from the `Azure Trusted Signing` item in the Suplex
vault ([Windows build](../apps/desktop/windows/README.md#authenticode-signing)). A build
without that item is unsigned, and Windows SmartScreen shows an unknown
publisher.

`mise run desktop:check:linux` and `desktop:check:windows` run the desktop
shell's clippy and tests on each platform.

