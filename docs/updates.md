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

Automatic checks stay silent when no feed is configured. A manual check explains that desktop app updates are not configured. When an update exists, Suplex asks before download and before restarting the desktop app. A bundled host started by Suplex.app restarts with it; an independent host remains untouched.

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
