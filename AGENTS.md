# Forge agent guidance

## No mirror gates

Never make a user action depend on a local copy of external state agreeing
with its source. Observe the authoritative system when deciding whether to
act. Forge owns task intent and authorization; native runtimes own execution
evidence; Git and GitHub own repository and delivery facts. Pane IDs, display
tokens, cached statuses, and progress receipts are observations, not authority.

Restarts, recreated panes, missing display metadata, and stale caches are
normal. Refresh, rediscover, or ignore obsolete observations automatically.
Do not require users to repair a mirror, acknowledge drift, or produce a second
receipt before continuing. For example, Herdr restarting and losing pane
tokens must not prevent archiving a task. Uncertain pane ownership means leave
that pane alone; it does not establish that the task cannot be archived.

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

Forge is a dense productivity application. Its interaction and information
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

`mise run dev` runs the Forge API and task host as one foreground
command; Vite is embedded in Fastify. Frontend changes use Vite HMR and React
Fast Refresh. Backend changes do NOT hot-reload under `mise run dev` — Ctrl-C
and rerun it (this keeps native OpenCode sessions intact while `src/` is being
edited). `mise run dev:watch` is the same stack with `tsx watch`, which restarts
the API/worker on every save. Before runtime or browser
verification, run `mise run dev:status` and reuse a stack that is already
listening. Ctrl-C in the dev terminal stops everything; `mise run down` stops
a stack from elsewhere; `mise run dev:recover` force-kills anything still
holding the dev ports.

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

- Task HTTP contracts and routes belong in `src/http/contracts/tasks.ts` and `src/http/routes/tasks.ts`. `src/tasks/tasks.ts` owns user authorization and task commands. Task metadata belongs in `src/tasks/repository.ts`.
- Durable task intent, assignments, and prompt ownership belong in `src/coordination/root-session-store.ts`. `src/coordination/root-controller.ts` coordinates Root and Worker through the `TaskHarness` seam in `src/runtimes/task-harness.ts`.
- Provider runtimes live under `src/runtimes`. `src/runtimes/task-harness-registry.ts` selects one by profile provider. Read-only observation of a native session goes through `NativeSessionReader`, never through a harness client directly.
- `src/delivery/operations.ts` observes Git and GitHub before deterministic delivery operations. Native and external evidence must not depend on a second progress receipt.
- Keep backend code in its domain folder. Keep domain-neutral utilities in `src/shared`. Keep feature-owned frontend code under `src/frontend/features` and global application behavior under `src/frontend/shell`.
- There is no phase engine or Temporal. Preserve admitted native messages across restart instead of replaying them. Delete dead code when you find it.

## Agent skills

### Issue tracker

GitHub Issues on `meiji-industries/forge` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.
