# Billing

Suplex Free and Pro match the plans on <https://getsuplex.ai/>. Each
installation has one plan: the plan of the Suplex account linked to it
([accounts](accounts.md)). A host without a linked account is Free.

| Limit | Free | Pro |
| --- | --- | --- |
| Companies that are not archived | 1 | 3 |
| Projects in all companies | 1 | 10 |
| Tasks running at once (`active` or `waiting_human`) | 3 | Unlimited |
| Tasks created each UTC calendar month, archived ones too | 50 | Unlimited |

Pro costs USD 20 each month before tax for one seat. Each Suplex account gets
one 30-day Pro trial with no payment method. Without a payment method at the
trial end, Stripe cancels the subscription and the host returns to Free. The
Team plan (seats, centralized billing) is not implemented.

`FREE` and `PRO` in `rust/src/billing/mod.rs` hold the limits.
`billing::require` decides each limit inside the transaction that writes:
company creation and restore, project creation, task creation (every path:
browser, agent API, MCP, GitHub triggers, moves), and Start anyway. Queue
admission applies the running-task limit in the same SQL statement as the
project task concurrency, so a fourth Free task waits in the queue with
`queue.planConcurrencyLimited` and starts when a running task stops. A host
over a limit after a downgrade keeps everything it has; only new work stops.

`suplex_plan` remembers the last plan suplex.sh confirmed for the linked
account: its account ID and the end of its paid access. Pro applies while that
access has not ended and the same account is linked. Suplex reads the plan
again:

- before a Free limit refuses an action (`billing::observe`), so a purchase
  made on another device applies at once;
- on every visit to Settings > Billing, after a login, and every 15 minutes.

A hosted outage keeps confirmed Pro until its paid access ends. It never
grants or extends Pro. A confirmed lapse replaces the snapshot with Free.

Members and administrators read the plan in Settings > Billing. Only active
administrators can start the trial, select Pro, or open the billing portal,
and only when a Suplex account is linked.

## Start free and Start 30-day trial

The website buttons link to `https://suplex.sh/start` (Start free) and
`https://suplex.sh/start?plan=pro` (Start 30-day trial), implemented in
`rust/src/accounts/hosted/start.rs`.

- `/start` shows the Free limits and the downloads.
- `/start?plan=pro` creates a login attempt for the installation `suplex.sh`
  and offers Google, GitHub, and an emailed link. The callback goes to
  `/start/done?attempt=…`, which starts that account's trial and shows the
  downloads with "log in with <email>". The attempt's verifier is discarded,
  so no account token is minted. A repeated visit shows the same trial; an
  account that used its trial sees that, and a Stripe failure still shows the
  downloads and points to Settings > Billing.
- After the person installs Suplex and logs in with the same account, the host
  reads the plan and Pro applies.

The Framer snippet tracks these links as `start-free` and `start-trial`
website CTAs and adds the consented `?visitor=` to them, as for downloads.

Installations from v1.3.0 bought Pro per company with seats
(`suplex_company_billing`). Current hosts no longer read those bindings; the
table and the hosted credential API remain so those subscriptions stay
manageable in Stripe.

## Architecture

Billing runs as two processes:

1. The private Suplex application (`suplex`, `rust/src/billing/mod.rs`). It
   counts projects and accounts, authorizes the operator, enforces project
   policy, and calls the billing service over outbound HTTPS. It holds no
   merchant credentials.
2. The Suplex-operated public billing service (`rust/src/billing/hosted/`),
   part of `suplex hosted serve` at `https://suplex.sh` on Fly with
   [accounts](accounts.md) and the suplex.sh site. It owns Stripe and RevenueCat credentials,
   company billing accounts, Checkout and Portal creation, provider reads, and
   webhooks. It never runs the Suplex server, task hosts, or native runtimes.

Both processes are the same `suplex` binary and share one wire contract,
`rust/src/billing/wire.rs`. Installations never hold the service's provider
secrets, so the billing code they carry is inert there.

Stripe owns monetary and quantity facts. RevenueCat supplies the imported `pro`
entitlement and consolidated lifecycle. Suplex never treats a webhook payload, a
local row, or a return-page visit as proof of payment; it reads the source.

Paid access derives from settled service-period invoice evidence on the
configured seat item — not from the subscription status string. An `active`
subscription whose current invoice is unpaid does not grant Pro; a verified
zero-amount invoice settled by credit does. A `trialing` subscription is covered
by Stripe's settled $0 invoice for the trial period. A full refund of the current paid
period revokes it; a partial refund or a refund of an older period does not.
An unpaid renewal preserves the previous paid deadline without extending it.
RevenueCat grace may extend access only for renewal-failure states on the same
product and account, and never overrides a current cancellation, expiry, or
full refund. If required Stripe evidence cannot be read, the service answers
`billing_unavailable` rather than guessing.

## Running the hosted service

```sh
# Any build of the suplex binary; listens on 127.0.0.1:4211 by default
suplex hosted serve
```

### Local sandbox

The Stripe sandbox and the RevenueCat project send webhooks to
`https://billing-sandbox.example.com`, a named Cloudflare Tunnel to
`127.0.0.1:4212`. Run the tunnel, the service, and Suplex in three terminals:

```sh
mise run billing:tunnel
mise run billing:dev     # sandbox secrets from 1Password .env.development
SUPLEX_BILLING_SERVICE_URL=http://127.0.0.1:4212 mise run dev
```

Both billing tasks read 1Password through the Suplex service account. The
sandbox has no head office address, so `billing:dev` sets
`STRIPE_AUTOMATIC_TAX=false`. Pay with Stripe test cards such as
`4242 4242 4242 4242`.

Production targets the Fly app `suplex-production` (`fly.toml` and
`Dockerfile` at the repository root). The configuration uses one machine
in `yyz` and a `billing_data` volume mounted at `/data`. The public origin is
`suplex.sh`; `www.suplex.sh` redirects to the origin. There is no legacy billing
hostname. `mise run billing:dns` points both hostnames at Fly. `fly.toml` sets
the non-secret variables. Set the provider secrets once, then deploy:

```sh
fly secrets set --app suplex-production STRIPE_SECRET_KEY=... \
  STRIPE_PRO_MONTHLY_PRICE_ID=... STRIPE_PORTAL_CONFIGURATION_ID=... \
  STRIPE_WEBHOOK_SECRET=... REVENUECAT_SECRET_API_KEY=... \
  REVENUECAT_STRIPE_PUBLIC_API_KEY=... REVENUECAT_WEBHOOK_AUTHORIZATION=... \
  REVENUECAT_APP_ID=...
mise run deploy_production
```

The service refuses to start until every variable is set. Keep one machine:
the database is SQLite on the volume.

The service creates its tables in `BILLING_DATABASE_PATH` at startup. They are
not part of the Suplex application migrations.

Configuration is read only in the hosted process:

| Variable | Meaning |
| --- | --- |
| `BILLING_PUBLIC_ORIGIN` | Public HTTPS origin of the hosted service: Checkout/Portal return pages, OAuth callbacks, magic links, and the `www.` redirect. `https://suplex.sh` in production. Only loopback hosts may use HTTP. |
| `BILLING_BIND_ADDRESS` | Listener address. Default `127.0.0.1`. |
| `BILLING_PORT` | Listener port. Default `4211`. |
| `BILLING_DATABASE_PATH` | Persistent SQLite path. Must not be a Suplex installation database. |
| `BILLING_ENVIRONMENT` | Exactly `sandbox` or `production`. Must match the Stripe key mode and the RevenueCat project. |
| `STRIPE_SECRET_KEY` | Merchant API secret for the matching environment. |
| `STRIPE_PRO_MONTHLY_PRICE_ID` | The configured USD 20 monthly licensed seat price. |
| `STRIPE_PORTAL_CONFIGURATION_ID` | The dedicated Suplex portal configuration. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the Suplex Stripe webhook destination. |
| `STRIPE_AUTOMATIC_TAX` | `true` (default) or `false`. Stripe Tax on Checkout needs a head office address in the Stripe account. |
| `REVENUECAT_SECRET_API_KEY` | Server-side key for subscriber reads. |
| `REVENUECAT_STRIPE_PUBLIC_API_KEY` | The Stripe app's public key, used for receipt imports. |
| `REVENUECAT_WEBHOOK_AUTHORIZATION` | The exact Authorization header value RevenueCat sends to Suplex. |
| `REVENUECAT_APP_ID` | The RevenueCat app/config identity allowlisted for events. |

Installations use `https://suplex.sh` by default. Set
`SUPLEX_BILLING_SERVICE_URL` to use another HTTPS origin, or a loopback URL for
development. Development roots (`SUPLEX_ROOT`) have no default, so development
data never registers production accounts. An empty value turns billing off:
the installation runs Free, a third project in a company returns 402
`project_limit_reached`, and existing projects are never touched. A company
with an existing billing binding reports the subscription as unknown, never as
Free.

The service verifies the configured price before it serves purchase mutations:
`usd`, `unit_amount` 2000, monthly interval count 1, `licensed` usage,
`per_unit` billing, no quantity transformation, and a key mode matching
`BILLING_ENVIRONMENT`. A mismatch returns `billing_setup_invalid`; it never
sells an arbitrary price.

## Ingress requirements

Put the hosted service behind HTTPS ingress with these limits:

- 1 MiB maximum request body.
- 10 registration attempts per IP per hour on `POST /v1/accounts`.
- 120 non-webhook requests per IP per minute.
- Webhook destinations have independent limits and their own authentication
  (Stripe signature over the raw body; RevenueCat authorization header).

## Provider setup

Use a dedicated Stripe sandbox and a dedicated RevenueCat test project first.
Production uses a separate Stripe configuration and RevenueCat project with
`BILLING_ENVIRONMENT=production`.

1. Connect Stripe to RevenueCat as the RevenueCat project owner.
2. Create the Stripe product `Suplex Pro` with a USD 20.00 monthly per-unit
   licensed price (tax-exclusive). Enable Stripe Tax for production Checkout
   and configure the merchant's tax settings before activation.
3. Import the product into the RevenueCat Stripe configuration and attach the
   price to the entitlement identifier `pro`. Use the same identifier in the
   sandbox and production projects.
4. Configure external purchase recognition to wait until the invoice is paid.
   Enable tracking new purchases with the App User ID from the `app_user_id`
   metadata key. Keep purchases bound to their original account; disable
   customer-facing restore and transfer flows.
5. Configure Stripe's notification destination for RevenueCat with only the
   documented event list: `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `checkout.session.completed`, `charge.refunded`, and `invoice.updated`.
   That destination's signing secret belongs to RevenueCat, not to Suplex.
   The service imports each subscription into RevenueCat itself, so purchases
   work without this destination. Without it, RevenueCat learns about a
   cancellation or refund made outside Suplex only at the next import, so its
   dashboard lags Stripe. Suplex reads Stripe, so access is still correct.
6. Create the separate Suplex Stripe webhook destination for
   `checkout.session.completed`, `checkout.session.expired`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`,
   `invoice.payment_action_required`, and `charge.refunded`, pointed at
   `POST {origin}/webhooks/stripe`. Its signing secret is
   `STRIPE_WEBHOOK_SECRET`.
7. Configure RevenueCat to send this project's events to
   `POST {origin}/webhooks/revenuecat` with the configured authorization
   header. RevenueCat reports sandbox transactions with environment `SANDBOX`
   and production with `PRODUCTION`; the service validates this against
   `BILLING_ENVIRONMENT`, just as it validates Stripe `livemode`, so events
   from the wrong environment never enter reconciliation.
8. Configure the Stripe customer portal for payment methods, invoices,
   billing details, cancellation at period end, and resuming a scheduled
   cancellation. Disable product switching, quantity updates, trials, coupons,
   and retention discounts there. Seat changes go through Suplex.
9. Configure Stripe payment retries and customer emails in Stripe. Suplex does
   not run dunning or send payment email.

## Hosted API

`/v1/plan*` authenticates the Suplex account token the host received at login.
Each Suplex account has one billing account whose registration ID is the
account ID. The older routes authenticate each v1.3.0 company with a bearer
credential created at registration. Only SHA-256 hashes are stored.

| Endpoint | Behavior |
| --- | --- |
| `GET /v1/plan` | Bearer Suplex account token. The account's `{state, trialAvailable}`. |
| `POST /v1/plan/trial` | Bearer Suplex account token. Start the account's one 30-day trial, or return the current plan. 409 `trial_used` after a trial. |
| `POST /v1/plan/checkout` | Bearer Suplex account token plus `Idempotency-Key`. Checkout for one Pro seat. |
| `POST /v1/plan/portal` | Bearer Suplex account token. A portal session for the account's customer. |
| `POST /v1/accounts` | Register or recover the credential-bound empty account (v1.3.0 per-company billing). |
| `GET /v1/billing` | Read the current provider state for the caller's account. |
| `POST /v1/checkout` | Body `{quantity}` plus `Idempotency-Key`; create or reuse a Checkout session, or return the existing subscription's recovery action. |
| `POST /v1/seats/preview` | Body `{quantity}`; return the exact Stripe invoice preview for an increase, including the proration timestamp the charge must reuse. |
| `POST /v1/seats` | `{quantity, previewId}` for an increase or `{quantity, confirmNoRefund:true}` for a decrease, plus `Idempotency-Key`. The confirmed command is persisted before any provider call; retries replay the exact recorded request and settle from fresh provider reads. |
| `POST /v1/portal` | Create a short-lived portal session for this account's customer. |
| `POST /webhooks/stripe` | Signature-verified durable event ingestion. |
| `POST /webhooks/revenuecat` | Authorization-header-verified durable event ingestion. |
| `GET /checkout/return`, `GET /checkout/cancel`, `GET /portal/return` | Non-sensitive return pages. |
| `GET /health` | Liveness without account or secret data. |

Accepted webhook work is persisted before the service responds. A durable
processor drains due events and RevenueCat import repairs at startup and every
30 seconds, retrying after 30 seconds, 2 minutes, 10 minutes, then hourly, and
removes completed records after 30 days.

Seat changes and checkout attempts recover from provider evidence, never from
cached responses. An increase applies through a Stripe pending update: its
invoice open means `payment_required` with the old capacity preserved; voided
or expired without applying means HTTP 409 `billing_operation_not_applied` and
the client must confirm a fresh preview. An expired checkout session ends the
same way; a verified open session is resumed rather than recreated. A quote
that no longer matches the confirmed amount returns 409
`billing_quote_changed` with a new preview.

## Credential rotation

Losing the local credential loses billing authority. Rotate it only after
verifying ownership through the existing Stripe customer record:

```sh
NEW_BILLING_CREDENTIAL=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=') \
STRIPE_SECRET_KEY=sk_... \
suplex billing rotate-credential \
  --db /data/billing.sqlite \
  --account <accountId>
```

On Fly, run the command inside the machine with `fly ssh console`, where
`STRIPE_SECRET_KEY` is already set. The command confirms the account's stored Stripe customer still correlates to
the account, stores only the new credential's hash, and retains the billing
account and subscription. Supply the new credential through a protected
environment variable or secret store, never on the command line or in logs.
Then update the `credential` column of `suplex_company_billing` for the company
in the private installation database to the same new credential.

There is no public recovery by email or customer ID.

## Backup, restore, and rollback

Back up the private `suplex_company_billing` row together with the hosted
billing database. Restoring a database preserves the account binding; the
process `instanceId` is unrelated to billing identity.

Factory reset replaces the private database, so it deletes the company's
billing credential. It does not cancel the subscription. To keep billing
authority, restore the credential from a backup or rotate it as described
above.

Rollback of application code never deletes billing rows and never cancels
subscriptions. Keep the hosted service and the Stripe portal reachable so
customers retain a working cancellation path.

## Availability

When the billing service or providers cannot be read, existing projects,
tasks, workflows, and delivery continue; Free operations within the allowance
continue. During an outage, creation beyond the Free allowance uses the last
confirmed Pro snapshot (its purchased seats) until its paid access ends. A
confirmed lapse replaces the snapshot with Free. With no unexpired Pro
snapshot, creation beyond the Free allowance returns `billing_unavailable`
until Suplex can verify the subscription.
