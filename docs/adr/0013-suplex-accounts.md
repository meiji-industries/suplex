# ADR 0013: Suplex accounts

Status: accepted. Decision made 2026-10-02.

## Decision

A Suplex installation links one hosted Suplex account. The hosted service at
`suplex.sh` (the `suplex hosted serve` process that also runs billing) owns
identities and their Google, GitHub, and Resend credentials. The private host
stores the link in `suplex_account` and shows the login view on application
pages until that row exists.

- **Per installation.** One account covers the host. Everyone signed in on the
  host with a passkey works under it. [ADR 0009](0009-trust-the-tailnet-for-login.md)
  keeps one Operator; the account names the installation for product identity,
  not for authorization.
- **Polling completion.** The host creates an attempt with
  `challenge = base64url(sha256(verifier))` and keeps the verifier in memory.
  The browser runs the provider flow on `suplex.sh`. The host polls with the
  verifier and receives the account token once.
- **`suplex://` focuses only.** The done page opens `suplex://auth/done` to
  bring the desktop app forward. The app never reads or loads that URL.
- **Local authority.** The page gate reads the local link row only. The host
  never revalidates the account on open, so hosted downtime never affects a
  linked host. A lost pending attempt reports `expired`, and the person retries.

## Reason

A deep link that carried a token would let any local process that registers
`suplex://` receive it, and macOS lets the last-registered app win. Polling with
a verifier keeps every secret on HTTPS between the host and `suplex.sh`; the
browser only proves the provider login.

Linking per installation joins the website visitor, the download, the
installation, and the in-app browser as one PostHog person without adding
per-user identities to the host.

## Consequences

- A live attempt ID lets its holder finish that attempt with their own provider
  account. The ID is 128 random bits, exists only in the URL the app opened,
  lives 15 minutes, and is single use. The app then shows "Logged in as <email>".
- Per-user accounts on shared hosts, server-side revocation checks, and SAML
  are not part of this decision.
- See [Suplex accounts](../accounts.md) for endpoints, tables, and setup.
