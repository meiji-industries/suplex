# Suplex accounts

A Suplex account is a hosted identity at `https://suplex.sh`. People log in
with Google, GitHub, or an emailed link. A Suplex installation links one
account; everyone on that host works under it.

## Hosted service

`suplex hosted serve` (`rust/src/hosted/`) is one process on the Fly app
`suplex-production` at `https://suplex.sh`. It serves billing
([billing](billing.md)), accounts (`rust/src/accounts/hosted/`), and the
suplex.sh site (`rust/src/hosted/site.rs`) from one router. Every absolute URL
it builds (Stripe return pages, OAuth callbacks, magic links) uses
`BILLING_PUBLIC_ORIGIN`.

| Host | Behavior |
| --- | --- |
| `suplex.sh` | The origin. |
| `www.suplex.sh` | 301 to `BILLING_PUBLIC_ORIGIN` with the same path and query. |

The site serves `/download`, `/install.sh`, `/terms`, `/privacy`, and a 302 to
`https://getsuplex.ai/` for every other path, as the Cloudflare Worker in
`src/web/worker.js` did. Its pages are compiled into the binary: `/install.sh`
is `include_str!` of `src/web/public/install.sh` (`text/plain`,
`max-age=300`), and `/terms` and `/privacy` are placeholders until the Terms of
Service and Privacy Policy pages land.

### Login

Login works like the OAuth device flow, with a PKCE verifier:

1. The host makes a random verifier and sends only
   `challenge = base64url(sha256(verifier))` with its installation ID to
   `POST /v1/auth/attempts`. It receives an attempt ID.
2. The app opens `https://suplex.sh/auth/start?attempt=<id>&provider=google|github`
   in the system browser. For email, the host calls `POST /v1/auth/email`
   instead, and the person opens the link from the email.
3. The provider callback (or the magic-link form) binds the account to the
   attempt and redirects to `/auth/done`. That page opens `suplex://auth/done`
   only to bring the app to the front. The deep link carries no secret.
4. The host polls `POST /v1/auth/attempts/<id>/poll` with the verifier. The
   first poll after completion mints the account token, stores only its hash,
   deletes the attempt, and returns `{status: "complete", token, account}`.
   Every later poll returns 404.

Attempts and magic links expire after 15 minutes. A sign-up and a login
differ only in whether the account row was new: the same email is the same
account for every provider. Emails are stored in lowercase. Google must report
`email_verified`; GitHub uses the primary verified address, or else any
verified address. Without one, the login fails with `email_unverified`.

The wire types are in `rust/src/accounts/wire.rs`.

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/auth/attempts` | Body `{challenge, installationId}`. Returns `{attemptId}`. |
| `POST /v1/auth/attempts/{id}/poll` | Body `{verifier}`. `{status: "pending"}`, or `complete` once. A wrong verifier, an unknown or expired attempt, or a second completion poll is 404 `attempt_not_found` and consumes nothing. |
| `POST /v1/auth/email` | Body `{attemptId, email}`. Sends a magic link through Resend; 204. Five sends per address per hour (429 `rate_limited`). A Resend failure is 503 `email_unavailable`. |
| `POST /v1/auth/logout` | `Authorization: Bearer <token>`. Deletes the token hash. Always 204. |
| `GET /auth/start?attempt=&provider=` | 303 to Google or GitHub with a new single-use `state`. |
| `GET /auth/callback/{google,github}` | Exchanges the code, completes the attempt, 303 to `/auth/done`. |
| `GET /auth/email/verify?token=` | A one-button form. It does not consume the link, because mail scanners fetch links. |
| `POST /auth/email/verify` | Consumes the link once, completes the attempt, 303 to `/auth/done`. |
| `GET /auth/done` | Static: "You are signed in. Return to Suplex." |
| `GET /download?platform=&format=&visitor=` | 302 to the file in the live release manifest, as `src/web/worker.js` did. Unknown platform or format is 404; a missing manifest or file is 502. |

Browser routes answer failures with a page, never with JSON. Auth routes have a
64 KiB body limit and send `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`. Provider failures log only the provider name and
HTTP status.

Without the account variables, `/v1/auth/*`, `/auth/start`, `/auth/callback/*`,
and `/auth/email/verify` answer 503 `account_unavailable`. `/auth/done`,
billing, and the site keep working.

### Tables

The service creates these tables in `BILLING_DATABASE_PATH` at startup
(`rust/src/accounts/hosted/schema.sql`). Only token hashes are stored. The
account token is minted at poll time, so no plaintext token rests in SQLite.

| Table | Rows |
| --- | --- |
| `accounts` | `user_<uuid>`, unique email, optional name. |
| `account_attempts` | Challenge, installation ID, provider and OAuth state, the completed account. Swept one hour after expiry. |
| `account_magic_links` | Token hash, attempt, email, `used_at`. Deleted with their attempt. |
| `account_tokens` | Token hash, account, installation. |

### Configuration

The billing variables in [billing](billing.md#running-the-hosted-service) are
still required; `BILLING_PUBLIC_ORIGIN` is the origin of every route. The six
account variables are all-or-nothing; a partial set stops the service at
startup.

| Variable | Meaning |
| --- | --- |
| `ACCOUNT_GOOGLE_CLIENT_ID`, `ACCOUNT_GOOGLE_CLIENT_SECRET` | Google OAuth web client. |
| `ACCOUNT_GITHUB_CLIENT_ID`, `ACCOUNT_GITHUB_CLIENT_SECRET` | GitHub OAuth app. |
| `RESEND_API_KEY` | Resend API key for the sending domain. |
| `ACCOUNT_EMAIL_FROM` | Sender, for example `Suplex <login@suplex.sh>`. |

### Provider setup

- **Google**: a Google Cloud OAuth client of type Web application. Authorized
  redirect URIs: `https://suplex.sh/auth/callback/google` and
  `https://billing-sandbox.example.com/auth/callback/google`. Scopes
  `openid email profile`.
- **GitHub**: two OAuth apps, because each has one callback URL:
  `https://suplex.sh/auth/callback/github` (production) and
  `https://billing-sandbox.example.com/auth/callback/github` (sandbox).
  The service asks for `read:user user:email`.
- **Resend**: the domain `suplex.sh` with its DNS records verified, and an API
  key with sending access.

### Deploy

`mise run deploy_production` builds `Dockerfile.billing` on Fly's remote builder
and deploys this checkout to `suplex-production`, including `/terms` and
`/privacy`. It waits for Fly's deployment checks. `fly.toml` sets
`BILLING_PUBLIC_ORIGIN=https://suplex.sh`. Set the account secrets once:

```sh
fly secrets set --app suplex-production \
  ACCOUNT_GOOGLE_CLIENT_ID=... ACCOUNT_GOOGLE_CLIENT_SECRET=... \
  ACCOUNT_GITHUB_CLIENT_ID=... ACCOUNT_GITHUB_CLIENT_SECRET=... \
  RESEND_API_KEY=... ACCOUNT_EMAIL_FROM='Suplex <login@suplex.sh>'
```

Locally, `mise run billing:tunnel` and `mise run billing:dev` run the service
on `127.0.0.1:4212` behind `https://billing-sandbox.example.com`, with the
sandbox values from `scripts/billing-dev.env`.

### Ingress limits

Keep these limits in front of the service, next to the
[billing limits](billing.md#ingress-requirements):

- 30 requests per IP per hour on `POST /v1/auth/attempts`.
- 10 requests per IP per hour on `POST /v1/auth/email`.
- 120 requests per IP per minute on `POST /v1/auth/attempts/{id}/poll`.

### PostHog identity bridge

Hosted events go through the billing telemetry outbox
(`billing_telemetry_events`, with an empty `company_id`), so they are sent only
when `BILLING_TELEMETRY=true` and `BILLING_POSTHOG_KEY` are set.

- A completed login queues `account_signed_up` or `account_logged_in` with
  `distinct_id` = account ID, `$lib=suplex-hosted`, `provider`,
  `$groups.host` = installation ID, and `$set.email`.
- The Framer snippet adds the consented PostHog distinct ID as
  `?visitor=` to `suplex.sh/download` links. `/download` keeps a valid value
  (`^[A-Za-z0-9._:-]{8,64}$`) in the first-party cookie `suplex_visitor` for a
  year, unless the request sends `DNT: 1`. When the login callback sees that
  cookie, it also queues `$identify` with
  `$anon_distinct_id` = visitor, which joins the website visitor to the account.
- `/download` queues an anonymous `download_started` (`$lib=suplex-web`,
  `platform`, `source`) with a new random ID, unless the request sends `DNT: 1`.

### Residual risk

Whoever holds a live attempt ID can complete that attempt with their own
provider account, and the host then links that account. The ID is 128 random
bits, appears only in the URL the app opened, is single-use, and expires in 15
minutes. The app shows "Logged in as <email>" so a wrong account is visible.

## Private host

The host links one account per installation. `SUPLEX_ACCOUNT_SERVICE_URL`
selects the service: installations default to `https://suplex.sh`, development
roots default to none, and an empty value turns accounts off. Without a service
the app never asks for a login.

- **Gate.** Application pages (`/`, `/today`, `/profile`, company settings, and
  the other app views) show the login view (`window.__SUPLEX_VIEW__ =
  "account-login"`) after the passkey session check and until the
  `suplex_account` row exists. The gate reads only that row. `/auth`,
  `/oauth/consent`, `/health`, the API, MCP, and agents are not gated.
- **Login.** `POST /api/account/login` (administrator, same origin) creates a
  random 32-byte verifier, sends only its S256 challenge to
  `POST /v1/auth/attempts`, and returns the attempt and, for Google and GitHub,
  the `suplex.sh/auth/start` URL. For email it calls `POST /v1/auth/email` and
  returns no URL. The verifier stays in host memory for 15 minutes; a restart
  means the person retries.
- **Completion.** The login view polls `GET /api/account/login/{attemptId}`
  every 2 seconds. The host polls `POST /v1/auth/attempts/{id}/poll` with the
  verifier. `complete` writes `suplex_account` (account ID, email, name, token)
  and records the audit action `account_linked`. An unknown or used attempt is
  `expired`. A payload that does not match the wire contract fails closed.
- **Logout.** `POST /api/account/logout` (administrator) deletes the row first,
  records `account_unlinked`, then calls `POST /v1/auth/logout` best effort.
- **Read.** `GET /api/account` returns `configured`, `canManage`, and the linked
  email. Profile shows **Logged in as** with **Log out**.
- **Telemetry.** The host keys PostHog events by the account ID once linked and
  sends one `$identify` that merges the installation person. See
  [telemetry](telemetry.md#identity).
- **Desktop.** The app registers `suplex://`. `suplex://auth/done` only brings
  the window to the front; the app never reads the URL.

## Setup checklist

These steps need a person with access to Cloudflare, Fly, Google Cloud,
GitHub, Resend, Stripe, RevenueCat, 1Password, and Framer.

1. Deploy with `mise run deploy_production` before setting account secrets, and do steps 2 and
   3 right after it: Checkout and portal return URLs now point at `suplex.sh`.
   Through `https://suplex-production.fly.dev`, check that `/health`
   answers, `/auth/start` answers 503 `account_unavailable`, and `/install.sh`
   returns the script.
2. In Cloudflare, remove the `suplex.sh` and `www.suplex.sh` custom domains from
   the `suplex-web` Worker, and disconnect its CI/CD from this repository.
3. Run `mise run billing:dns`. It points `suplex.sh` and `www.suplex.sh` at
   the Fly app, adds missing Fly certificates, and checks
   them. Then check `curl -I https://suplex.sh/install.sh`,
   `curl -I 'https://suplex.sh/download?platform=macos-arm64'`, and
   `curl -I https://www.suplex.sh/terms`.
4. Change the Stripe webhook destination to `https://suplex.sh/webhooks/stripe`
   and the RevenueCat webhook to `https://suplex.sh/webhooks/revenuecat`.
5. To keep `download_started`, set `BILLING_TELEMETRY=true` and
   `BILLING_POSTHOG_KEY` as Fly secrets, if they are not set.
6. Create the Google OAuth client, the two GitHub OAuth apps, and the Resend
   domain and API key as described in Provider setup.
7. Store the six account values in the Suplex 1Password vault: production
   values for Fly, and sandbox values as fields of the `.env.development` item
   that `scripts/billing-dev.env` reads. `mise run billing:dev` fails until the
   sandbox fields exist.
8. Run the `fly secrets set` command in Deploy. Fly restarts the machine.
9. Paste the updated `integrations/posthog/framer-attribution.js` into Framer.
   In a private browser, check that a download link gets `?visitor=` only
   after you accept analytics.
10. Move `install.sh`, `terms.html`, and `privacy.html` under
    `rust/src/hosted`, point the `include_str!` calls in `site.rs` at them, and
    delete `src/web` (the Worker, `wrangler.jsonc`, and its package files).
    Disconnect the Worker's Cloudflare CI if step 2 did not, and archive the
    `meiji-industries/suplex-web` repository.
