# Telemetry

Suplex release builds send product usage events to PostHog. This page lists
every event and every property. `rust/src/telemetry/mod.rs` sends nothing
else. Suplex never sends code, prompts, task titles or descriptions, company or
project names, repository names, branches, or file paths.

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
  sends it once in a `$identify` event that links the installation to that
  person. Without an address, the installation stays anonymous.

## Events

Every event has these properties: `app_version` (the build revision), `os`,
`arch`, `$lib` (`suplex-host`), and `$groups`.

| Event | Source | Extra properties |
| --- | --- | --- |
| `host_started` | first send after the host starts | none |
| `$identify`, `signed_up` | notice answered with an email | `$set.email`, `$anon_distinct_id` |
| `company_created` | audit event | none |
| `project_created` | audit event | `git_host` (`github`, `bitbucket`, or `none`), `tracker` (`github`, `jira`, or `none`) |
| `membership_added` | audit event | none |
| `workflow_created` | audit event | none |
| `task_created` | audit event | `source` (`user` or `agent`), `has_image` |
| `task_started` | audit event | none |
| `task_answered` | audit event | none |
| `task_cancelled` | audit event | none |
| `task_waiting_human` | task lifecycle | none |
| `task_delivered` | task lifecycle | `duration_s` (created to delivered) |
| `pr_opened` | a task records a pull request | `git_host` |
| `pr_merged` | the task's pull request is merged | `git_host` |
| `host_daily` | once a day | `users`, `companies`, `projects`, `tasks_running`, `tasks_created_7d` |
| `$groupidentify` | once a day per active company | `seats` (the billing seat count), `projects`, `plan` (`free`, `pro`, or `unknown` when the billing snapshot is stale) |

## Local state

`suplex_telemetry` holds the notice time, the optional email, and the send
position. `suplex_telemetry_pull_requests` records which pull requests were
reported. Neither table is authority for any user action.
