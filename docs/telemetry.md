# Telemetry

Suplex release builds send product usage events and crash reports to PostHog.
The native host, signed-in browser, hosted billing service, and website have
separate capture controls. Suplex does not send code, prompts, task titles or
descriptions, company or project names, repository names, branches, or file paths.
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

The notice shows in the application frame and in the onboarding wizard, at the
top of every onboarding screen. Onboarding runs outside the application frame,
so before this a new installation could create its first project before anyone
could answer the notice. An administrator who accepts the notice during
onboarding sends `project_created` for the first project. The host seeds its
first company at its first start, before any person can answer the notice, so
that `company_created` row is never sent. Instead, the first time onboarding
gives that company its company code, the host sends `company_created` with
`via` set to `onboarding`. This happens only for a company that existed before
the notice was answered, and only for its first code, so a company is counted
once. A company created after the notice sends its own `company_created` with
`via` set to `created`.

The host reads committed rows once a minute and sends them in one batch to
`https://us.i.posthog.com/batch/` (`SUPLEX_POSTHOG_HOST` overrides the host). A
failed send is retried on the next minute. Telemetry never blocks or changes a
user action.

## Identity

- An event that a user caused uses that user's person. It is the user's
  [Suplex account](accounts.md) ID (`user_<uuid>`) from
  `suplex_account_users`, else `<installation ID>:user:<user ID>`. The host
  owner's account is the linked account; an invited member's account is the
  one they accepted the invitation with. The browser and the host use the same
  IDs.
- Events that no user caused (host lifecycle, daily counts, task lifecycle
  including `task_started`, pull requests, agent actions, and agent-surface
  events) use `<installation ID>:host`. That person is never a user and never
  merges into one.
- Every event carries the PostHog groups `host` (the installation ID) and,
  when the event belongs to a company, `company` (the company ID).
- After a link, the host sends one `$set` with `distinct_id` set to the account
  ID and `$set.email`. It does not merge the installation person, which holds
  events from before this rule that every user and the host caused.
  The hosted service sends an `$identify` when the login browser carried
  a `suplex_visitor` cookie from `suplex.sh/download`. That merges the website
  visitor into the account person.
- Browser and host events also join through the `host` and `company` groups.
  Browser properties include the user role and company plan, without names.
- Hosts that sent an email through the retired telemetry notice keep that
  email on the installation person. They join an account person only through
  the `host` group, unless the host later links an account.

## Events

Native usage events have these properties: `app_version` (the semantic version),
`app_revision` (the build revision), `os`, `arch`, `$lib` (`suplex-host`), and
`$groups`. Events also carry a top-level UUID. Version changes appear as
`host_upgraded` observations.

| Event | Source | Extra properties |
| --- | --- | --- |
| `host_started` | first send after the host starts | none |
| `$set` | first send after an account is linked | `$set.email` on the account person |
| `host_upgraded` | first observation of a different semantic version | `previous_app_version`, `previous_app_revision` |
| `company_created` | audit event, or the first company code of the seeded company (see [When Suplex sends](#when-suplex-sends)) | `via` (`created` or `onboarding`) |
| `project_created` | audit event | `project_id`, `git_host` (`github`, `bitbucket`, or `none`), `tracker` (`github`, `jira`, or `none`) |
| `membership_added` | audit event: an administrator adds a member, or an invited person accepts the invitation | `via` (`admin` or `invitation`) |
| `workflow_created` | audit event: an administrator creates a workflow | none |
| `onboarding_completed` | audit event: the onboarding wizard finishes, once per company | `outcome` (`first_task` or `skipped`) |
| `task_created` | audit event | task context, `has_image` |
| `task_started` | the first `active` lifecycle row of a task | task context |
| `task_answered` | audit event | task context |
| `task_cancelled` | audit event | task context, `duration_s` when measurable |
| `task_waiting_human` | task lifecycle | task context |
| `task_delivered` | task lifecycle | task context, `duration_s` (created to delivered) |
| `pr_opened` | a task records a pull request | task context, `git_host` |
| `pr_merged` | the task's pull request is merged | task context, `git_host` |
| `agent_paired` | audit event: a pairing code exchange, a credential rotation, or an OAuth approval | `agent_id`, `method` (`pairing_code`, `rotation`, or `oauth`), `project_count`, `project_id` when the agent has exactly one project, `profile_id` when the client sent one, `cli_version` when the client was `suplex mcp` |
| `agent_pairing_failed` | the pairing exchange returns an error, once per status and code each hour | `status`, `error_code` |
| `mcp_connected` | `/mcp` authenticates an agent, once per agent and hour | `agent_id`, `profile_id` when known |
| `mcp_auth_failed` | `/mcp` returns 401 or 403, once per status and code each hour | `status`, `error_code` |
| `cli_invoked` | `suplex mcp` calls the Agent API, once per agent and hour | `command` (`mcp`), `cli_version`, `agent_id`, `profile_id` when known |
| `agent_request_failed` | an Agent API, pairing, or `/mcp` request returns 400 or more | see [Agent request failures](#agent-request-failures) |
| `host_daily` | once a day | `users`, `companies`, `projects`, `tasks_running`, `tasks_created_7d`, `tasks_delivered_7d`, `move_runs_7d`, `task_templates`, `github_triggers_enabled`, provider profile counts |
| `$groupidentify` | once a day per active company | `seats` (members that are not revoked), `projects`, `plan` (the installation plan, `free`, `pro`, or `team`) |

Task context is the same for every task event and pull request event. It
contains `task_id`, `project_id`, `source` (`user` when a user created the task,
`agent` when an agent created it), and for an agent-created task `agent_id` (the
creating agent) and `profile_id` when that external agent has a client profile
ID. It also contains the built-in `workflow`, `delivery_target`,
`coordinator_provider`, `worker_provider`, and `advisor_count`. Unavailable
values are omitted. Provider profile counts are `profiles_opencode`,
`profiles_claude_code`, `profiles_devin`, `profiles_codex`, `profiles_pi`, and
`profiles_omp`.

A client profile ID is text that an agent client chooses, so `profile_id` is
never that text. It is the first 16 hexadecimal characters of a SHA-256 hash of
the ID, which groups events of one profile without showing its name.

`task_started` comes from the task lifecycle, not from the audit log. Every
path that makes a task active writes a lifecycle row: a user start, the Agent API
`start_task` command, queue admission, a force start, and a task that starts when
it is created. The first `active` row of a task sends `task_started`. A task that
waits for a person and runs again is not started again, and its event ID is the
same if a send repeats. Because no user is attached to a lifecycle row,
`task_started` uses the host person.

### Agent surfaces

The host records the agent events above in `suplex_telemetry_events` and sends
them with the rest of its telemetry, under the same gates. It records them only
while `DO_NOT_TRACK` and `SUPLEX_TELEMETRY` allow it, the Environment setting is
on, and the notice was answered. When telemetry turns off, waiting rows are
deleted. At most 1000 rows wait. Each row has a deduplication key, so
`mcp_connected` and `cli_invoked` are recorded once per agent and hour, and a
failure is recorded once per agent, route, status, and code each hour. The
host deletes sent rows after two days.

`suplex mcp` sends the client header `User-Agent: suplex-mcp/<version>`. The
host reads a version only when the header has exactly that shape with a
`<major>.<minor>.<patch>` version. Other header text is not kept. A pairing
exchange from `suplex mcp` stores that version in its audit row. No other
`suplex` command calls the Agent API; the operator commands, such as `suplex
task` and `suplex doctor`, send no usage event.

Properties never hold a pairing code, a credential, an access token, a request
or response body, an error message, a client name, a profile ID in clear text,
a path, or header text.

### Agent request failures

`agent_request_failed` has these properties:

- `exception_source`: `agent_api` for `/api/agent`, `/api/hermes`, and the
  pairing exchange, `mcp` for `/mcp`, and `cli` for an Agent API request from
  `suplex mcp`;
- `http_method` (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, or
  `OTHER`) and `http_route`, the matched route template such as
  `/api/agent/tasks/{task_id}`, never the path;
- `status`, the HTTP status;
- `error_code`: the response `code` (the `error` field for `/mcp`) when it is
  in the host's allowlist, `other` for any other code, or `none`;
- `agent_id` and `profile_id` when the request authenticated an agent, and
  `cli_version` from `suplex mcp`.

A tool error inside a successful `/mcp` JSON-RPC response is not an HTTP
failure and is not recorded.

## Browser analytics

The browser loads `posthog-js` only after the authenticated telemetry endpoint
confirms that the build has a project key, usage data is on, and an administrator
accepted the notice. Browser Do Not Track and Global Privacy Control also stop
capture. Logout, failed configuration reads, and disabled telemetry stop capture.
Settings changes notify the current tab and other tabs; a periodic refresh also
checks the authoritative host setting.

Session replay is disabled and has no setting or feature flag. Console logs are
not captured. Captured routes replace resource IDs with `:id` and remove query
strings and fragments. A segment stays when it is a static segment of the
application's screens or of the server route table, such as
`/api/agent/tasks/:id`, `/api/agent/pairing/exchange`,
`/api/tasks/:id/commands`, and `/api/companies/:id/projects`. A segment that has
the shape of a generated ID (`prefix_hex`, a UUID, a number, or long hex) and
any other text become `:id`. A unit test checks the static list against the
server route table.

Browser events include `$pageview`, `screen_viewed`, `session_engaged`, sanitized
exceptions for PostHog Error Tracking, and `api_request_failed`. Properties
include the screen, app version/revision, browser or desktop platform, user role,
company plan, and PostHog browser/OS/session metadata. Engagement adds
`duration_s`. `api_request_failed` adds `api_route` (the sanitized route),
`http_method` (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`, or
`OTHER`), the numeric `status`, and `error_code`, the response `code` when it is
in the browser's allowlist, else `unknown`. Error text must not contain original application messages or user content.
Feature flags are optional presentation controls and never decide task authority,
paid access, or delivery permission.

## Exceptions

Crashes and unexpected errors go to PostHog Error Tracking as `$exception`
events. Every surface uses the same rules: the report holds the exception type,
the mechanism, and stack frames. It never holds the text of a panic or error
message, a panic payload, a prompt, a title, a repository name, a branch, an
email address, a token, or a path outside the Suplex source tree. Code cannot
add free text to a report; it passes fixed names only.

| Surface | What is reported | Mechanism (`handled`) | Gates |
| --- | --- | --- | --- |
| Native host and every `suplex` subcommand | Any Rust panic in a command that can find the installation: the server, the CLI, and the bridges and display commands that the host starts with its environment | `panic` (no) | The host gates in [When Suplex sends](#when-suplex-sends) |
| Native host | A panic that a request handler turned into a 500 response | `caught_panic` (yes) | Same |
| Native host | A response with status 500 | `http_internal_error` (yes) | Same |
| Native host | A failed task scheduler pass or task recovery pass | `background_loop` (yes) | Same |
| Desktop shell | A Rust panic in the Tauri shell | `panic` (no) | The host gates, and `DO_NOT_TRACK` or `SUPLEX_TELEMETRY` also stop the write |
| Browser | `window` `error` and `unhandledrejection` | `onerror`, `onunhandledrejection` (no) | The browser rules in [Browser analytics](#browser-analytics) |
| Browser | React `createRoot` errors | `react.uncaught` (no), `react.caught` (yes), `react.recoverable` (yes) | Same |
| Hosted service (`suplex hosted serve`) | Rust panics, 500 responses, processor pass and account sweep failures, and outbox failures | `panic`, `caught_panic`, `http_internal_error`, `background_loop` | `BILLING_TELEMETRY` and `BILLING_POSTHOG_KEY` |
| `suplex billing` command | A Rust panic, sent at once | `panic` (no) | Same |

Properties on a native or hosted `$exception`: `$exception_list` (one entry
with `type`, a fixed `value`, `mechanism` with `type`, `handled`, and
`synthetic`, and a raw `stacktrace`), `$exception_level` (`fatal` when
unhandled, else `error`), `$exception_fingerprint`, `exception_source` (`host`,
`desktop`, `hosted`, or `billing`), `exception_occurrences`, `exception_thread`
(`main` or `tokio-runtime-worker` only), `http_method` and `http_route` (the
matched route template, such as `/api/tasks/{id}`, never the path) for a 500,
`loop` and `error_code` (fixed names) for a background loop, and the usual
`$lib`, `app_version`, `app_revision`, `os`, and `arch`. Native events add the
`$groups` described in [Identity](#identity). Hosted events use one fixed
person with no stored profile.

A stack frame holds `platform` (`custom`, language `rust`), the function symbol,
`in_app`, and, only for Suplex code, the source file below `apps/` or
`packages/` (for example `apps/server/src/tasks/host.rs`) with line and column.
The panic site gives the top frame its location even in a release build without
debug information. Frames of the standard library, dependencies, and the
panic machinery carry a symbol and no file. A path with a checkout location,
home directory, registry directory, or toolchain directory loses everything
before `apps/` or `packages/`, and a path with none of them is dropped.

Browser exceptions use the type name of a built-in error class (`Error` for any
other), the fixed value `Browser <type>`, and frames of scripts that the same
origin served. A frame holds the function name, `app://suplex/<path>` for a
bundle or source file under `/assets` or a development source directory, the
line, and the column. The page URL, query strings, other origins, and message
text never leave the browser. The browser reports one error object once, so a
React error that React raises again to `window.onerror` is not a second event.

### How the host records and sends

A panic hook is the first thing in `main`, so every subcommand has it. The hook
writes the report to `exceptions/` in the installation directory. The host reads
that directory with its other telemetry once a minute and sends at most ten
exceptions in a batch. A panic that ends the process is sent after the host
starts again. An acknowledged report is deleted and is not sent twice; its event
ID is the same if a send repeats.

The hook records only when the build has a key, `DO_NOT_TRACK` and
`SUPLEX_TELEMETRY` allow it, the Environment setting is on, and the notice was
answered. The host checks those gates again at each send. When any gate is
closed, the host deletes every waiting report. The host also deletes a report
from before the last time telemetry turned on, which covers a report that the
desktop shell wrote while the host did not run. Reports recorded before the
notice or while the setting is off are never sent later.

Volume is bounded:

- one file holds each distinct failure, and a repeat only raises its
  `exception_occurrences` count, so a crash loop does not add files;
- at most 20 distinct failures wait at once, and a new one beyond that is dropped;
- after a send, the same failure is quiet for one hour (a small marker file
  records it, and at most 200 markers stay);
- one process captures a backtrace for the same request or loop failure at
  most once a minute, and writes the report on its own thread, off the request.

A failure to record or send is ignored. Telemetry never changes the request,
loop, or command that failed.

### Hosted service

When the operator turns hosted telemetry on, the hosted service queues its
exceptions in the same durable outbox as its other events (`billing_telemetry_events`)
and delivers them with the same bounded retries. The same failure queues once an
hour, and at most 50 exceptions wait. A request handler panic becomes a 500
response; the hosted service otherwise handles requests as before.
Without `BILLING_TELEMETRY` and `BILLING_POSTHOG_KEY` it sends nothing and
queues nothing. `suplex billing` has no outbox, so a panic there is sent once,
directly, with a three-second limit.

### Gaps

- The mobile app and `suplex-bootstrap` send no exceptions. The mobile app has
  no local host and no telemetry setting, and the bootstrap wizard is a one-time
  setup program on the operator's machine. A panic there shows on the terminal
  or the device log only.
- A process that the operating system kills (out of memory, `SIGKILL`) runs no
  panic hook and leaves no report.
- A panic in a program that runs without an installation directory, such as the
  Root bridge in an unrelated shell, is not recorded, because there is no
  consent to read.
- Release builds keep function symbols but not line tables, so a frame of
  Suplex code has a file and line only where it is the panic site.
- There is no React error boundary or router error element in the web
  application. The `createRoot` handlers cover render errors.

## Accounts

The hosted account service at `suplex.sh` sends `account_signed_up` when a login
creates an account and `account_logged_in` when it reuses one. `distinct_id` is
the account ID. Properties are `provider` (`google`, `github`, or `email`),
`$lib` (`suplex-hosted`), `$groups.host` (the installation ID), and `$set.email`.
These events use the hosted outbox and need `BILLING_TELEMETRY` and
`BILLING_POSTHOG_KEY` on the hosted service. Without both, the service queues
and sends nothing, so a deployment without them shows no signups. The billing
processor pass drains the outbox.

`account_signed_up` also carries first-touch attribution when the browser has
it: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, and
`referring_domain`. The first visit to `/download`, `/start`, or `/auth/start`
that has UTM parameters or a referrer from another site keeps them in the
first-party `suplex_attribution` cookie for 30 days, next to `suplex_visitor`.
A later visit never replaces it. Each UTM value is 1 to 64 letters, digits,
spaces, or `._~+-`; other values are dropped. The referrer keeps its hostname
only, never its path or query. A request with `DNT: 1` keeps nothing.
`account_logged_in` carries no attribution. See [Suplex accounts](accounts.md).

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

The `suplex.sh/download` route ([`apps/server/src/hosted/site.rs`](../apps/server/src/hosted/site.rs)) sends `download_started` for download
requests from the install script and website. Properties are `platform`
(the requested platform, such as `macos-arm64`, `linux-x64`, or `bootstrap-macos-arm64`), `source`
(`install_script` or `browser`), and `$lib` (`suplex-web`). Each request uses a
new random `distinct_id`, so it does not link a download to a website browser
or native installation. A request with `DNT: 1` sends nothing. These service
events are separate from consented website download clicks.

## Local state

`suplex_telemetry` holds the notice time, last observed version,
the send positions (`audit_cursor`, `lifecycle_cursor`, and `event_cursor`), and
when telemetry last turned on (`exceptions_since`). `suplex_telemetry_events`
holds agent-surface events until they are sent.
Waiting exception reports are files in `exceptions/` in the installation
directory. `suplex_account.identify_sent_at` records the account merge. `suplex_telemetry_pull_requests` records
which pull requests were reported. Hosted billing has a separate analytics
outbox. None of this telemetry state is authority for a user action.
