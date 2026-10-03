# Telemetry

Suplex release builds send product usage events to PostHog. The native host,
signed-in browser, hosted billing service, and website have separate capture
controls. Suplex does not send code, prompts, task titles or descriptions,
company or project names, repository names, branches, or file paths.
See [PostHog operations](posthog.md) for dashboard provisioning and website setup.

## When Suplex sends

The host sends only when all of these are true:

- The build has a PostHog project key. Release builds compile it in from
  `SUPLEX_POSTHOG_KEY`. Source builds have no key and send nothing.
- `DO_NOT_TRACK` is not set to a non-zero value, and `SUPLEX_TELEMETRY` is not
  `0`, `false`, or `off`.
- **Settings → Environment → Send usage data** is on. It is on by default.
- An administrator answered the notice that the application shows on first use.

Rows written before the notice, or while telemetry is off, are never sent. The
next send starts from the rows that exist then.

The host reads committed rows once a minute and sends them in one batch to
`https://us.i.posthog.com/batch/` (`SUPLEX_POSTHOG_HOST` overrides the host). A
failed send is retried on the next minute. Telemetry never blocks or changes a
user action.

## Identity

- `distinct_id` is the installation ID in `<root>/installation-id`.
- Every event carries the PostHog groups `host` (the installation ID) and,
  when the event belongs to a company, `company` (the company ID).
- The notice has an optional email field. When you enter an address, Suplex
  sets it as a person property on the installation identity. The address does
  not replace the installation ID, and accepting telemetry is not a signup.
- Browser identities include the installation ID and authenticated user ID.
  Browser and host events join through the `host` and `company` groups.
  Browser properties include the user role and company plan, without names.

## Events

Native usage events have these properties: `app_version` (the semantic version),
`app_revision` (the build revision), `os`, `arch`, `$lib` (`suplex-host`), and
`$groups`. Events also carry a top-level UUID. Version changes appear as
`host_upgraded` observations.

| Event | Source | Extra properties |
| --- | --- | --- |
| `host_started` | first send after the host starts | none |
| `$identify` | notice answered with an email | `$set.email` |
| `host_upgraded` | first observation of a different semantic version | `previous_app_version`, `previous_app_revision` |
| `company_created` | audit event | none |
| `project_created` | audit event | `git_host` (`github`, `bitbucket`, or `none`), `tracker` (`github`, `jira`, or `none`) |
| `membership_added` | audit event | none |
| `workflow_created` | audit event | none |
| `task_created` | audit event | `source` (`user` or `agent`), `has_image`, task context |
| `task_started` | audit event | task context |
| `task_answered` | audit event | task context |
| `task_cancelled` | audit event | task context, `duration_s` when measurable |
| `task_waiting_human` | task lifecycle | task context |
| `task_delivered` | task lifecycle | task context, `duration_s` (created to delivered) |
| `pr_opened` | a task records a pull request | `git_host` |
| `pr_merged` | the task's pull request is merged | `git_host` |
| `host_daily` | once a day | `users`, `companies`, `projects`, `tasks_running`, `tasks_created_7d`, `tasks_delivered_7d`, `move_runs_7d`, `task_templates`, `github_triggers_enabled`, provider profile counts |
| `$groupidentify` | once a day per active company | `seats` (the billing seat count), `projects`, `plan` (`free`, `pro`, or `unknown` when the billing snapshot is stale) |

Task context contains the built-in `workflow`, `delivery_target`,
`coordinator_provider`, `worker_provider`, and `advisor_count`. Unavailable task
context is omitted. Provider profile counts are `profiles_opencode`,
`profiles_claude_code`, `profiles_devin`, and `profiles_codex`.

## Browser analytics and replay

The browser loads `posthog-js` only after the authenticated telemetry endpoint
confirms that the build has a project key, usage data is on, and an administrator
accepted the notice. Browser Do Not Track and Global Privacy Control also stop
capture. Logout, failed configuration reads, and disabled telemetry stop capture.
Settings changes notify the current tab and other tabs; a periodic refresh also
checks the authoritative host setting.

**Record session replays** is a separate, default-off host choice. Accepting the
old usage notice does not enable it. Replay also needs the
`suplex-app-session-replay` feature flag. All text and inputs are masked.
Terminal, code, prompt, attachment, and image surfaces are excluded. Console
logs, request headers and bodies, canvas capture, and cross-origin iframe capture
are disabled. Captured routes replace resource IDs with placeholders and remove
query strings and fragments.

Browser events include `$pageview`, `screen_viewed`, `session_engaged`, sanitized
exceptions for PostHog Error Tracking, and `api_request_failed`. Properties
include the screen, app version/revision, browser or desktop platform, user role,
company plan, and PostHog browser/OS/session metadata. Engagement adds
`duration_s`; API failures add the route, numeric status, and an allowlisted error
code. Error text must not contain original application messages or user content.
Feature flags are optional presentation controls and never decide task authority,
paid access, or delivery permission.

## Billing and monetization

Hosted billing capture is off by default. The service operator must set
`BILLING_TELEMETRY=true` and `BILLING_POSTHOG_KEY`. This service-level choice is
independent of an installation's usage setting. The optional
`BILLING_POSTHOG_HOST` selects the ingestion host. No customer installation holds
Stripe or RevenueCat provider secrets.

Only authenticated, environment-matched provider webhooks produce billing
events. They use installation/company groups, `$lib=suplex-billing`, and
`billing_environment` (`sandbox` or `production`). Provider customer IDs, payment
details, emails, and raw webhook bodies are excluded. Delivery uses a durable
queue with bounded retries; analytics failure does not stop billing work.

| Event | Properties from the verified Stripe event |
| --- | --- |
| `billing_checkout_completed` | `amount_total_minor`, `currency`, `payment_status` when present |
| `billing_subscription_created`, `billing_subscription_updated`, `billing_subscription_deleted` | allowlisted `status`, `cancel_at_period_end`, bounded `quantity` when present |
| `billing_invoice_paid` | `amount_paid_minor`, `currency` when present |
| `billing_payment_failed`, `billing_payment_action_required` | `amount_due_minor`, `currency` when present |
| `billing_refund_issued` | `refund_amount_minor` (the verified increment), `currency` when measurable |

RevenueCat reports separate initial-purchase, renewal, cancellation,
uncancellation, expiration, billing-issue, refund, transfer, pause, and
grace-period lifecycle events. Those events contain no monetary totals. Stripe
is the monetary source, so RevenueCat cannot count the same payment again.
Cash receipts are not MRR. Dashboard queries separate production from sandbox
and keep currencies separate. Exact recurring revenue requires authoritative
subscription-state data; see [dashboard semantics](posthog.md#dashboard-semantics).

## Website and attribution

The Framer integration shows a consent control before loading PostHog. It
captures consented page visits, fixed CTA keys, and download platform/version
properties. Campaign properties use bounded first/last-touch UTMs, allowlisted
click IDs, and the referring hostname. Referrer and destination queries are
excluded. Attribution is browser-local; it does not claim cross-device identity
or an automatic link from a website visit to a native installation.

The integration prepares a local conversion event and an optional data-layer
handoff. It installs no advertising pixel. See the
[Framer setup](posthog.md#install-on-framer) for the supported consent interface.

The separate `suplex.sh/download` service sends `download_started` for download
requests from the install script and website. Properties are `platform`
(`macos-arm64`, `macos-x64`, `linux-arm64`, or `linux-x64`), `source`
(`install_script` or `browser`), and `$lib` (`suplex-web`). Each request uses a
new random `distinct_id`, so it does not link a download to a website browser
or native installation. A request with `DNT: 1` sends nothing. These service
events are separate from consented website download clicks.

## Local state

`suplex_telemetry` holds the notice time, optional email, replay choice, last
observed version, and send position. `suplex_telemetry_pull_requests` records
which pull requests were reported. Hosted billing has a separate analytics
outbox. None of this telemetry state is authority for a user action.
