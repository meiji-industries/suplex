# ADR 0009: Trust the tailnet for login

Status: accepted, 2026-09-06. Amends the earlier passkey decision, ADR 0004
(available in Git history). Current access modes are described in the
[README](../../README.md#set-up-an-installation).

## Context

The original installation required tailnet access and passkeys. Local installations now also support loopback access. Passkeys inside an Electron shell against a tailnet origin need either a provisioning-profile entitlement for device-bound Touch ID or Associated Domains that Apple's CDN cannot fetch from a tailnet host. Both reference desktop products we compared rely on the network boundary plus bearer credentials, not on WebAuthn.

## Decision

A request without a session is signed in as the built-in Operator administrator when it is trusted: it carries the `Tailscale-User-Login` header that Tailscale Serve adds to tailnet requests, or it arrives on the loopback host, or, in direct mode where Suplex binds a Tailscale address, it is addressed to that hostname. The normal session and CSRF cookies are issued, so every route keeps working unchanged. Funnel traffic and tagged devices carry no identity header and receive no automatic Operator session. Users, sessions, invitations, and passkeys remain; passkeys become optional.

## Consequences

- Suplex.app and any tailnet browser open signed in. Tailscale ACLs are the access boundary.
- Everyone is the same Operator user for now. Per-person identity can later map `Tailscale-User-Login` to Suplex users without changing routes.
- A local process on the Suplex host is trusted; it already owns the SQLite file.
