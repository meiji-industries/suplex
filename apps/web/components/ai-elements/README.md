# AI Elements

Tool, Plan, Prompt Input, Test Results, and Shimmer come from the [Vercel AI Elements source](https://github.com/vercel/ai-elements/tree/main/packages/elements/src).
Code Block comes from the [AI Elements registry](https://registry.ai-sdk.dev/code-block.json).

`prompt-input.tsx` is the current [AI Elements PromptInput registry source](https://ai-sdk.dev/elements/api/registry/prompt-input.json).
Its only adaptations are Suplex import paths, Base UI compatibility wrappers in
`prompt-input-primitives.tsx`, and `Array.from` for this project's DOM iterable
TypeScript configuration. `input-group.tsx` is the shipped Base Vega source
with Suplex import paths. The task composer disables attachment intake.

Other local adaptations use Suplex imports, Base UI Collapsible instead of Radix,
and explicit optional types for this project's TypeScript configuration.
Code Block cancels obsolete highlighting updates when its input changes.
Component styles remain upstream defaults.

These components render observations and message controls. They do not control task execution.
