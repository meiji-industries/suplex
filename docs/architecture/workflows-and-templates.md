# Workflows, presets, and task templates

For contributors designing task intake, this page explains which parts of a
repeatable task are reusable and which belong to one execution. Sources:
[workflow definitions](../../rust/src/coordination/workflows.rs),
[named presets](../../rust/src/coordination/workflow_records.rs),
[task templates](../../rust/src/tasks/templates.rs), and
[task creation form](../../src/frontend/features/tasks/new-task-dialog.tsx).

## Three kinds of reuse

A built-in workflow defines the role sequence: who plans, who implements, and
which independent review participates. The [product guide](../product.md#workflows-and-delivery)
owns the catalog of five workflows. Coordinator and Worker are responsibilities;
a profile selects the agent tool and model for a role. "Senior" and "junior"
describe the intended division of work, not a measured model capability.

A workflow preset gives one built-in workflow a reusable name, description,
and defaults for profiles, delivery, and verification. It cannot add arbitrary
steps or new role types. For example, a team can name a Second opinion preset
and select its Reviewer without implementing a workflow engine.

A task template saves recurring work within a project. It includes the task
description, workflow, role profile selections, delivery target, project-test
setting, and visual-check setting. Saving an existing task as a template copies
that configuration. It does not clone its conversation, worktree, commits,
question history, or completed reviews.

## Reuse at intake

Applying a template fills the task creation form. The person creating the task
can adjust the resulting fields before submission. The task title, issue or PR
source, attachments, and prerequisites are separate task input; they are not
part of the saved template configuration. A template records the built-in
workflow selection, not a live subscription to a named preset's future edits.

Projects select default Coordinator, Alt Coordinator, and Worker profiles.
Plan A inherits the selected Coordinator. Plan B, Reviewer, and Rater inherit
the project Alt Coordinator unless the workflow or task selects a profile.
Workflow presets store these as inherited selections by leaving the advisor
profile unset.

Creation captures the resulting configuration for that task. Later edits to a
template or preset do not rewrite an admitted task's history or native prompt.
See [coordination](coordination.md) for captured intent and explicit task edits.
Project instructions and the task description supply domain-specific guidance;
the proposed layered prompt editor is [unimplemented work](../proposals.md#editable-prompt-guidance).

Workflow-specific constraints still apply when defaults are resolved. Pull
request repair requires a PR source and selects a merged delivery target. Its
`runProjectTests` resolves like other workflows; without project tests, the pull
request's CI is the verification evidence. Those are the implementation's definition of that workflow,
not a general restriction on people editing or merging independently.

## Workflow diagrams

The New Task preview and [workflow settings cards](../../src/frontend/features/settings/workflow-settings.tsx)
show the selected built-in workflow. A named preset uses its underlying
workflow's diagram and supplies its own task defaults.
The diagram does not define execution: [Rust workflow rules](../../rust/src/coordination/workflows.rs)
and [coordination](coordination.md) own role handoffs and delivery decisions.
The task detail plan also renders the shared illustration. Neither view is a
runtime state machine.

[The illustration](../../src/frontend/features/tasks/workflow-illustration.tsx)
renders labels, agent selectors, arrows, and theme colors. It positions nodes
and routes from [checked-in geometry](../../src/frontend/features/tasks/workflow-layouts.json).
The [layout generator](../../rust/examples/workflow_layout.rs) uses ELK's layered
algorithm to produce wide and compact layouts. It adds the visible return
routes and aligns the pull request repair terminal node after layout. The app
reads the generated JSON; it does not run ELK or cache a layout per task.

After changing a built-in diagram's nodes, edges, or spacing, regenerate both
layouts and review the resulting SVG at desktop and narrow widths:

```bash
cargo run --manifest-path rust/Cargo.toml --example workflow_layout --quiet > .context/workflow-layouts.json
mv .context/workflow-layouts.json src/frontend/features/tasks/workflow-layouts.json
pnpm exec vitest run --project unit tests/workflow-illustration.test.tsx
```

## Intake from existing tools

GitHub trigger rules select a workflow preset and create work from labeled open
pull requests. A trigger is an intake mechanism, not another workflow step or
a general GitHub Actions integration. See the
[trigger implementation](../../rust/src/integrations/github_triggers.rs) and
[product integration limits](../product.md#integrations).

A paired agent can discover permitted templates and workflows and create tasks
within its project grants and task policy. A bot can turn supplied meeting notes
into task descriptions before calling Suplex. Meeting capture and transcription
remain outside Suplex. The [agent API](../agent-api.md) owns this contract,
including discovery, idempotency, and the distinction between reading tasks and
mutating tasks the caller created.

[Architecture index](README.md)
