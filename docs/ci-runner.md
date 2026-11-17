# Self-Hosted CI Runner

The Rust and Linux desktop jobs run on `suplex-vm`, a self-hosted GitHub Actions runner on this project's Hetzner VM. Blacksmith still runs the Test suite and the macOS job. The `sampler` repository keeps the same guide in `docs/agents/ci-runner.md`, so update both when the host changes.

## Jobs in this repository

| Job | Runner | Trigger |
| --- | --- | --- |
| `Rust fmt, clippy, and tests` | `suplex-vm` | Every push to `main`, every PR; a manual dispatch can choose a Blacksmith runner for timing comparisons |
| `Desktop shell (Linux)` | `suplex-vm` | Every push to `main`, every PR |
| `Test suite` | `blacksmith-8vcpu-ubuntu-2404` | Every push to `main`, every PR. Its native journeys start Suplex servers, which must not share a user with the live host on `suplex-vm`. |
| `Desktop changes` | `ubuntu-latest` | PRs only. It reads the PR's changed files. |
| `Desktop shell (macOS)` | `blacksmith-6vcpu-macos-latest` | Push to `main` and manual dispatch always. A PR runs it only when it changes `apps/desktop/`, `Cargo.lock`, `pnpm-lock.yaml`, `rust-toolchain.toml`, or `.github/workflows/ci.yml`. If the check fails, the job runs. |

macOS minutes cost five times as much as Linux minutes. A web or server change that breaks only the native WKWebView smoke tests shows up on `main` after the merge.

## Host

| Item | Value |
| --- | --- |
| Runner name and label | `suplex-vm`, registered at the `meiji-industries` org level, in the `Default` runner group (private repositories only) |
| Server | Hetzner Cloud CPX62 `ubuntu-32gb-hel1-2` (Helsinki): 16 shared vCPU, 32 GB RAM, 640 GB disk, 8 GB swapfile with `vm.swappiness=10` |
| Admin access | `ssh root@suplex` over Tailscale. The public IP does not answer SSH, because all egress goes through the home TrueNAS exit node. |
| Runner user | `suplex`, the same user as the Suplex host and its agents (`ssh suplex@suplex`). It has no sudo and is not in the `docker` group. |
| Install | `~/actions-runner` (runner 2.338.2), user unit `~/.config/systemd/user/gh-runner.service` (linger is on) |
| Toolchains | `~/.ci/cargo` and `~/.ci/rustup`, set as `CARGO_HOME` and `RUSTUP_HOME` in `~/actions-runner/.env`. They are separate from the agents' toolchains. `~/actions-runner/.path` sets the job `PATH`. |

The host also runs the Suplex host service and its agent tasks. CI shares the machine with them, so the unit caps CI:

| Limit | Value | Effect |
| --- | --- | --- |
| `CPUQuota` | `800%` | At most 8 of 16 vCPUs |
| `MemoryHigh` / `MemoryMax` | `5G` / `6G` | Throttles at 5 GB; the kernel kills the job inside its own cgroup at 6 GB |
| `MemorySwapMax` | `0` | CI never swaps, so it cannot make the host thrash |
| `Nice`, `IOSchedulingClass` | `10`, `idle` | Agents get the CPU and the disk first |
| `CARGO_BUILD_JOBS` (`.env`) | `6` | Lowers the peak memory of Rust builds |

There is one runner, so self-hosted jobs from all repositories run one at a time.

## Rules for workflows on `suplex-vm`

- Use `runs-on: suplex-vm`.
- Check out with `clean: false`. The default `git clean -ffdx` deletes `target/`, which is the build cache. Each job keeps the existing size-limit step (`cargo sweep`), so `target/` cannot grow without limit.
- Do not use Blacksmith sticky disks, `Swatinem/rust-cache`, or `setup-node` caching. The disk persists, and a GitHub cache round trip goes through the home connection.
- Do not use `sudo`, `docker://` actions, container jobs, or `services:`. The runner user has neither sudo nor Docker access.
- System packages are preinstalled on the host. To add one, install it as root and record it here:
  `pkg-config libasound2-dev libclang-dev libjack-jackd2-dev libudev-dev zsh lsof libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev build-essential jq unzip xz-utils zstd`
- `actionlint` 1.7.12 is preinstalled in `~/.ci/cargo/bin`. The pinned `taiki-e/install-action` does not know that version, and the runner cannot run the `rhysd/actionlint` Docker image.
- `.github/actionlint.yaml` lists `suplex-vm` under `self-hosted-runner.labels`.

## Operate the runner

```bash
# Status and logs
ssh suplex@suplex 'systemctl --user status gh-runner; journalctl --user -u gh-runner -n 50'
gh api orgs/meiji-industries/actions/runners -q '.runners[] | [.name,.status,.busy] | @tsv'

# Restart. A stop waits up to 5 minutes for a running job.
ssh suplex@suplex 'systemctl --user restart gh-runner'

# Re-register (needs the admin:org scope: gh auth refresh -h github.com -s admin:org)
tok=$(gh api -X POST orgs/meiji-industries/actions/runners/registration-token -q .token)
ssh suplex@suplex "cd ~/actions-runner && ./config.sh --unattended --url https://github.com/meiji-industries --token '$tok' --name suplex-vm --labels suplex-vm --work _work --replace"
```

The runner updates itself when GitHub releases a new version.

## Failure modes

- **The host becomes unreachable (Tailscale offline, `nstx.suplex.sh` returns 530).** The usual cause is memory exhaustion from agent tasks, not CI. Agent test runs can use more than 13 GB, and `/tmp` is a 16 GB tmpfs that holds RAM. Check `free -g` and `df -h /tmp`, and remove stale task directories from `/tmp`. The Hetzner Console graphs show the pattern: high CPU and constant disk reads of 1–2 GB/s.
- **A job stays queued.** The runner is offline or busy with another repository's job. Check the runner status above.
- **A job is killed with no error.** It reached `MemoryMax`. Lower its parallelism, or raise the cap only when the host has free memory.
- **The first run after a toolchain change is slow.** Rustup downloads the toolchain into `~/.ci/rustup` through the home connection.

## Roll back

Set the job's `runs-on` back to its Blacksmith label, and restore the removed sticky disk or cache steps from git history.
