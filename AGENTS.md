# Forge agent guidance

## Product UI

Forge is a dense productivity application. Its interaction and information
design should take cues from Linear and Paperclip, not from marketing sites.

Before implementing or modifying UI, read:

- `docs/interface-principles.md`

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

`mise run dev` runs Temporal, the Forge API, and the worker as one foreground
command; Vite is embedded in Fastify. Frontend changes use Vite HMR and React
Fast Refresh; backend changes restart the API/worker automatically via
`tsx watch` — no restart command is needed. Before runtime or browser
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

## Where new code goes (anti-hub rules)

- A new issue command = one `defineIssueCommand` in `src/commands/definitions/<domain>.ts` + one `setHandler` in `src/temporal/workflow/register-<domain>.ts`. NEVER edit routes, service wrappers, the workflow port, contract enums, or frontend action types for a command — they derive from the registry.
- A new workflow state field goes in its owning `src/temporal/contracts/state/<domain>.ts` fragment, APPENDED LAST in that fragment (serialized order is frozen; `tests/task-creation-recovery.test.ts` pins it).
- A new activity = one signature in `src/temporal/contracts/activities/<domain>.ts` + one implementation in `src/temporal/activities/<domain>.ts`. Never add stubs to test fakes — pass overrides to `createIssueActivitiesFake`.
- A new phase goes in `src/issue-phases.ts` only.
- A new replay scenario = one file in `tests/replay-scenarios/` + one line in its index.
- Temporal update names, patch strings, `setHandler` order, and `durableCommand` kind strings are FROZEN. `tests/temporal-contract-pins.test.ts` and `tests/issue-command-executor.test.ts` enforce this — if they fail, your change is wrong, not the tests.
- If `tests/architecture-guardrails.test.ts` line budgets fail, move code into the per-domain modules instead of raising the budget.
