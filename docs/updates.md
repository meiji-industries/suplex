# Forge updates

Forge updates the host and desktop app independently.

## Host updates

`mise run dev`, `mise run dev:watch`, and `pnpm run forge start` launch a stable
Node supervisor. The supervisor owns only the Forge server child. It does not own
or signal native agent processes.

An administrator can check for an update and select **Restart Forge**. The
supervisor fetches the pinned `meiji-industries/forge` `main` branch, verifies a
fast-forward, stops its server child, applies the merge, installs frozen
dependencies, and starts the server again. Production launches also rebuild
assets. Development launches continue to use Vite HMR and skip that production
build.

Git protects local work. Forge never resets, stashes, cleans, or rebases the
checkout. A conflicting local edit or divergent branch stops the update and the
supervisor tries to restart the current checkout once. Retry remains available
when Git advanced but installation or startup failed.

The update state exists only in the running supervisor. Old update lock or status
files have no effect. If a registry-owned installation still runs the previous
launcher, restart it once with `pnpm run forge restart`. If an existing
`mise run dev` terminal still runs the previous launcher, press Ctrl-C and run
`mise run dev` once.

## Desktop app updates

The Electron main process uses `electron-updater`. The remote Forge page remains
sandboxed and receives no updater IPC.

Desktop updates are disabled unless the package build receives an HTTPS generic
feed:

```sh
FORGE_DESKTOP_UPDATE_URL=https://releases.example.com/forge/ mise run desktop:dist
```

The configured feed must host the generated `latest-mac.yml`, macOS ZIP, and ZIP
blockmap at the same base URL. The DMG is useful for manual installation but is
not the updater payload. Keep the application version newer than every published
version.

A distributable macOS update requires a consistent Developer ID signature on the
existing application and the downloaded ZIP. Electron Builder can discover an
installed signing identity during a local build. Production distribution
normally also requires hardened runtime, notarization, and stapling. The
repository does not configure the feed contents, publication, notarization, or
a release server. End-to-end installation cannot be verified without those
external inputs.

Automatic checks stay silent when no feed is configured. A manual check explains
that desktop app updates are not configured. When an update exists, Forge asks
before download and asks again before restarting the desktop app. The Forge
host stays active.
