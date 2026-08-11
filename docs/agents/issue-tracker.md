# Issue tracker: Local Markdown

Forge planning and implementation tickets live in `.scratch/`.

## Conventions

- One effort uses one directory: `.scratch/<feature-slug>/`.
- The effort source pointer is `.scratch/<feature-slug>/spec.md`.
- Tickets are one file each at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, ordered by dependency.
- Each ticket records `Blocked by` and `Status` near the top. `ready-for-agent` is the only initial status.
- Comments append beneath a `## Comments` heading in the relevant ticket.
