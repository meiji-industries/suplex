# PostHog operations

Suplex uses one PostHog project for three explicitly separated surfaces:

- the native application sends product events with `$lib=suplex-host`;
- hosted billing sends verified Stripe webhook facts with `$lib=suplex-billing`;
- the public website sends consented browser events with `surface=website`.

Do not combine those filters when an insight describes one surface. The managed
dashboard definitions in `scripts/posthog-provision.ts` apply the relevant
filter to each insight.

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

- `suplex-app-session-replay` is the app-side replay switch; the app also
  requires explicit host replay consent;
- `suplex-website-session-replay` can enable masked replay after consent and a
  separate intentional rollout;
- `suplex-website-cta-experiment` reserves a website experiment switch.

These flags do not control authentication, payment, entitlements, or application
availability.

## Dashboard semantics

The AARRR dashboard uses the following evidence:

| Stage | Evidence | Limit |
| --- | --- | --- |
| Acquisition | consented website `$pageview`, browser-local first source, and last campaign | attribution is bounded to the current browser; it is not cross-device identity |
| Activation | `project_created` → `task_started` → `task_delivered` | grouped by the native host installation |
| Retention | weekly return to `task_started` | this measures native task activity |
| Referral proxy | `membership_added` | collaboration proxy only; it does not prove an invitation or referral |
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

`integrations/posthog/framer-attribution.js` is paste-ready Framer Custom Code
for the end of `<body>`. Its `phc_` token is a public, write-only project token,
not a management secret. The snippet sends through `https://meta.suplex.sh` and
uses `https://us.posthog.com` for PostHog UI links.

When there is no saved choice, the snippet shows a compact Accept/Reject consent
bar and does not load PostHog until the visitor allows analytics. A custom site
consent control can call exactly one of:

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

Only the CTA label, destination hostname, platform, version, safe page fields,
and bounded attribution fields are sent. Destination and referrer query strings
are discarded. Automatic capture is off. Replay is off by default; if its
disabled-by-default flag is intentionally rolled out, all text and inputs remain
masked; images, code, preformatted text, iframes, and `[data-private]` elements
remain blocked. Console capture is off. Replay network request URLs lose their
query and fragment, and request or response headers and bodies are removed. SDK
URL properties pass through the same query and fragment scrubber before send.
Browser Do Not Track and Global Privacy Control signals prevent both the SDK and
consent controls from loading. After a visitor accepts or rejects analytics, a
compact **Analytics settings** button remains at the bottom left. It revokes the
saved choice, stops capture, and reopens the Accept/Reject bar.

Every consented CTA or download also emits a local `suplex:conversion` browser
event. `window.SUPLEX_POSTHOG_CONFIG = { enableDataLayer: true }`, set before the
snippet, additionally pushes the same allowlisted object to `window.dataLayer`.
This only prepares a consented handoff. The artifact installs no advertising
pixel and must not be extended with one until the actual provider and account or
pixel ID are supplied and approved.

Framer publication and consent-banner wiring are external operations. Verify the
published site in a private browser: reject consent, accept consent, navigate
without a reload, and click each annotated download platform. Then confirm that
PostHog receives only the documented properties.
