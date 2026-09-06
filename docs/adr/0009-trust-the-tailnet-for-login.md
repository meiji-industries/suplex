# ADR 0009: Trust the tailnet for login

Status: accepted (2026-09-06). Amends ADR 0004.

## Context

Forge is reachable only from its tailnet (ADR 0003). ADR 0004 chose passkeys for application login. Passkeys inside an Electron shell against a tailnet origin need either a provisioning-profile entitlement for device-bound Touch ID or Associated Domains that Apple's CDN cannot fetch from a tailnet host. Both reference desktop products we compared rely on the network boundary plus bearer credentials, not on WebAuthn.

## Decision

A request without a session is signed in as the built-in Operator administrator when it is trusted: it carries the `Tailscale-User-Login` header that Tailscale Serve adds to tailnet requests, or it arrives on the loopback host, or, in direct mode where Forge binds a Tailscale address, it is addressed to that hostname. The normal session and CSRF cookies are issued, so every route keeps working unchanged. Funnel traffic and tagged devices carry no identity header and are rejected. Users, sessions, invitations, and passkeys remain; passkeys become optional.

## Consequences

- Forge.app and any tailnet browser open signed in. Tailscale ACLs are the access boundary.
- Everyone is the same Operator user for now. Per-person identity can later map `Tailscale-User-Login` to Forge users without changing routes.
- A local process on the Forge host is trusted; it already owns the SQLite file.
