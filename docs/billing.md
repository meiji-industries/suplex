# Billing

Suplex Free, Pro, and Team match the plans on <https://getsuplex.ai/>. Each
installation has one plan: the plan of the Suplex account linked to it
([accounts](accounts.md)). A host without a linked account is Free.

| Limit | Free | Pro | Team |
| --- | --- | --- | --- |
| Companies that are not archived | 1 | 3 | Unlimited |
| Projects in all companies | 2 | 25 | Unlimited |
| Tasks running at once (`active` or `waiting_human`) | 3 | Unlimited | Unlimited |
| Tasks created each UTC calendar month, archived ones too | 50 | Unlimited | Unlimited |

Pro costs USD 20 each month, or USD 192 each year (20% less), before tax for
one seat. Each Suplex account gets one 14-day Pro trial with no payment
method. Onboarding starts it when the owner joins: the "You" step calls
`startTrialIfAvailable` (`apps/web/features/onboarding/onboarding.ts`), which
starts the trial for an administrator on Free whose account has not used one.
Settings > Billing also offers it. Without a payment method at the trial end,
Stripe cancels the subscription and the host returns to Free.

Team costs USD 75 each month for 3 seats, then USD 15 for each seat; or USD
720 each year for 3 seats, then USD 144 for each seat. Team checkout buys a
seat count, at least 3: Settings > Billing defaults to one seat for each user
who is not revoked, and shows seats used against seats purchased. Suplex does
not limit invitations by seats. A Pro subscriber changes to Team, and a Team
subscriber changes the seat count, in the Stripe portal (Open billing).
Checkout accepts promotion codes and asks for no card when a code makes it
free (`payment_method_collection=if_required`).

### Plan changes

Settings > Billing shows Free, Pro, and Team side by side, with a Monthly /
Annual switch and the current plan's column shaded. Administrators change the
plan there (`apps/web/features/settings/plan-table.tsx`):

- Without a live subscription, Pro starts the 14-day trial (monthly, when the
  account has one) or Checkout, and Team starts Checkout for its seat count.
- With a live subscription, including a trial, each other choice opens the
  Stripe page that confirms that exact change (`POST /api/billing/change`,
  hosted `POST /v1/plan/change`): a customer portal deep link
  (`subscription_update_confirm` with the new price and seats, or
  `subscription_cancel` for Free). Stripe shows the amount, collects payment,
  and applies the portal settings below.

Checkout buys a first subscription only. With a live subscription, checkout
reports it (`subscribed`) and buys nothing. Every later change happens in the
Stripe customer portal, on the same subscription:

- Upgrades (Pro to Team, monthly to yearly, more Team seats) prorate: the
  customer gets a credit for the unused part of the period and pays for the
  new price for the rest of it, invoiced at once.
- Downgrades (fewer seats, a shorter interval) apply at the end of the period,
  with no credit. Team to Pro is a change between products, so Stripe applies
  it at once and credits the unused Team time.
- A trial ends when the subscription changes: choosing Team during the Pro
  trial starts payment.

suplex.sh reads the new price on its next read, so the host shows the new plan
without other action.

### Downgrades

A host never loses work when its plan ends:

- **Pro ends** (the trial ends without a card, a cancellation takes effect, or
  payment fails past its grace): the host is Free. Everything it has stays
  editable. Free's limits stop only new companies, projects, and tasks, and
  queued tasks wait for one of 3 running slots.
- **Team ends**: `suplex_plan` keeps `plan = 'team'`, so `billing::team_lapsed`
  tells it from Free. Work in every company is read-only for everyone, admins
  too, until someone selects Team again; a banner says so and links an
  administrator to Settings > Billing. Company scoping stays, so a lapse never
  shows a member more. Administrators can still manage billing and users.
  Paying again restores edit access. See [member access](accounts.md#member-access).

A hosted outage never causes either downgrade; only a confirmed read does.

`FREE`, `PRO`, and `TEAM` in `apps/server/src/billing/mod.rs` hold the limits.
`billing::require` decides each limit inside the transaction that writes:
company creation and restore, project creation, task creation (every path:
browser, agent API, MCP, GitHub triggers, moves), and Start anyway. Queue
admission applies the running-task limit in the same SQL statement as the
project task concurrency, so a fourth Free task waits in the queue with
`queue.planConcurrencyLimited` and starts when a running task stops. A host
over a limit after a downgrade keeps everything it has; only new work stops.

`suplex_plan` remembers the last plan suplex.sh confirmed for the linked
account: its account ID, the end of its paid access, and the paid plan (`pro`
or `team`, from `GET /v1/plan?tier=1`). The paid plan applies while that access
has not ended and the same account is linked. Suplex reads the plan
again:

- before a Free limit refuses an action (`billing::observe`), so a purchase
  made on another device applies at once;
- on every visit to Settings > Billing, after a login, and every 15 minutes.

A hosted outage keeps the confirmed paid plan until its paid access ends. It
never grants or extends one. A confirmed lapse ends paid access but keeps the
paid plan, so a lapsed Team stays read-only.

Members and administrators read the plan in Settings > Billing. Only active
administrators can start the trial, select Pro or Team, or open the billing
portal, and only when a Suplex account is linked.

## Start free and Start 14-day trial

The website buttons link to `https://suplex.sh/start` (Start free) and
`https://suplex.sh/start?plan=pro` (Start 14-day trial), implemented in
`apps/server/src/accounts/hosted/start.rs`.

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

1. The private Suplex application (`suplex`, `apps/server/src/billing/mod.rs`). It
   counts projects and accounts, authorizes the operator, enforces project
   policy, and calls the billing service over outbound HTTPS. It holds no
   merchant credentials.
2. The Suplex-operated public billing service (`apps/server/src/billing/hosted/`),
   part of `suplex hosted serve` at `https://suplex.sh` on Fly with
   [accounts](accounts.md) and the suplex.sh site. It owns Stripe and RevenueCat credentials,
   company billing accounts, Checkout and Portal creation, provider reads, and
   webhooks. It never runs the Suplex server, task hosts, or native runtimes.

Both processes are the same `suplex` binary and share one wire contract,
`apps/server/src/billing/wire.rs`. Installations never hold the service's provider
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
mise run hosted:tunnel
mise run hosted:dev     # sandbox secrets from 1Password .env.development
SUPLEX_ACCOUNT_SERVICE_URL=http://127.0.0.1:4212 mise run dev   # billing follows accounts
```

Both billing tasks read 1Password through the Suplex service account. The
sandbox has no head office address, so `hosted:dev` sets
`STRIPE_AUTOMATIC_TAX=false`. Pay with Stripe test cards such as
`4242 4242 4242 4242`.

Production targets the Fly app `suplex-production` (`fly.toml` and
`Dockerfile` in `apps/server/`). The configuration uses one machine
in `yyz` and a `billing_data` volume mounted at `/data`. The public origin is
`suplex.sh`; `www.suplex.sh` redirects to the origin. There is no legacy billing
hostname. `mise run hosted:dns` points both hostnames at Fly. `fly.toml` sets
the non-secret variables, including the live Stripe price IDs. Set the provider
secrets once, then deploy:

```sh
fly secrets set --app suplex-production STRIPE_SECRET_KEY=... \
  STRIPE_PORTAL_CONFIGURATION_ID=... \
  STRIPE_WEBHOOK_SECRET=... REVENUECAT_SECRET_API_KEY=... \
  REVENUECAT_STRIPE_PUBLIC_API_KEY=... REVENUECAT_WEBHOOK_AUTHORIZATION=... \
  REVENUECAT_APP_ID=...
mise run hosted:deploy
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
| `STRIPE_PRO_ANNUAL_PRICE_ID` | The configured USD 192 yearly licensed seat price. |
| `STRIPE_TEAM_MONTHLY_PRICE_ID`, `STRIPE_TEAM_ANNUAL_PRICE_ID` | Optional; set both or neither. The Team graduated prices. Without them Team checkout returns `plan_unavailable`. |
| `STRIPE_PORTAL_CONFIGURATION_ID` | The dedicated Suplex portal configuration. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the Suplex Stripe webhook destination. |
| `STRIPE_AUTOMATIC_TAX` | `true` (default) or `false`. Stripe Tax on Checkout needs a head office address in the Stripe account. |
| `REVENUECAT_SECRET_API_KEY` | Server-side key for subscriber reads. |
| `REVENUECAT_STRIPE_PUBLIC_API_KEY` | The Stripe app's public key, used for receipt imports. |
| `REVENUECAT_WEBHOOK_AUTHORIZATION` | The exact Authorization header value RevenueCat sends to Suplex. |
| `REVENUECAT_APP_ID` | The RevenueCat app/config identity allowlisted for events. |

Installations use `https://suplex.sh` by default. Set
`SUPLEX_BILLING_SERVICE_URL` to use another HTTPS origin, or a loopback URL for
development. Development roots (`SUPLEX_ROOT`) have no default. `mise run dev`
sets it to the account service, `https://suplex.sh` unless
`SUPLEX_ACCOUNT_SERVICE_URL` says otherwise, so the linked account sees its
plan and can start its trial. An empty value turns billing off:
the installation runs Free, a third project in a company returns 402
`project_limit_reached`, and existing projects are never touched. A company
with an existing billing binding reports the subscription as unknown, never as
Free.

The service verifies each configured price before it serves purchase mutations:
`usd`, `unit_amount` 2000 monthly or 19200 yearly, interval count 1, `licensed` usage,
`per_unit` billing, no quantity transformation, and a key mode matching
`BILLING_ENVIRONMENT`. A Team price is `tiered` with `graduated` tiers: up to
3 at a flat 7500 (72000 yearly) and 0 per unit, then 1500 (14400 yearly) per
unit. A mismatch returns `billing_setup_invalid`; it never
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
2. Create the Stripe product `Suplex Pro` with a USD 20.00 monthly and a
   USD 192.00 yearly per-unit licensed price (tax-exclusive). Enable Stripe Tax for production Checkout
   and configure the merchant's tax settings before activation. Create the
   product `Suplex Team` with a monthly and a yearly graduated tiered price
   (tax-exclusive): first tier units 0 to 3 with a USD 75.00 (720.00) flat fee
   and USD 0 per unit, second tier from 4 at USD 15.00 (144.00) per unit.
3. Import the product into the RevenueCat Stripe configuration and attach both
   prices to the entitlement identifier `pro`. Use the same identifier in the
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
8. Configure the Stripe customer portal (the account has one configuration,
   `STRIPE_PORTAL_CONFIGURATION_ID`) for payment methods, invoices, billing
   details, cancellation at period end, and resuming a scheduled cancellation.
   Under Subscriptions:
   - Customers can switch plans: the Pro monthly and yearly prices and the
     Team monthly and yearly prices.
   - Customers can change quantity: Pro limited to 1, Team from 3 to 9999.
   - End trials on subscription updates: on.
   - When customers change plans or quantities: prorate charges and credits,
     invoiced immediately.
   - Downgrades: apply at the end of the billing period.
   Disable retention coupons and retention rules. These are not the Suplex
   trial, which suplex.sh starts itself.
9. Configure Stripe payment retries and customer emails in Stripe. Suplex does
   not run dunning or send payment email.

## Hosted API

`/v1/plan*` authenticates the Suplex account token the host received at login.
Each Suplex account has one billing account whose registration ID is the
account ID. The older routes authenticate each v1.3.0 company with a bearer
credential created at registration. Only SHA-256 hashes are stored.

| Endpoint | Behavior |
| --- | --- |
| `GET /v1/plan` | Bearer Suplex account token. The account's `{state, trialAvailable}`. With `?tier=1`, also `plan: "pro" \| "team"` and `interval` for an active subscription; hosts before Team reject unknown fields, so only new hosts ask. |
| `POST /v1/plan/trial` | Bearer Suplex account token. Start the account's one 14-day trial, or return the current plan. 409 `trial_used` after a trial. |
| `POST /v1/plan/checkout` | Bearer Suplex account token plus `Idempotency-Key`. Optional body `{plan: "pro" \| "team", interval: "month" \| "year", quantity}`; no body is one monthly Pro seat. Pro is one seat; Team buys `quantity` seats, at least 3 (default 3). |
| `POST /v1/plan/portal` | Bearer Suplex account token. A portal session for the account's customer. |
| `POST /v1/plan/change` | Bearer Suplex account token. Body `{plan: "free" \| "pro" \| "team", interval?, quantity?}`. A portal deep link that confirms changing the live subscription to that plan; Free cancels it. `no_subscription` without a live subscription, `plan_unchanged` for the current price and seats. |
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
confirmed paid snapshot until its paid access ends. A
confirmed lapse ends it. With no unexpired paid
snapshot, creation beyond the Free allowance returns `billing_unavailable`
until Suplex can verify the subscription.
