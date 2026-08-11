# Forge agent guidance

## Product UI

Forge is a dense productivity application. Its interaction and information
design should take cues from Linear and Paperclip, not from marketing sites.

Before implementing or modifying UI, read:

- `docs/interface-principles.md`

Canonical UI stack:

- Tailwind CSS v4
- source-owned shadcn/Rhea-style components in `src/frontend/components/ui`
- Base UI primitives
- Lucide icons

Prefer application primitives and dense lists, toolbars, split panes, inline
interaction, keyboard-accessible controls, and contextual actions. Reuse
existing components before creating new ones.

Do not add oversized headlines, marketing copy, gradients, decorative shadows,
large rounded containers, excessive whitespace, or a separate card for every
piece of information.

Before finishing frontend work, run the app and inspect the changed interface
with the Playwright browser proof at desktop and narrow viewport sizes.
