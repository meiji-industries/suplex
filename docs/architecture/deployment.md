# Instances, clients, and distribution

For contributors and operators choosing where Suplex runs, this page explains
the host/client boundary and the supported distribution paths. Sources:
[host entry point](../../rust/src/main.rs),
[installation configuration](../../rust/src/platform/config.rs),
[desktop boot](../../desktop/src/boot.ts),
[desktop target policy](../../desktop/src/suplex-target.ts),
[binary embedding](../../rust/build.rs), and
[Linux packaging](../../scripts/build-linux.sh).

## One instance owns the work

A Suplex instance is a host installation with its own configuration, SQLite
database, task runtime files, artifacts, and repository/worktree locations.
The Rust server serves the web application and API and runs task coordination.
Native agent tools, Git operations, and Herdr run on that host. The client
presents the interface and sends commands; it does not need a local copy of
the host's repositories or the host's model credentials.

This lets a development server do the work while a laptop connects through a
browser or the desktop app. Closing a browser or remote desktop window does
not stop that independently managed server. The server's availability and task
recovery depend on its host lifecycle, not an open client window.

The connection model is:

```mermaid
flowchart LR
  Web[Web browser] --> Host[Suplex host: web app and API]
  Desktop[Desktop remote client] --> Host
  Host --> Store[Instance database and task files]
  Host --> Work[Git repositories and worktrees]
  Host --> Agents[Native agent tools]
  Host --> Panes[Herdr displays]
```

The same model applies locally, with the desktop app and host on one Mac. In
local desktop mode, the app additionally installs and supervises its bundled
host. See [runtime ownership](runtime.md) for scheduling and state authorities.

## Local and remote connections

Local access binds to loopback. The desktop app always keeps its bundled host
on `127.0.0.1` and stores installation data under
`~/Library/Application Support/Suplex`. Local requests receive the built-in
Operator session. This is an owner-controlled host trust model, not isolation
from other local processes.

The **Access** settings control both network reachability and Suplex sign-in
policy. **This Mac only** binds the bundled host to loopback. **Tailscale**
creates an HTTPS Serve route to the loopback host. **All networks** binds the
host to all IPv4 interfaces and does not terminate TLS. The desktop window
continues to use the loopback URL in every mode.

An open policy assigns requests without a credential to the selected active
account. Its current role and company memberships apply. **Require HTTPS**
rejects remote HTTP requests; it does not claim that Suplex terminates TLS.
Tailscale mode supplies its HTTPS address automatically. For a loopback reverse
proxy, save the external HTTPS origin in Access settings. **Require sign-in**
also requires HTTPS and accepts only passkey-authenticated sessions from remote
clients. Existing automatic and legacy sessions lose remote authority when
this policy is enabled.

Passkeys are scoped to the configured HTTPS origin. Open that address from the
Access page before enrolling or authenticating with a passkey. Existing
passkeys can be renamed or removed from local Access settings. A hostname
change can require enrollment at the new relying-party hostname; credentials
without matching relying-party metadata are not presented as universally
portable.

Local recovery is separate from remote policy. It requires an actual loopback
peer, a loopback Host at the active port, and no forwarding or Tailscale proxy
indicators. Reverse proxies and Tailscale Serve connect from loopback but are
classified as remote before session authorization. A configured reverse proxy
is accepted as HTTPS only when its forwarded HTTPS authority matches the saved
external origin. Tailscale Serve is accepted only for its configured canonical
authority and HTTPS forwarding metadata. Identity headers alone do not prove
HTTPS or local recovery.

The app stores only the selected mode in `network-access.json`. When Tailscale
is selected, the app asks the current Tailscale CLI for this Mac's MagicDNS
name and passes that observation to the host process. It does not store the hostname.
When the app disables Tailscale access, it removes and verifies only the root
Serve handler that points to the active Suplex port. Other Serve ports and paths
remain unchanged. If that verification cannot finish, the app stores only the
port in `network-access-cleanup.json`. Before a later local start, it rediscovers
Tailscale and checks the live Serve configuration. The cleanup record does not
act as proof that a route exists or that cleanup succeeded.

Remote access connects to an existing instance URL. The desktop app installs
nothing on the remote host and does not start or stop that host. The same web
application is available in a browser. Agent executables, sign-ins, project
paths, and integration credentials must be configured on the server where the
work executes, not on each thin client.

The server supports Tailscale Serve HTTPS or a direct Tailscale bind for remote
access. It rejects arbitrary public and LAN bind addresses. The desktop URL
policy accepts HTTPS targets and permits plain HTTP only for loopback targets.
Consequently, a direct Tailscale HTTP endpoint is not an accepted remote desktop
target; use the HTTPS exposure for that client. An HTTPS URL passing desktop
validation does not by itself establish a supported public-server deployment.
See [installation and access](../../README.md#set-up-an-installation).

The desktop Navigate menu remembers instance URLs and lets you switch between
them. Switching changes the instance you view; it does not move tasks, merge
databases, or synchronize credentials. Each instance retains its own state.
Projects and companies are organizational boundaries within an instance, not
separate servers or a distributed worker pool.

## Distribution paths

The repository builds these forms of Suplex:

| Distribution | Contents and execution | Client |
| --- | --- | --- |
| macOS desktop | Electron application with a native host binary and runtime manifest; Apple silicon and Intel builds | Bundled web client for local mode, or a thin client of another instance |
| Linux binary | Architecture-specific `suplex` executable in a versioned tarball, with checksum and download manifest; arm64 and x64 builds | Browser, or a remote desktop client on another machine |
| Source checkout | Frontend build plus native Rust host, with development and supervised installation commands | Browser or desktop URL connection |

The release binary embeds the built frontend assets and SQL migrations. A
standalone host does not need a separate frontend server or Electron to serve
the application. Node, pnpm, and Rust participate in building from source; they
are not a separate JavaScript application server shipped alongside the native
binary. Native providers, Git, and display tools remain host dependencies.
A packaged binary does not bundle or authenticate every agent tool.

Linux packaging uses a Debian-based build environment and produces an
architecture-specific executable, not a universally static binary. Platform
compatibility and authenticated provider execution still require verification
on the destination host. Build scripts establish artifact support, not proof
that a particular version has been published or installed successfully.

## Process ownership and updates

In local desktop mode, the app starts its bundled host and stops the process
group it owns on quit. A network mode selection saves the preferred mode but
does not change the running host. The Access page and the native menu show an
explicit **Restart** action when the saved mode differs from the active owned
mode. Restart resolves current Tailscale state, stops the owned host, and starts
the same database in the saved mode. If the new start fails, the app restores
the previous working mode when it can do so safely. It retains the saved mode,
so the pending restart remains available for retry. It can adopt an already
running host only when that host reports the same installation identity. It
never stops an adopted host and saves a changed network setting for the next
managed start.
An unrelated server occupying the preferred port causes another local port to
be selected; answering a health check is not enough to claim ownership.

The remote web page is sandboxed in Electron, with Node integration disabled.
Desktop connection, installation, and updater controls belong to the desktop
shell. The remote application does not receive authority to update the client
or run arbitrary client-side tools. A server worktree path also does not imply
that the same path exists on the client. See the README's **Open in** behavior
before changing local-tool launch assumptions.

Desktop updates replace the app and its bundled host together. Checkout hosts
have a separate Git-based update mechanism. Linux archives have their own
publication manifest; that manifest is not an Electron update feed or proof of
an automatic binary updater. See [updates and release publication](../updates.md)
for the existing distribution procedures. Native sessions retain their own
execution state across host recovery; stopping a host is not proof that every
agent child process has finished.

[Architecture index](README.md)
