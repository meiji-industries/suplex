# Suplex agent guidance

## No mirror gates

Never make a user action depend on a local copy of external state agreeing
with its source. Observe the authoritative system when deciding whether to
act. Suplex owns task intent and authorization; native runtimes own execution
evidence; Git and GitHub own repository and delivery facts. Pane IDs, display
tokens, cached statuses, and progress receipts are observations, not authority.

Restarts, recreated panes, missing display metadata, and stale caches are
normal. Refresh, rediscover, or ignore obsolete observations automatically.
Do not require users to repair a mirror, acknowledge drift, or produce a second
receipt before continuing. For example, Herdr restarting and losing pane
tokens must not prevent archiving a task. Uncertain pane ownership means leave
that pane alone; it does not establish that the task cannot be archived.

Treat normal development changes as work to adapt to. Other developers advancing
`main`, stale PR base metadata, and merge conflicts are expected. Read the current
branch from GitHub, inspect integration with Git, resolve routine conflicts,
verify the result, and continue the authorized workflow. A changed base SHA is
not an authorization failure. Compare actual changes and integration results,
not copies of base metadata.

Prefer recovery and continued agent work over guards. Return actionable repair
work to the Coordinator instead of moving the task to `waiting_human`. Ask a
human only when a concrete decision, missing authority, or unavailable access
prevents progress that a competent developer could otherwise make. A failed
merge attempt prevents that merge; it does not by itself require human help.

Before adding or reviewing any blocking condition, identify the concrete harm
it prevents and the authoritative evidence for that harm. Keep a gate only
when it is necessary to prevent that harm, and scope it to the affected
operation. Metadata disagreement alone never qualifies. Missing evidence is
not proof of safety either; obtain evidence from the owning system instead
of substituting a mirror check.

For each feature that reads external state, test the user action with the
authoritative state unchanged and the local observation missing, stale, or
recreated after restart. Its outcome must remain the same. Test actual unsafe
conditions separately. Review every new rejection, disabled action, and retry
requirement against this rule. Fix violations at the source; do not add a
special-case bypass for each symptom.

For visible sub-agent pane delegation and its verification rules, read
`docs/agents/subagents-in-herdr-panes.md`.
For the local Herdr workflow and helper scripts, read `HERDR.md`.

## Product UI

Suplex is a dense productivity application. Its interaction and information
design should take cues from Linear and Paperclip, not from marketing sites.

Before implementing or modifying UI, read:

- `docs/interface-principles.md`
- `docs/ui-copy.md` All user-facing text follows the Simplified Technical English rules there.

Canonical UI stack:

- Tailwind CSS v4 for layout
- shadcn and ReUI components in `src/frontend/components/ui`
- Base UI primitives
- Lucide icons

Prefer an existing shadcn or ReUI component and use it as shipped. Add missing
components through the registries configured in `components.json`. Keep their
default visual styling: do not edit component styles or override them at call
sites with `className`, `style`, or Tailwind utilities. Use Tailwind only for
page-level layout and necessary sizing around components.

Prefer dense lists, toolbars, split panes, inline interaction,
keyboard-accessible controls, and contextual actions.

Do not add oversized headlines, marketing copy, gradients, decorative shadows,
large rounded containers, excessive whitespace, or a separate card for every
piece of information.

Before finishing frontend work, run the app and inspect the changed interface
with Playwright at desktop and narrow viewport sizes. Keep this inspection
focused on the changed interaction; it does not require a new automated test
or a full browser-suite run.

## Browser test budget

Browser tests are expensive. Keep the automated suite to essential happy paths:
session setup, project creation, and creating, starting, answering, editing,
cancelling, and archiving tasks.

- Use unit or integration tests for validation, failure modes, state permutations,
  and authoritative-state checks, including the no-mirror-gates cases above.
- Add browser coverage only when a critical user journey needs real browser
  behavior to prove it works and an existing smoke test does not cover it.
  State the specific gap in the change description. Prefer extending an existing
  journey over adding another browser setup.
- Keep layout, copy, settings permutations, and extra viewport checks in focused
  on-demand inspection. Repeat automated journeys at multiple widths only when
  the interaction differs, such as the core task creation flow.
- During development, run only the browser test files affected by the change,
  using a build of the current code. Run the full suite for shared app-shell,
  routing, session, or browser-test infrastructure changes, and when CI or an
  explicit verification request requires it. Docs-only changes need no browser run.
- After a passing run, rerun only for relevant edits, failures, or an unresolved
  concern. Report what ran and any remaining gap.

## Dev workflow

`mise run dev` runs the native Rust host with Vite HMR and React Fast Refresh.
Rust changes require a restart under `mise run dev`; `mise run dev:watch`
rebuilds and restarts the native host on changes. Before runtime or browser
verification, run `mise run dev:status` and reuse a stack that is already
listening. Ctrl-C in the dev terminal stops the stack; `mise run down` stops
this checkout's owned development processes from elsewhere.

Start the development stack with:

```bash
mise run dev
```

## Database migrations

Before creating or modifying database migrations, read
`docs/database-migrations.md`. Create migrations with
`pnpm migration:new <name>`; timestamped SQL files are the canonical format.
Never edit a migration file after saving it once: the dev stack applies it on
the next start (immediately under `dev:watch`), and a later edit changes its
hash and stops the server.
Need a change? Create a new migration.

## Where new code goes

- Task HTTP contracts and routes belong in `rust/src/http/contracts` and `rust/src/http/routes/tasks.rs`. Task authorization and commands belong in `rust/src/tasks/commands.rs`; metadata belongs in `rust/src/tasks/repository.rs`.
- Durable task intent and prompt ownership belong in `rust/src/coordination/root_session_store.rs`. `rust/src/coordination/root_controller.rs` coordinates Root and Worker through `rust/src/runtimes/task_harness.rs`.
- Provider runtimes live under `rust/src/runtimes`; `task_harness_registry.rs` selects by profile provider. Read-only native observation belongs in the runtime's session reader.
- `rust/src/delivery/operations.rs` observes Git and GitHub before delivery operations. Native and external evidence must not depend on a second progress receipt.
- Keep backend code in its Rust domain module. Keep domain-neutral utilities in `rust/src/shared`. Keep browser wire contracts in `src/frontend/contracts`, feature-owned frontend code under `src/frontend/features`, and global application behavior under `src/frontend/shell`.
- There is no phase engine or Temporal. Preserve admitted native messages across restart instead of replaying them. Delete dead code when you find it.
- HTTP response structs use concrete Rust types. Use `serde_json::Value` only for a payload Suplex stores without interpreting it, such as raw Advisor output, and mark that field `#[ts(type = "unknown")]`. Model every fixed string vocabulary with `wire_enum!` from `rust/src/shared/mod.rs`. Deserialize stored JSON into its Rust type before reading it.
- Browser types for a server response come from `src/frontend/contracts/generated`, written by `ts-rs` when `cargo test` runs. Add `#[derive(ts_rs::TS)]` to a response type and `#[ts(export)]` to the root type. Dependencies export automatically. Commit the generated files. CI fails on drift. Never edit a generated file. Zod schemas under `src/frontend/contracts` validate requests and serve as test-side checks of server output. Do not hand-write a response type.
- Each endpoint's fetch lives in a feature `*-api.ts` module, such as `src/frontend/features/tasks/lib/task-api.ts`, as one function typed to the generated response. `readJsonUnchecked<T>()` in `src/frontend/lib/api.ts` casts JSON to `T` without checking it. Call it only inside such a module. Do not add new direct calls from components. `scripts/rust-ratchet.ts` counts these calls and fails when the count rises.

## Agent skills

### Machine discovery and pairing

Public discovery artifacts, the paired-agent runtime, and the operator handoff:
`docs/agents/machine-discovery.md`. Serve new public artifacts from
`rust/src/http/routes/discovery.rs`. Keep them free of task and company data.

### Issue tracker

GitHub Issues on `meiji-industries/suplex` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.
