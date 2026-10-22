# Suplex agent guidance

For product claims, requirements discovery, or marketing research, read
[the product guide](docs/product.md), then verify behavior in current code.
Treat proposals and dated implementation records as context, not shipped requirements.
For runtime, Herdr, coordination, or recovery changes, start with
[the current architecture](docs/architecture/README.md) and follow its source links.

Suplex is a copilot: users can edit, adjust, or merge work directly. Adapt to
current intent and external state. Delivery targets guide agent work; do not add
target-based enforcement or mandatory evidence packets from inferred requirements.

## No mirror gates

Read [the engineering principles](docs/architecture/principles.md) before adding
or reviewing guards, blockers, recovery paths, or human escalation.

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

For product demo videos, brand-kit renders, and launch posts, read
`docs/media/feature-clips/README.md`.
For visible sub-agent pane delegation and its verification rules, read
`docs/agents/subagents-in-herdr-panes.md`.
For the local Herdr workflow and helper scripts, read `docs/herdr.md`.

## Product UI

Suplex is a dense productivity application. Its interaction and information
design should take cues from Linear and Paperclip, not from marketing sites.

Before implementing or modifying UI, read:

- `docs/interface-principles.md`
- `docs/ui-copy.md` All user-facing text follows the Simplified Technical English rules there.

Canonical UI stack:

- Tailwind CSS v4 for layout
- shadcn and ReUI components in `apps/web/components/ui`
- Base UI primitives
- Lucide icons

Prefer an existing shadcn or ReUI component and use it as shipped. Add missing
components through the registries configured in `apps/web/components.json`. Keep their
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
Web unit tests live in `apps/web/tests`. Cross-app tests (interop, parity,
migrations, browser) live in `tests/`.

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

Each directory in `apps/` is one program that Suplex ships:

- `apps/server`: the `suplex` crate. It holds the host, `suplex hosted serve`, the MCP bridges, and the CLI.
- `apps/web`: the React client, the `suplex-web` pnpm package. Its own `package.json`, `vite.config.ts`, `tsconfig.json`, and `vitest.config.ts` build and test it; `pnpm --filter suplex-web build` writes `apps/web/dist`, which the `suplex` crate embeds. Web unit tests go in `apps/web/tests`.
- `apps/desktop` and `apps/mobile`: the Tauri shells. Each crate is in its `src-tauri`.
- `apps/bootstrap`: the `suplex-bootstrap` VM wizard. It embeds the scripts in `vm/` into its binary.

`apps/desktop`, `apps/mobile`, and `apps/bootstrap` never depend on the `suplex` crate.

The root `package.json` holds workspace scripts and the tooling for `scripts/` and lint. The root `tests/` holds cross-app tests: browser, interop, parity, migration, and repository guardrail tests.

When a second app needs the same code, move that code into a crate or package in `packages/`.
Each Rust crate is a member of the root Cargo workspace. Declare a dependency in
`[workspace.dependencies]` when more than one crate uses it. Run cargo with
`-p <crate>`, never with `--workspace`: that unifies features with the Tauri crates.

- Task HTTP contracts and routes belong in `apps/server/src/http/contracts` and `apps/server/src/http/routes/tasks.rs`. Task authorization and commands belong in `apps/server/src/tasks/commands.rs`; metadata belongs in `apps/server/src/tasks/repository.rs`.
- Durable task intent and prompt ownership belong in `apps/server/src/coordination/root_session_store.rs`. `apps/server/src/coordination/root_controller.rs` coordinates Coordinator and Worker through `apps/server/src/runtimes/task_harness.rs`.
- Provider runtimes live under `apps/server/src/runtimes`; `task_harness_registry.rs` selects by profile provider. Read-only native observation belongs in the runtime's session reader.
- `apps/server/src/delivery/operations.rs` observes Git and GitHub before delivery operations. Native and external evidence must not depend on a second progress receipt.
- The hosted process (`suplex hosted serve`: billing, accounts, and the `suplex.sh` site) starts in `apps/server/src/hosted`. Hosted account flows live in `apps/server/src/accounts/hosted`; the private host's account client and link live in `apps/server/src/accounts/mod.rs`, with the shared wire in `apps/server/src/accounts/wire.rs`. The login view lives in `apps/web/features/account`.
- Keep backend code in its Rust domain module. Keep domain-neutral utilities in `apps/server/src/shared`. Keep browser wire contracts in `apps/web/contracts`, feature-owned frontend code under `apps/web/features`, and global application behavior under `apps/web/shell`.
- Values the browser receives without polling come from the company sync feed in `apps/server/src/sync.rs`, sent by `apps/server/src/http/routes/sync.rs` as `SyncMessage` frames. Read `docs/architecture/sync.md` before you add a pushed value. A pushed value is a display observation; never gate a command on it.
- There is no phase engine or Temporal. Preserve admitted native messages across restart instead of replaying them. Delete dead code when you find it.
- HTTP response structs use concrete Rust types. Use `serde_json::Value` only for a payload Suplex stores without interpreting it, such as raw Advisor output, and mark that field `#[ts(type = "unknown")]`. Model every fixed string vocabulary with `wire_enum!` from `apps/server/src/shared/mod.rs`. Deserialize stored JSON into its Rust type before reading it.
- Browser types for a server response come from `apps/web/contracts/generated`, written by `ts-rs` when `cargo test` runs. Add `#[derive(ts_rs::TS)]` to a response type and `#[ts(export)]` to the root type. Dependencies export automatically. Commit the generated files. CI fails on drift. Never edit a generated file. Zod schemas under `apps/web/contracts` validate requests and serve as test-side checks of server output. Do not hand-write a response type.
- Each endpoint's fetch lives in a feature `*-api.ts` module, such as `apps/web/features/tasks/lib/task-api.ts`, as one function typed to the generated response. `readJsonUnchecked<T>()` in `apps/web/lib/api.ts` casts JSON to `T` without checking it. Call it only inside such a module. ESLint rejects the call anywhere else; files in `legacyUncheckedReads` in `eslint.config.ts` predate the rule. Remove a file from that list when you move its calls. Do not add files.

## Agent skills

### Machine discovery and pairing

Public discovery artifacts, the paired-agent runtime, and the operator handoff:
`docs/agents/machine-discovery.md`. Serve new public artifacts from
`apps/server/src/http/routes/discovery.rs`. Keep them free of task and company data.

### Issue tracker

GitHub Issues on `meiji-industries/suplex` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.
