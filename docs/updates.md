# Suplex updates

Suplex updates the host and desktop app independently.

## Host updates

`mise run dev`, `mise run dev:watch`, and `pnpm run suplex start` launch a stable
Node supervisor. The supervisor owns only the Suplex server child. It does not own
or signal native agent processes.

An administrator can check for an update and select **Restart Suplex**. The
supervisor fetches the pinned `meiji-industries/suplex` `main` branch, verifies a
fast-forward, stops its server child, applies the merge, installs frozen
dependencies, and starts the server again. Production launches also rebuild
assets. Development launches continue to use Vite HMR and skip that production
build.

Git protects local work. Suplex never resets, stashes, cleans, or rebases the
checkout. A conflicting local edit or divergent branch stops the update and the
supervisor tries to restart the current checkout once. Retry remains available
when Git advanced but installation or startup failed.

The update state exists only in the running supervisor. Old update lock or status
files have no effect. If a registry-owned installation still runs the previous
launcher, restart it once with `pnpm run suplex restart`. If an existing
`mise run dev` terminal still runs the previous launcher, press Ctrl-C and run
`mise run dev` once.

## Desktop app updates

The Electron main process uses `electron-updater`. The remote Suplex page remains
sandboxed and receives no updater IPC.

Desktop updates are disabled unless the package build receives an HTTPS generic
feed:

```sh
SUPLEX_DESKTOP_UPDATE_URL=https://releases.example.com/suplex/ mise run desktop:dist
```

The configured feed must host the generated `latest-mac.yml`, macOS ZIP, and ZIP
blockmap at the same base URL. The DMG is useful for manual installation but is
not the updater payload. Keep the application version newer than every published
version.

After `mise run desktop:dist:signed`, publish with `mise run desktop:publish`.
Both tasks fetch their Apple signing and R2 values through the Suplex 1Password
service account. The publisher verifies the signed app and stapled DMG, uploads
immutable versioned artifacts to `stable/mac/arm64`, checks their public URLs,
then uploads `latest-mac.yml` last with `no-cache`.

`mise run release:major`, `release:minor`, and `release:patch` run the full
release pipeline: verify a clean checkout, fetch the service account, bump both
package versions, sign/notarize, commit, tag, push, then publish. The manifest
is published last.

A distributable macOS update requires a consistent Developer ID signature on the
existing application and the downloaded ZIP. Electron Builder can discover an
installed signing identity during a local build. Production distribution
normally also requires hardened runtime, notarization, and stapling. The
repository configures the feed layout and publication command, but signing,
notarization, credentials, and a real update still require the external inputs.

Automatic checks stay silent when no feed is configured. A manual check explains
that desktop app updates are not configured. When an update exists, Suplex asks
before download and asks again before restarting the desktop app. A bundled host
started by Suplex.app restarts with it; an independent host remains untouched.
