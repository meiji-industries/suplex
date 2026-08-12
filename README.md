# Forge

Forge is a local-first, Tailscale-only software-delivery control plane.

The health surface uses a source-owned shadcn/Rhea-style component layer with Base UI primitives, Tailwind v4 design tokens, and a dense desktop application layout inspired by Linear and Paperclip.

## Develop locally

```sh
mise install
mise run dev
```

This runs Forge, the frontend watcher, and the pinned Temporal CLI development server together. Temporal listens only on `127.0.0.1:7233`, exposes its UI at `http://localhost:8233`, and persists development state in `.forge/dev/temporal.db`. It needs no Cloud credentials and must not be used in production.

## Run in production

Forge runs its API and workers locally while Temporal Cloud owns durable Workflow state. Create a Temporal Cloud namespace, add the `CompanyId`, `ProjectId`, and `IssueId` custom Search Attributes as `Keyword` values, and create an API key with access to that namespace. Then provide the Cloud connection values to the setup wizard:

```sh
export FORGE_TEMPORAL_ADDRESS="<namespace>.<account>.tmprl.cloud:7233"
export FORGE_TEMPORAL_NAMESPACE="<namespace>.<account>"
export FORGE_TEMPORAL_API_KEY="<api-key>"
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run forge setup
pnpm run forge start
```

The wizard offers Tailscale Serve HTTPS (recommended) or direct Tailscale HTTP, discovers the local MagicDNS hostname when Tailscale is available, and upserts only Forge's keys in the mode-`0600` `.forge/forge.env`, including the Temporal API key. Re-running it is safe. The generated environment file is ignored by Git and excluded from Forge backups. In Serve mode, Forge listens on `127.0.0.1` and Tailscale terminates HTTPS at the configured `https://<magicdns>:4111` URL; the loopback exception is accepted only because that proxy boundary is explicit and recorded.

Setup prints one bootstrap enrollment URL once. It is a 72-hour, one-time passkey invitation; Forge stores only its hash and replacing an unused invitation invalidates the predecessor. There are no password or anonymous Forge accounts. Complete enrollment at `/auth`, manage users and company membership at `/admin`, and use the explicit local recovery command when needed:

```sh
pnpm run forge recover
```

Recovery also prints a one-time passkey URL and revokes existing administrator access after the replacement passkey is enrolled.

After enrollment, configure companies, Codex profiles/capacity, and direct-GitHub projects from `/admin` and `/projects`. Project activation requires a canonical repository inside `FORGE_REPOSITORY_ROOT` and an isolated worktree root inside `FORGE_WORKTREE_ROOT`; both default safely for local use, and the worktree root is created at server startup. Activation checks local Git identity and clean base/target refs, the literal setup/verification policy, required checks, allowed role profiles, and the host's existing `gh` authentication without storing provider credentials.

Create Forge-native work from `/tasks`: each task starts as a company-scoped Backlog card, stores its Markdown brief and optional images as hash-verified immutable artifacts, pins the active project revision, and starts planning only after the explicit expected-revision action. The board is a read model of the durable issue Workflow; it is not directly editable.

If the wizard reports that the local Tailscale daemon is unavailable, start and sign in to the Tailscale app, verify `tailscale status`, and rerun setup. The selected Forge configuration is retained.

Serve HTTPS is a tailnet endpoint. Verify it from another device joined to the same tailnet; the Forge host itself may not loop back through its own Tailscale IP during the TLS handshake. For local diagnostics, use `http://127.0.0.1:4111/health` and confirm `tailscale serve status` shows the HTTPS proxy. The loopback bind is allowed only in this explicit Serve mode; direct mode must bind a Tailscale address.

The command is otherwise intentionally strict: it refuses wildcard, public, LAN, and loopback direct bindings. Open the exact address printed by the command, then append `/health`. The page shows the configured MagicDNS/Tailscale address and separate state for Temporal, SQLite/WAL, artifact storage, the worker task queue, Codex authentication, and GitHub CLI authentication.

Use the recorded identities for lifecycle operations:

```sh
pnpm run forge stop
pnpm run forge restart
```

Shutdown reads `.forge/data/runtime/owned-processes.json`, verifies each recorded PID's command identity, and stops only those PIDs. Forge never searches by broad process name or port.

For a foreground run suitable for local debugging, use `pnpm run forge start --foreground`.

## Manual backup and restore

Temporal Cloud owns Workflow retention and durability. Forge backups cover the local application database, artifacts, and non-secret connection configuration:

```sh
pnpm run forge backup /path/to/forge-backup.tar.gz
pnpm run forge verify-backup /path/to/forge-backup.tar.gz
```

The archive contains the application database, artifact store, and non-secret configuration. Temporal Workflow history remains in Temporal Cloud. User records and company/project state are retained, but passkey registrations, sessions, challenges, invitation tokens, provider credentials, the Temporal API key, and generated environment files are removed. Reauthentication is required after restore.

Restore only into a new empty directory. The command verifies the archive, rebuilds the durable issue projections and operator attention ledgers, reconciles recorded Developer executions and existing GitHub release state without mutating GitHub, and writes `forge-backup/restore-handoff.json` with measured timings and explicit next steps:

```sh
pnpm run forge restore /path/to/forge-backup.tar.gz /path/to/forge-restored
```

Recreate the restored `.forge/forge.env` with the restored host's Tailscale address and paths; preserve the non-secret `installationId`, `temporalNamespace`, and `taskQueue` values from `forge-backup/config/config.json` so Forge reconnects to the existing Workflow history. Do not copy the old generated environment or credentials. Create a new Temporal Cloud API key for the restored host, then start Forge.

Reauthenticate the Forge passkey, Codex, and GitHub CLI on the restored host. Run `verify-backup` again using the restored configuration before treating the backup health check as healthy. Forge does not schedule backups or rotate retained artifacts automatically.

After building the package, the same setup entry point is available as `npx forge setup`.

## Development checks

```sh
pnpm run typecheck
pnpm run test
pnpm run test:browser
pnpm run test:temporal
```

The browser proof uses Playwright at narrow and desktop viewports against the same responsive application served by the API, including passkey enrollment, sign-in/out, membership, and recovery. The Temporal lifecycle proof starts an isolated pinned CLI development server on a dynamic loopback port and runs with `pnpm run test:temporal`; it does not touch Temporal Cloud.

The real Lead integration proof is opt-in because it starts authenticated Codex turns and consumes provider capacity. Run it with a model accepted by the local authenticated Codex account; the proof intentionally forces a same-session format correction and verifies the immutable plan/evidence path:

```sh
FORGE_RUN_REAL_CODEX=1 FORGE_CODEX_REAL_MODEL=<supported-model> pnpm exec vitest run tests/codex-lead.test.ts
```
