# Suplex accounts

A Suplex account is a hosted identity at `https://suplex.sh`. People log in
with Google, GitHub, or an emailed link. A Suplex installation links one owner account. Remote members log in with
their own accounts and receive access through company invitations.

## Hosted service

`suplex hosted serve` (`apps/server/src/hosted/`) is one process on the Fly app
`suplex-production` at `https://suplex.sh`. It serves billing
([billing](billing.md)), accounts (`apps/server/src/accounts/hosted/`), and the
suplex.sh site (`apps/server/src/hosted/site.rs`) from one router. Every absolute URL
it builds (Stripe return pages, OAuth callbacks, magic links) uses
`BILLING_PUBLIC_ORIGIN`.

| Host | Behavior |
| --- | --- |
| `suplex.sh` | The origin. |
| `www.suplex.sh` | 301 to `BILLING_PUBLIC_ORIGIN` with the same path and query. |

The site serves `/download`, `/install.sh`, `/install.ps1`, `/bootstrap.sh`, `/terms`,
`/privacy`, `/support`, and a 302 to `https://getsuplex.ai/` for every other
path. Its pages are compiled into the binary from `apps/server/src/hosted`:
the three scripts are `include_str!` of `install.sh`, `install.ps1`, and
`bootstrap.sh` (`text/plain`, `max-age=300`), and the other pages come from
`legal/`. `bootstrap.sh` installs `suplex-bootstrap` from
`/download?platform=bootstrap-<macos|linux>-<arm64|x64>`; see
[apps/bootstrap](../apps/bootstrap/README.md).

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

The wire types are in `apps/server/src/accounts/wire.rs`.

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/auth/attempts` | Body `{challenge, installationId}`. Returns `{attemptId}`. |
| `POST /v1/auth/attempts/{id}/poll` | Body `{verifier}`. `{status: "pending"}`, or `complete` once. A wrong verifier, an unknown or expired attempt, or a second completion poll is 404 `attempt_not_found` and consumes nothing. |
| `POST /v1/auth/email` | Body `{attemptId, email}`. Sends a magic link through Resend; 204. Five sends per address per hour (429 `rate_limited`). A Resend failure is 503 `email_unavailable`. |
| `POST /v1/auth/logout` | `Authorization: Bearer <token>`. Deletes the token hash. Always 204. |
| `GET /v1/account/email-updates` | `Authorization: Bearer <token>`. Returns `{subscribed}`, the account's latest product update email choice. An account with no choice is not subscribed. |
| `PUT /v1/account/email-updates` | `Authorization: Bearer <token>`. Body `{subscribed, source, wording}`. `source` is `onboarding` or `settings`; `email` is refused. `wording` is the text the person saw. Adds one row, queues the Resend contact change, and returns `{subscribed}`. A Resend failure does not change the response. |
| `POST /webhooks/resend` | Resend webhook, signed with Svix. Records unsubscribes from the unsubscribe link in an email. 401 for a bad or stale signature, 503 without `RESEND_WEBHOOK_SECRET`. See [Product update emails](#product-update-emails). |
| `GET /auth/start?attempt=&provider=` | 303 to Google or GitHub with a new single-use `state`. |
| `GET /auth/callback/{google,github}` | Exchanges the code, completes the attempt, 303 to `/auth/done`. |
| `GET /auth/email/verify?token=` | A one-button form. It does not consume the link, because mail scanners fetch links. |
| `POST /auth/email/verify` | Consumes the link once, completes the attempt, 303 to `/auth/done`. |
| `GET /auth/done` | Static: "You are signed in. Return to Suplex." |
| `GET /account/delete` | Account deletion, linked from Settings > Profile (App Store guideline 5.1.1(v)). The person logs in with an attempt for the installation `suplex.sh-delete`; the callback goes to `GET /account/delete/confirm?attempt=`, and `POST` there deletes the account, its tokens and attempts, and the invitations it sent. Billing records stay. A subscription that renews must be cancelled first; if Suplex cannot read the subscription, the page asks for a retry. |
| `GET /download?platform=&format=&visitor=` | 302 to the file in the live release manifest. Unknown platform or format is 404; a missing manifest or file is 502. |

Browser routes answer failures with a page, never with JSON. Auth routes have a
64 KiB body limit and send `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`. Provider failures log only the provider name and
HTTP status.

Without the account variables, `/v1/auth/*`, `/auth/start`, `/auth/callback/*`,
and `/auth/email/verify` answer 503 `account_unavailable`. `/auth/done`,
billing, and the site keep working.

### Tables

The service creates these tables in `BILLING_DATABASE_PATH` at startup
(`apps/server/src/accounts/hosted/schema.sql`). Only token hashes are stored. The
account token is minted at poll time, so no plaintext token rests in SQLite.

| Table | Rows |
| --- | --- |
| `accounts` | `user_<uuid>`, unique email, optional name. |
| `account_attempts` | Challenge, installation ID, provider and OAuth state, the completed account. Swept one hour after expiry. |
| `account_magic_links` | Token hash, attempt, email, `used_at`. Deleted with their attempt. |
| `account_tokens` | Token hash, account, installation. |
| `company_invitations` | Invitation hash, owner account, company, recipient, host address, expiry, and delivery time. |
| `account_email_updates` | Each product update email choice: account, subscribed or not, source (`onboarding`, `settings`, or `email`), the wording shown, and time. Rows are never edited; the latest row per account is its current choice. Deleted with the account. |
| `account_resend_outbox` | Resend contact changes, events, and contact deletions to send, by email. Retried with backoff and never dropped. Keeps the latest sent contact change per email; a sent deletion removes every row for its email. Not deleted with the account. |

At startup the service also upgrades an older `account_email_updates` table to
accept the `email` source. It rebuilds the table and keeps every row and ID.

### Product update emails

Promotional email needs a separate, explicit opt-in (see the privacy policy). The
"Let's set you up" onboarding step shows an unchecked checkbox, and Settings >
Profile shows a Product update emails switch. Both appear only for the person
whose Suplex account is linked to the host. Each change goes to
`PUT /v1/account/email-updates` with the exact wording of the control the
person used: the checkbox text from onboarding, or the switch label and
description from Settings. suplex.sh keeps this as proof of when and how each
person opted in or out.

`account_email_updates` is the record of consent. suplex.sh keeps Resend
contacts in step with it (`apps/server/src/accounts/hosted/resend.rs`):

- Each choice queues a contact change in `account_resend_outbox`, in the same
  transaction as the choice. A subscribe sends `PATCH /contacts/{email}` with
  `unsubscribed: false` and the first word of the account name as
  `first_name`; if Resend has no such contact, it sends `POST /contacts`. An
  unsubscribe sends `unsubscribed: true`; a missing contact counts as done.
  A person who never subscribed is not sent to Resend.
- A change from not subscribed to subscribed also sends the event
  `email_updates.subscribed` (`POST /events/send`) with the payload
  `{source}`, after the contact change. A second subscribe sends no event.
- The service sends the queue right after each choice and every 30 seconds.
  Changes for one email go in order. A failure waits 30 seconds, 2 minutes,
  10 minutes, then one hour between tries, and blocks the later changes for
  that email. Nothing is dropped. A Resend failure never fails or changes the
  `PUT` response.
- Account deletion queues `DELETE /contacts/{email}` and drops unsent changes.
  The queued row is keyed by email, so it is sent after the account row is
  gone.
- The unsubscribe link in an email (`{{{RESEND_UNSUBSCRIBE_URL}}}`) changes the
  contact in Resend. Resend sends `contact.updated` to `POST /webhooks/resend`.
  When `data.unsubscribed` is true, the account with that email has a
  subscribed latest choice, and `data.updated_at` is not earlier than that
  choice, the service adds a row with source `email` and the wording
  "Unsubscribed with the link in a Suplex email." Settings > Profile then shows
  the switch off. The row is not sent back to Resend, and unsent subscribe
  changes for the email become unsubscribes. The service also ignores the
  event when it is older than the last contact change it sent, or when the
  last change it sent was an unsubscribe: that event is the echo of its own
  change. A webhook never records an opt-in. Other events, unknown addresses,
  and repeats answer 200 and change nothing.
- The webhook verifies the Svix signature over the raw body: HMAC-SHA256,
  keyed with the base64 part of the `whsec_` secret, of
  `{svix-id}.{svix-timestamp}.{body}`, compared with each `v1,<signature>` in
  `svix-signature`. A timestamp more than 5 minutes from the service clock is
  refused.

Choices made before the sync shipped are not sent automatically. To import the
current subscribers, run this on the hosted machine and import the file into
Resend contacts once:

```sh
suplex hosted email-updates > subscribers.csv
```

`BILLING_DATABASE_PATH` must name the existing service database; the command
fails instead of creating an empty one. It prints
`email,name,subscribed_at,source,wording` for each account whose
latest choice is subscribed. Import only these people, and do not import them
again later: from then on the sync keeps the contacts up to date.

The transactional template `suplex-base` (sign-in and invitation email) is
separate from product update emails and is not affected by a contact's
`unsubscribed` value.

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
| `RESEND_WEBHOOK_SECRET` | Optional. The signing secret (`whsec_...`) of the Resend webhook. Without it `POST /webhooks/resend` answers 503 and unsubscribes made in email do not come back to suplex.sh. A value that is not a `whsec_` secret stops the service at startup. |
| `ACCOUNT_REVIEW_EMAIL` | Optional. An email login for this address completes at once and sends no email, so App Review can log in. Use an unguessable address such as `review-<random>@suplex.sh`, keep it in 1Password, and give it only to App Review. It works on `/account/delete` too. |

### Provider setup

- **Google**: a Google Cloud OAuth client of type Web application. Authorized
  redirect URIs: `https://suplex.sh/auth/callback/google` and
  `https://billing-sandbox.example.com/auth/callback/google`. Scopes
  `openid email profile`.
- **GitHub**: two OAuth apps, because each has one callback URL:
  `https://suplex.sh/auth/callback/github` (production) and
  `https://billing-sandbox.example.com/auth/callback/github` (sandbox).
  The service asks for `read:user user:email`.
- **Resend**: the domain `suplex.sh` with its DNS records verified, an API
  key with sending access, and the published template `suplex-base`. Every
  email renders through it with the variables `HEADING`, `BODY`,
  `ACTION_LABEL`, `ACTION_URL`, and `NOTE`. Edit its design and plain text
  version in the Resend dashboard; publish to change sent email. The API key
  also needs access to contacts and events for the product update email sync.
- **Resend product update emails**, in the Resend dashboard:
  1. Webhooks: add `https://suplex.sh/webhooks/resend` with the event
     `contact.updated`. Copy its signing secret to `RESEND_WEBHOOK_SECRET`.
  2. Events: define the event `email_updates.subscribed`. Its payload has
     `source` (`onboarding` or `settings`).
  3. Automations: trigger on `email_updates.subscribed`. Directly after the
     trigger, add the condition `contact.unsubscribed eq false`, so a person
     who unsubscribed before the email goes out gets nothing.
  4. Every Automation and broadcast template must include
     `{{{RESEND_UNSUBSCRIBE_URL}}}`. That link is how a person unsubscribes in
     email, and the webhook brings the choice back to suplex.sh.
  5. Test with a throwaway address: subscribe in Settings > Profile, check the
     contact and the Automation run in Resend, open the unsubscribe link, and
     check that the switch in Settings > Profile is off.

### Deploy

`mise run hosted:deploy` builds `apps/server/Dockerfile` on Fly's remote builder
and deploys this checkout to `suplex-production`, including `/terms` and
`/privacy`. It waits for Fly's deployment checks. `fly.toml` sets
`BILLING_PUBLIC_ORIGIN=https://suplex.sh`. Set the account secrets once:

```sh
fly secrets set --app suplex-production \
  ACCOUNT_GOOGLE_CLIENT_ID=... ACCOUNT_GOOGLE_CLIENT_SECRET=... \
  ACCOUNT_GITHUB_CLIENT_ID=... ACCOUNT_GITHUB_CLIENT_SECRET=... \
  RESEND_API_KEY=... ACCOUNT_EMAIL_FROM='Suplex <login@suplex.sh>' \
  RESEND_WEBHOOK_SECRET=whsec_...
```

Locally, `mise run hosted:tunnel` and `mise run hosted:dev` run the service
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

- **Local owner.** Loopback HTTP requests keep owner mode. When accounts are
  configured, application pages require the installation's linked account.
- **Remote members.** All remote requests require HTTPS. Tailscale Serve or a
  loopback HTTPS proxy supplies the verified origin. Remote browser sessions
  require a hosted account login and current company membership. Old automatic
  sessions do not grant remote access.
- **Login.** `POST /api/account/login` creates a verifier and sends its challenge
  to the hosted service. A separate HttpOnly cookie binds the attempt to the
  browser. Polling requires that cookie and the same local/remote context.
  Local completion links the owner. Remote completion matches the verified
  account email to a sent, live invitation, then issues a secure host session.
  It never replaces the owner link or shares the owner's account token.
- **Logout.** Local logout removes the owner link before best-effort token
  revocation. Remote logout revokes only that browser's session.
- **Invitations.** Company > Users contains Add User (full name and email),
  pending invitations, and company membership removal. The host checks the
  company and reserves membership. The hosted
  service sends the Resend email with a stable idempotency key. Failed delivery
  remains retryable. The seven-day invitation page offers download, app, and
  browser links; opening it does not grant access. Recipients must log in with
  the invited email and connect to the company host over Tailscale or LAN.
  Company data and membership remain on that host; suplex.sh does not relay
  multiplayer traffic. Removing membership also revokes its invitations.
- **Desktop.** `suplex://auth/done` focuses the app. `suplex://join?url=...`
  opens the invited HTTPS host. Credentials and fragments are rejected.
- **Availability.** Existing sessions use current local membership, so hosted
  service downtime does not block ongoing work. New logins and invitation
  emails require the hosted service.

### Member access

Each membership has an access level, `edit` or `read`
(`suplex_memberships.access`). A read-only member sees the company's work but
cannot change it: every write path calls `companies::require_company_edit`,
which returns 403 `company_read_only`. Admins always edit.

Choosing which companies a member sees, and making a member read-only, are
Team features (`team_required` on Free and Pro). On Free and Pro an invitation
and a new company include every member, and removing a user revokes the
account. When a confirmed Team plan lapses, everyone, admins too, is read-only
(403 `team_lapsed`) until someone selects Team again; scoping stays enforced, so
a lapse never widens access. Administrators can still manage billing and users.
External agents keep their own grants. When Pro ends, the host is Free and
nothing becomes read-only ([downgrades](billing.md#downgrades)).

In the web app, a banner under the header says why work is read-only: "Team
ended", with Select Team for an administrator, or "You can read work in …" for
a read-only member. Settings > Users marks read-only members and offers Make
read-only or Allow edits. `/api/companies` returns each company's `access` and
`teamLapsed`; `PATCH /api/admin/companies/{companyId}/members/{userId}` with
`{access}` changes it.

## Setup checklist

These steps need a person with access to Cloudflare, Fly, Google Cloud,
GitHub, Resend, Stripe, RevenueCat, 1Password, and Framer.

1. Deploy with `mise run hosted:deploy` before setting account secrets, and do step 2
   right after it: Checkout and portal return URLs now point at `suplex.sh`.
   Through `https://suplex-production.fly.dev`, check that `/health`
   answers, `/auth/start` answers 503 `account_unavailable`, and `/install.sh`
   returns the script.
2. Run `mise run hosted:dns`. It points `suplex.sh` and `www.suplex.sh` at
   the Fly app, adds missing Fly certificates, and checks
   them. Then check `curl -I https://suplex.sh/install.sh`,
   `curl -I 'https://suplex.sh/download?platform=macos-arm64'`, and
   `curl -I https://www.suplex.sh/terms`.
3. Change the Stripe webhook destination to `https://suplex.sh/webhooks/stripe`
   and the RevenueCat webhook to `https://suplex.sh/webhooks/revenuecat`.
4. To keep `download_started`, set `BILLING_TELEMETRY=true` and
   `BILLING_POSTHOG_KEY` as Fly secrets, if they are not set.
5. Create the Google OAuth client, the two GitHub OAuth apps, and the Resend
   domain and API key as described in Provider setup. Do the Resend product
   update email steps too: the webhook, the event, and the Automation with its
   `contact.unsubscribed eq false` condition.
6. Store the six account values and `RESEND_WEBHOOK_SECRET` in the Suplex
   1Password vault: production values for Fly, and sandbox values as fields of the `.env.development` item
   that `scripts/billing-dev.env` reads. Until the sandbox fields exist,
   `mise run hosted:dev` runs with sign-in off.
7. Run the `fly secrets set` command in Deploy. Fly restarts the machine.
8. Paste the updated `apps/server/src/hosted/framer-attribution.js` into Framer.
   In a private browser, check that a download link gets `?visitor=` only
   after you accept analytics.
9. Import the people who subscribed before the Resend sync shipped, once:
   `suplex hosted email-updates > subscribers.csv`, then import the file into
   Resend contacts. Test the sync with a throwaway address as described in
   Provider setup.
