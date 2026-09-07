# Forge agent guidance

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
with the Playwright browser proof at desktop and narrow viewport sizes.

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

- Task HTTP contracts and routes belong in `src/http/contracts/tasks.ts` and `src/http/routes/tasks.ts`. `src/tasks.ts` owns user authorization and task commands.
- Task metadata belongs in `src/task-repository.ts`. Durable task intent, assignments, and prompt ownership belong in `src/root-session-store.ts`.
- `src/root-controller.ts` coordinates Root and Worker through the `TaskHarness` seam in `src/task-harness.ts`. `src/opencode-task-runtime.ts` and `src/claude-code-task-runtime.ts` own native runtime calls; `src/task-harness-registry.ts` selects one by profile provider. Read-only observation of a native session goes through `NativeSessionReader`, never through a harness client directly.
- `src/delivery-operations.ts` observes Git and GitHub before deterministic delivery operations. Native and external evidence must not depend on a second progress receipt.
- There is no phase engine or Temporal. Preserve admitted native messages across restart instead of replaying them. Delete dead code when you find it.
- If `tests/architecture-guardrails.test.ts` line budgets fail, move code into the per-domain modules instead of raising the budget.

## Agent skills

### Issue tracker

GitHub Issues on `meiji-industries/forge` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.
