# PostHog operations

Suplex uses one PostHog project for three explicitly separated surfaces:

- the native application sends product events with `$lib=suplex-host`;
- hosted billing sends verified Stripe webhook facts with `$lib=suplex-billing`;
- the public website sends consented browser events with `surface=website`.

Crash and error reports (`$exception`) come from every Suplex surface and go to
PostHog Error Tracking. See [Error Tracking](#error-tracking).

Do not combine those filters when an insight describes one surface. The managed
dashboard definitions in `scripts/posthog-provision.ts` apply the relevant
filter to each insight.

## Error Tracking

`$exception` events carry `$exception_list` with a raw stack trace, so PostHog
Error Tracking groups them without symbol upload. Each event has a fingerprint
that ignores line numbers, so a release does not split a group. The surfaces
are told apart by `$lib` and `exception_source`:

| `$lib` | `exception_source` | Surface |
| --- | --- | --- |
| `suplex-host` | `host` | native host and `suplex` subcommands |
| `suplex-host` | `desktop` | desktop shell panics, forwarded by the host |
| `posthog-js` | none | signed-in browser (mechanism `onerror`, `onunhandledrejection`, `react.*`) |
| `suplex-hosted` | `hosted` | `suplex hosted serve` |
| `suplex-billing` | `billing` | `suplex billing` commands |

The native, desktop, and browser reports follow the same consent as the other
product events; hosted reports need `BILLING_TELEMETRY`. [Telemetry](telemetry.md#exceptions)
lists the properties, the exclusions, the bounds on volume, and the gaps (mobile,
bootstrap, and processes the operating system kills).

Suggested Error Tracking setup: add an issue-created alert to the team channel,
and group by `app_version` to confirm that a release fixed a crash. The
product-health dashboard has two insights for this, "Reliability — exceptions
by surface" and "Reliability — unhandled exceptions by app version".

## Provision dashboards and flags

The provisioning script manages resources carrying both
`managed-by:suplex-posthog-v1` and a stable `suplex:<type>:<key>` tag. It reads
every page from the PostHog API, updates a tagged match, and creates a resource
when no tagged match exists. It stops on duplicate ownership tags and does not
adopt an untagged feature flag with the same key.

Use a PostHog personal API key with the project scopes needed to read and write
dashboards, insights, and feature flags. Never use the website project token for
management calls.

```bash
# Offline review; no credential or API request.
pnpm tsx scripts/posthog-provision.ts --print-plan

# Read current resources and describe writes without making them.
POSTHOG_PERSONAL_API_KEY=... pnpm tsx scripts/posthog-provision.ts --dry-run

# Reconcile the project.
POSTHOG_PERSONAL_API_KEY=... pnpm tsx scripts/posthog-provision.ts
```

The safe defaults are `https://us.posthog.com` and project `642585`. An override
must also be placed in the corresponding allowlist:

```bash
POSTHOG_HOST=https://eu.posthog.com \
POSTHOG_ALLOWED_HOSTS=https://eu.posthog.com \
POSTHOG_PROJECT_ID=12345 \
POSTHOG_ALLOWED_PROJECTS=12345 \
POSTHOG_PERSONAL_API_KEY=... \
pnpm tsx scripts/posthog-provision.ts --dry-run
```

The script never prints the key. PostHog links and request errors contain only
the origin, project path, and HTTP status.

The managed feature flags are created inactive with zero-percent rollout:

- `suplex-website-cta-experiment` reserves a website experiment switch.

These flags do not control authentication, payment, entitlements, or application
availability.

## Dashboard semantics

The AARRR dashboard uses the following evidence:

| Stage | Evidence | Limit |
| --- | --- | --- |
| Acquisition | consented website `$pageview`, browser-local first source, and last campaign | attribution is bounded to the current browser; it is not cross-device identity |
| Activation | `project_created` → `task_started` → `task_delivered` | grouped by the native host installation |
| Retention | weekly return to `task_started` | this measures native task activity; `task_started` uses the host person, so group retention by the `host` group, not by person |
| Referral proxy | `membership_added` | collaboration proxy; `via=invitation` marks an accepted invitation, not a referral |
| Revenue | production `billing_invoice_paid`, `amount_paid_minor`, and `currency` from verified Stripe webhooks | Stripe minor-unit totals grouped by currency; not MRR |

The dashboard does not label invoice cash as MRR, ARR, churn, or ARPA. Exact
recurring-revenue KPIs need an authoritative subscription-state model that can
reconstruct active recurring line items, billing intervals, changes, pauses,
cancellations, credits, and currency treatment at a point in time. The current
event stream is useful operational evidence but is not that model. Add a Stripe
warehouse or another authoritative subscription snapshot before provisioning
those KPIs. Never sum mixed currencies; select one currency or normalize through
an approved exchange-rate source.

The product-health dashboard covers native host activity, task workflow,
delivery duration, version, OS, pull request outcomes, and consented website CTA
and download events. It also reports server-observed `download_started` requests
from `$lib=suplex-web`, in total and by platform. The download server assigns a
new identity to each request, so these counts cannot be joined to a Framer
visitor or native installation. They are independent of the consented
`website_download_clicked` click count and do not change financial metrics.
The duration insight uses a `HogQLQuery`; the remaining
managed definitions use `InsightVizNode` with real `TrendsQuery`, `FunnelsQuery`,
and `RetentionQuery` sources.

The SaaS billing-health dashboard keeps Stripe and RevenueCat roles separate.
Verified production Stripe webhook facts supply paid-company, checkout, payment,
refund, subscription, and cash insights. Cash uses `amount_paid_minor`; refunds
use the incremental `refund_amount_minor`. Both remain in Stripe minor units and
split by currency because currencies have different exponents. RevenueCat supplies
purchase, renewal, cancellation, expiration, billing issue, grace-period,
pause, transfer, and refund lifecycle counts only. RevenueCat events have no
money properties, so they cannot double count Stripe cash.

## Install on Framer

Framer Custom Code has three parts:

1. Start of `<head>`: the Google Tag Manager snippet for `GTM-N739QG5C` with its
   Consent Mode defaults. `apps/server/src/shared/page.html` has the same
   snippet; copy it from there, without changes.
2. End of `<body>`: `<script src="https://suplex.sh/consent.js"></script>`.
3. End of `<body>`: `apps/server/src/hosted/framer-attribution.js`, pasted as
   is. Parts 2 and 3 can be in either order.

`framer-attribution.js` holds the PostHog setup. Its `phc_` token is a public,
write-only project token, not a management secret. The snippet sends through
`https://meta.suplex.sh` and uses `https://us.posthog.com` for PostHog UI links.

### Shared consent banner

`apps/server/src/hosted/consent.js` is the only copy of the consent banner and
its **Analytics settings** button. suplex.sh serves it at
`https://suplex.sh/consent.js`. getsuplex.ai loads it from there, and the
suplex.sh pages load it too: every page made with `shared/page.html` (`/start`,
login, and billing pages) and the legal pages. Do not copy the banner text or
styles into Framer.

- The choice is `localStorage["suplex.analytics.consent.v1"]`, `granted` or
  `denied`, on each site.
- A `consent=granted` or `consent=denied` URL parameter is stored as the choice
  on either site. Other values are ignored. On getsuplex.ai the stored parameter
  starts or stops PostHog as Accept or Reject does.
- localStorage is per origin, so links carry the choice. When a link to the
  other site (`https://suplex.sh`, `https://getsuplex.ai`) is opened, the script
  sets its `consent` parameter to the stored choice. Same-site links that
  already have `consent` get the current choice, or lose the parameter when no
  choice is stored. The suplex.sh redirect to getsuplex.ai keeps a valid
  `consent` parameter.
- The banner shows only when no choice is stored and no valid `consent`
  parameter arrived.
- Global Privacy Control or Do Not Track: the choice is always `denied`.
  `granted` is never stored, even from a `consent=granted` parameter, and the
  banner and settings button do not show. Links carry `consent=denied`.
- Consent Mode starts with every type denied. Only the Google Tag Manager
  snippet grants the ad types, when the stored choice is `granted` and Global
  Privacy Control is off. When a `granted` choice is withdrawn, `consent.js`
  sends a denied Consent Mode update.

suplex.sh has no PostHog browser SDK. Its signup pages only keep the incoming
query, including `consent` and `visitor`, in each link
([Suplex accounts](accounts.md#suplexsh-signup-pages)).

### PostHog on getsuplex.ai

PostHog does not load until the visitor allows analytics. A custom site consent
control can call exactly one of:

```js
window.SuplexAnalytics.grantConsent()
window.SuplexAnalytics.denyConsent()
window.SuplexAnalytics.clearConsent()
```

After consent it records the initial page and History API navigation. It stores
bounded first- and last-touch values for the UTM fields `source`, `medium`,
`campaign`, `content`, and `term`; the referring hostname; and allowlisted click
IDs. It never stores a referrer path or query. This attribution remains in the
same browser and must not be presented as cross-device or cross-browser.

Annotate CTA and download links in Framer:

```html
<a data-suplex-cta="pricing" href="/pricing">See pricing</a>
<a
  data-suplex-download
  data-suplex-cta="hero-download"
  data-suplex-platform="macOS"
  data-suplex-version="1.2.3"
  href="https://downloads.example/suplex.dmg"
>Download</a>
```

The live `/download?platform=` links are also recognized without annotations
for the allowlisted values `macos-arm64`, `macos-x64`, `linux-x64`, and
`linux-arm64`. This includes exact HTTPS links from `getsuplex.ai` to
`suplex.sh/download`; matching paths on other hosts are ignored. The live
`#pricing`, `#get`, and `/product` destinations are
recognized as fixed CTA keys. Link text never becomes an analytics property.
Set `window.SUPLEX_POSTHOG_CONFIG = { downloadVersion: "1.2.3" }` before the
snippet when Framer has the current release version; a link-level
`data-suplex-version` overrides it.

#### Links to suplex.sh

With granted consent and no Do Not Track or Global Privacy Control signal, the
script decorates every link and form whose target origin is
`https://suplex.sh`, not only the classified CTAs. It adds the parameters in the
capture phase of `click`, `auxclick`, `contextmenu`, and `submit`, as the
consent script adds `consent`. It adds:

- The click IDs `gclid`, `gbraid`, `wbraid`, `msclkid`, and `fbclid`, and the
  UTM values `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, and
  `utm_content`, from one stored touch: the last touch when it has a campaign
  value, else the first touch. A referrer-only last touch falls back to the
  first touch.
- `_gl`, from the current page URL, or else from the landing URL.
- `visitor`, the visitor's PostHog distinct ID, when it matches
  `^[A-Za-z0-9._:-]{8,64}$`.

A parameter that the link already has is kept, never replaced. When the choice
is withdrawn, the script removes the parameters it added. Links to other
origins and same-site links get none of them. Without consent, or with a
privacy signal, nothing is stored and no link gets a click ID, UTM value,
`visitor`, or `_gl`.

The script keeps the landing URL's touch and `_gl` in memory, never in
storage, until the visitor accepts. Accept stores that touch even when Framer
changed the URL without a reload first. A click ID over 256 characters, or with
a character outside `A-Z`, `a-z`, `0-9`, and `._~-`, is dropped, not cut.

suplex.sh keeps these values for the signup and stores them on a new account
([Suplex accounts](accounts.md#signup-attribution)). The `/download` and
`/start` pages keep `visitor` in a first-party `suplex_visitor` cookie. A later
Suplex account login in the same browser sends `$identify`, which joins this
visitor to the account. See
[Suplex accounts](accounts.md#posthog-identity-bridge). Click IDs are not
PostHog event properties on suplex.sh.

Only the CTA label, destination hostname, platform, version, safe page fields,
and bounded attribution fields are sent. Destination and referrer query strings
are discarded. Automatic capture is off. Session replay is disabled and has no
switch. Console capture is off. SDK
URL properties pass through the same query and fragment scrubber before send.
Browser Do Not Track and Global Privacy Control signals prevent both the SDK and
consent controls from loading. After a visitor accepts or rejects analytics, a
compact **Analytics settings** button remains at the bottom left. It revokes the
saved choice, stops capture, and reopens the Accept/Reject bar. Without
`consent.js` on the page, `window.SuplexAnalytics` still stores the choice and
controls PostHog, but no banner shows.

Every consented CTA or download also emits a local `suplex:conversion` browser
event. `window.SUPLEX_POSTHOG_CONFIG = { enableDataLayer: true }`, set before the
snippet, additionally pushes the same allowlisted object to `window.dataLayer`.
This only prepares a consented handoff. The artifact installs no advertising
pixel and must not be extended with one until the actual provider and account or
pixel ID are supplied and approved.

Framer publication and consent-banner wiring are external operations. Verify the
published site in a private browser: reject consent, accept consent, navigate
without a reload, and click each annotated download platform. Then confirm that
PostHog receives only the documented properties. Open a Start link: suplex.sh
shows no banner and the URL has `consent`. Select **Analytics settings** on
suplex.sh, select the other choice, and open the Suplex link on a legal page:
getsuplex.ai uses that choice.
