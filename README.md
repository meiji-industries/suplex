# Forge

Forge is a local-first, Tailscale-only software-delivery control plane.

The health surface uses a source-owned shadcn/Rhea-style component layer with Base UI primitives, Tailwind v4 design tokens, and a dense desktop application layout inspired by Linear and Paperclip.

## Start Forge locally

Forge owns the Temporal development container, API, and worker processes. Docker is required for the persistent local Temporal service. If the tailnet endpoint enforces HTTPS, use the idempotent setup wizard first:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run forge -- setup
pnpm run forge -- start
```

The wizard offers Tailscale Serve HTTPS (recommended) or direct Tailscale HTTP, discovers the local MagicDNS hostname when Tailscale is available, and upserts only Forge's keys in `.forge/forge.env`. Re-running it is safe. In Serve mode, Forge listens on `127.0.0.1` and Tailscale terminates HTTPS at the configured `https://<magicdns>:4111` URL; the loopback exception is accepted only because that proxy boundary is explicit and recorded.

If the wizard reports that the local Tailscale daemon is unavailable, start and sign in to the Tailscale app, verify `tailscale status`, and rerun setup. The selected Forge configuration is retained; no credentials are collected.

Serve HTTPS is a tailnet endpoint. Verify it from another device joined to the same tailnet; the Forge host itself may not loop back through its own Tailscale IP during the TLS handshake. For local diagnostics, use `http://127.0.0.1:4111/health` and confirm `tailscale serve status` shows the HTTPS proxy.

The command is otherwise intentionally strict: it refuses wildcard, public, LAN, and loopback direct bindings. Open the exact address printed by the command, then append `/health`. The page shows the configured MagicDNS/Tailscale address and separate state for Temporal, SQLite/WAL, artifact storage, the worker task queue, Codex authentication, and GitHub CLI authentication.

Use the recorded identities for lifecycle operations:

```sh
pnpm run forge -- stop
pnpm run forge -- restart
```

Shutdown reads `.forge/data/runtime/owned-processes.json`, verifies each recorded PID's command identity, and stops only those PIDs plus the Forge-labeled Temporal container. It never searches by broad process name or port.

For a foreground run suitable for local debugging, use `pnpm run forge -- start --foreground`.

After building the package, the same setup entry point is available as `npx forge setup`.

## Development checks

```sh
pnpm run typecheck
pnpm run test
pnpm run test:browser
```

The browser proof uses a mobile viewport and the same responsive health page served by the API. The real Temporal lifecycle proof requires a running local Temporal service; start Forge first and run it with `FORGE_RUN_TEMPORAL_TESTS=1` when the local environment is ready.
