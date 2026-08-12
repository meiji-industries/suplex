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

Vite does not auto-reload all frontend changes in this repo. After editing
`src/frontend/*.tsx`, `src/app.ts`, or other server/frontend files, stop and
restart the dev server:

```bash
FORGE_TAILSCALE_ADDRESS="pro2.tail1234.ts.net" npm run forge -- stop
mise run dev
```
