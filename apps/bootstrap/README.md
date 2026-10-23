# suplex-bootstrap

Run [Suplex](https://suplex.sh) on a cloud VM, with every agent's internet traffic optionally routed through a
Tailscale exit node at home (so GitHub, package registries, and model providers see your residential IP).
One interactive command creates or converges the server and ends with a login link.

```sh
curl -fsSL https://suplex.sh/bootstrap.sh | sh
```

The script installs `suplex-bootstrap` in `~/.local/bin` (macOS or Linux, arm64 or x64; checksum-verified, and
on macOS the Developer ID signature is checked too), then starts the wizard. Run it again to update.
Afterwards, `suplex-bootstrap` alone reruns the wizard. Answers live in `~/.config/suplex-bootstrap`
(`--dir` or `SUPLEX_BOOTSTRAP_DIR` picks another directory, one per server).

The wizard (Rust, [cliclack](https://github.com/fadeevab/cliclack) prompts) asks for and remembers:

- **Where the VM lives**: Hetzner Cloud (`hcloud`), DigitalOcean (`doctl`), or a server you already have (an IP).
  With a provider it lists your servers and can create a new one (type, image, location, SSH key).
- **How you reach Suplex**:
  - *Tailscale* (recommended): HTTPS via Tailscale Serve, Tailscale SSH for admin, optional exit-node egress. Asks the
    hostname, an auth key for the first join, who can open the URL (only your tailnet, or anyone on the internet
    through Tailscale Funnel), and the HTTPS port: 443 (`https://<host>.ts.net`) or 4111; Funnel allows 443, 8443,
    or 10000. Suplex binds the port Serve exposes, so 443 adds `AmbientCapabilities=CAP_NET_BIND_SERVICE` to the
    unit. Funnel visitors carry no tailnet identity, so they see the login page and need a hosted account that
    the host invited. Suplex's supervisor re-applies `tailscale serve` on every start, which drops the Funnel
    flag; a one-minute timer (`suplex-funnel.timer`) puts it back.
  - *Public HTTPS via Cloudflare Tunnel*: a hostname inside a zone on your Cloudflare account. The wizard uses a
    Cloudflare API token (Account: Cloudflare Tunnel Edit; Zone: DNS Edit and Transform Rules Edit) to create a
    remotely managed tunnel, point it at Suplex on loopback, add a proxied CNAME, and add a request-header
    transform rule that sets `X-Forwarded-Host` for that hostname. Suplex trusts a proxied request as HTTPS only
    with that header and `X-Forwarded-Proto: https`, which Cloudflare's edge sends on its own (a rule cannot set it). The VM runs `cloudflared` as a service with the tunnel token; no inbound
    ports, and the exit node is irrelevant because the tunnel is outbound. Admin SSH uses the public address.
  - *Localhost only*: Suplex on `127.0.0.1:4111`; reach it with `ssh -L 4111:127.0.0.1:4111 root@<ip>`.
  - *All network access* (not recommended): plain HTTP on every interface. Suplex still refuses remote requests
    that are not verified HTTPS, so this only makes sense behind a proxy you run elsewhere.
- **Exit node** (Tailscale only): pick one from your tailnet or none. With one, an nftables default-deny firewall on the VM makes
  the exit node the only way out, for the host and for Docker containers. Exit node offline = no internet.
- **GitHub**: an SSH private key from this machine and a git identity, installed for the `suplex` user.
- **Backup**: a Suplex backup archive (`suplex backup` or Settings → Backups) to restore onto the VM.
- **Login link**: prints a one-time owner link from `suplex recover` at the end.

Everything on the VM is then converged, idempotently: service user, firewall, Docker, the Suplex
binary (the release tarball `suplex.sh/install.sh` would fetch, checksum-verified, owned by the service user so
the in-app update can replace it; the installer itself refuses root), mise/node/pnpm/uv, Claude Code, Herdr, systemd units
that start on boot. Sign-ins only a human can do (Claude Code, `gh`) are offered interactively at the end.
Rerun the wizard any time; every answer defaults to the last one.

| Command | Does |
| --- | --- |
| `suplex-bootstrap` | the wizard above |
| `suplex-bootstrap up` / `down` | power on (waits for SSH over the tailnet) / graceful shutdown. Stopped servers still bill. |
| `suplex-bootstrap destroy` | delete the server; stops billing; loses the disk |
| `suplex-bootstrap status` | provider state, services, service user, exit node, egress IP, direct-interface block, health |
| `suplex-bootstrap doctor`, `logs`, `ssh` | `suplex doctor` as the service user, follow the service log, admin shell |
| `suplex-bootstrap install-suplex` | install/update the Suplex binary on the server and restart the service |
| `suplex-bootstrap recover` | a fresh one-time owner login link |

From a checkout, `mise run bootstrap` and `mise run bootstrap:<command>` build and run the same commands, with the
answers in `apps/bootstrap` (gitignored) instead of `~/.config/suplex-bootstrap`.

Releasing: bump `version` in `apps/bootstrap/Cargo.toml`, start Docker, and run `mise run bootstrap:release`. It
builds macOS (signed with the Developer ID) and Linux (Docker, glibc 2.31+) binaries for arm64 and x64
(`scripts/build-bootstrap.sh`), uploads them to R2 at `stable/bootstrap/<platform>/` beside the app releases, and
points each `latest.yml` at them last (`scripts/publish-bootstrap-release.sh`). `suplex.sh/download?platform=bootstrap-<platform>`
reads that manifest; `suplex.sh/bootstrap.sh` is `apps/server/src/hosted/bootstrap.sh`, so a change to the script
ships with `mise run hosted:deploy`. Bootstrap releases are separate from Suplex releases.

Layout: the crate lives in the Suplex repository at `apps/bootstrap`, a member of the root Cargo workspace. `src/main.rs` (wizard and commands), `src/provider.rs` (one match arm per cloud; add a provider there),
`src/remote.rs` (ssh/scp). `vm/` holds what runs on the VM, embedded into the binary: `join.sh` (first boot,
over the public IP), `converge.sh` (everything else, over the tailnet), `status.sh`, the nftables rules and
systemd units. Answers live in `vm.env`; secrets (`TS_AUTHKEY`, provider tokens) in `.env` (0600, gitignored).
Styling is cliclack's default theme; implement its `Theme` trait in `main.rs` to restyle every prompt.

Local requirements: `ssh`, `scp`, and the provider CLI if you use one (`brew install hcloud` / `doctl`).
A provider token is optional when the CLI is already logged in. `tailscale` on this machine lets the wizard
list exit nodes; without it you type the name.

## The reference VM

Hetzner CPX62 `vm` (Helsinki, Ubuntu 26.04, 16 vCPU, 32 GB), tailnet name `suplex`,
exit node `exit-node` (home IP 203.0.113.10). `ssh build-host` is the admin shell; `ssh suplex@suplex` is the
agent user (Tailscale SSH). Suplex: https://suplex.tail1234.ts.net:4111 (Tailscale Serve HTTPS, tailnet only).
Suplex and every agent run as the non-root user `suplex` (no sudo): Claude Code refuses
`--dangerously-skip-permissions` as root, so Workers died at launch while the service ran as root (suplex#401).
Verified: direct `eth0` blocked, exit node off = nothing leaves, survives reboot.

## How the VM is set up (knowledge for suplex.sh docs)

1. `curl -fsSL https://tailscale.com/install.sh | sh`, `tailscale up --authkey … --hostname suplex --ssh --accept-dns`,
   then `tailscale set --exit-node=exit-node`. Setting the exit node breaks an SSH session over the public
   IP (replies reroute); reconnect over the tailnet.
2. `/etc/suplex-egress.nft` + `suplex-egress.service`: OUTPUT policy drop; allow `lo`, `tailscale0`,
   tailscaled's own packets (fwmark `0x80000`), DHCP, Hetzner metadata, IPv6 ND, and replies to inbound.
3. The binary goes to `/home/suplex/.local/bin/suplex`, owned by `suplex`, from
   `https://suplex.sh/download?platform=linux-x64&format=tar.gz` plus its `.sha256`, the same steps as `install.sh`;
   `/usr/local/bin/suplex` is a symlink to it for the admin shell. The installer refuses root since suplex#402, so root
   runs `vm/install-suplex.sh` instead. The service user owns the file so the in-app update and `suplex update` can
   replace it; the unit's `ProtectSystem=full` keeps `/usr` read-only for the service.
4. `/home/suplex/.local/share/Suplex/suplex.env`: `SUPLEX_ACCESS_MODE=tailscale`,
   `SUPLEX_TAILSCALE_EXPOSURE=serve`, `SUPLEX_TAILSCALE_ADDRESS=<node>.<tailnet>.ts.net`, repo and worktree roots.
   The supervisor runs `tailscale serve` itself; the tailnet needs HTTPS certificates enabled.
5. `suplex.service`: `User=suplex`, `suplex up --foreground`, `WorkingDirectory=/home/suplex`, `PATH` with
   `~/.local/bin` (claude, herdr, op) and the mise shims (node, pnpm, uv), `Restart=always`, `NoNewPrivileges`,
   `ProtectSystem=full`, `Requires=suplex-egress.service`, `Wants=herdr.service` (`herdr server` as `suplex`, its own unit). `tailscale set --operator=suplex` lets it run `tailscale serve`.
   `ExecStart` runs `/home/suplex/.local/bin/suplex` directly; `mise run bootstrap:install` updates it as root.
6. Agents, installed as `suplex`: mise (node 24, pnpm, uv), `claude`, `herdr`. Sign in on the VM as `suplex`
   (`ssh suplex@suplex`, run `claude` once, accept the trust dialog for each repo root), not by copying the Mac's
   Keychain credentials. Tasks failed setup earlier because `pnpm` was missing from the service PATH.
9. "Repository provisioning failed" on Add Project: Suplex clones with the system `git` and the machine's own
   credentials, and a fresh Linux box has none for HTTPS GitHub. `gh auth login` then `gh auth setup-git`
   fixes it. Bootstrap runs `setup-git` when gh is signed in.
10. Docker (official repo). `suplex` is NOT in the `docker` group: that is root-equivalent. Grant it only if tasks
    need Docker, or prefer rootless Docker or per-task containers. Container traffic takes the FORWARD path, so the firewall has a forward chain that only
    lets containers out via `tailscale0`. Containers cannot use MagicDNS, so `/etc/docker/daemon.json` sets public
    DNS servers, which themselves go through the exit node. Tailscale's exit-node table (52) has a default route
    and no exception for local bridges, so replies to containers went into the tunnel; `suplex-egress.service`
    adds `ip rule to 10.200.0.0/15 lookup main pref 5000`. The bridge lives at 10.200.0.1/24 with pools in
    10.201.0.0/16, clear of 172.17.0.0/16, which the exit node advertises as its own Docker subnet.
11. 1Password for project setup: a service account token in `/home/suplex/.config/op/service-account-token` (0600,
    owner `suplex`) and an `op` wrapper in `/home/suplex/.local/bin` that exports it. Suplex strips token-like variables from setup
    environments, so the token cannot be passed through the service unit or project settings. This is a
    per-project extra done by hand on the reference VM; the wizard does not install or configure `op`.
12. PostgreSQL 18 (apt, system service on 127.0.0.1:5432) for the rtd project. The service user has no sudo, so
    the repo's admin path (`sudo -n -u postgres`) cannot create roles. One-time as root: role `rtd_user`
    (LOGIN, CREATEDB, password from the repo Makefile), databases `rtd_development` and `rtd_testing` owned by it,
    and a SUPERUSER role `suplex` whose random password sits in `/home/suplex/.pgpass` (0600). The repo's helper
    tries `psql -w -h localhost -d postgres` as the OS user first, so with `.pgpass` its admin path works
    without sudo. PostgreSQL listens on loopback only.
13. First login shows "This account has not been invited to this host": `suplex recover --confirm-recovery` prints a
   one-time owner link. Bootstrap does this at the end.
14. Restoring a backup: `suplex restore <archive> <empty dir>` verifies, extracts, and migrates it; the database is
   `suplex-backup/app/suplex.sqlite` and artifacts `suplex-backup/app/artifacts/`, copied into
   `~/.local/share/Suplex/data/` with the service stopped. Projects keep their stored repository paths.
7. Network: the exit node is IPv4-only, so apt is forced to IPv4 and `gai.conf` prefers IPv4. Hetzner's apt
   mirror only answers from inside Hetzner, so sources point at `archive.ubuntu.com`. `gh` installed via apt.
8. GitHub: the Mac's `~/.ssh/id_rsa` copied to `/home/suplex/.ssh/` (0700/0600), `github.com` in `known_hosts`,
   git identity and `gh auth setup-git` as `suplex`. `gh auth login` is interactive, once, as `suplex`.

## Migration record (7 Oct 2026)

Root state was copied, not moved: `/root/.local/share/Suplex`, `/root/suplex`, `/root/.claude*`, `/root/.config/{op,gh}`
remain as the backup, plus `/root/suplex-root-backup-*.tgz`. Stored paths were rewritten in `suplex.env`, the
SQLite columns `suplex_projects.{repository_path,worktree_root}`, `suplex_tasks.configuration_json`,
`suplex_task_controls.worktree_json`, `*.workflow_input_json`, the runtime records, `.claude.json`, and the
`~/.claude/projects/-root-…` session directories (renamed to `-home-suplex-…`). Git worktree metadata also stores
absolute paths (`.git/worktrees/*/gitdir` and each worktree's `.git` file), so every repo needed
`git worktree repair <new worktree paths>`; without it, fetches fail with `Invalid path '/root/suplex'`.
Delete the root copies once `mise run bootstrap:status` and a real task pass.
