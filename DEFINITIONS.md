# Engineering definitions

Product terms live in [CONTEXT.md](CONTEXT.md). Current capabilities and limits
live in [the product guide](docs/product.md).

## Mirror gate

A mirror gate makes an operation depend on Suplex's copy of a fact agreeing
with the system that owns it. Git owns worktrees, branches, and commits.
Repository providers own pull requests, checks, and merge state. Native agent
runtimes own admitted messages and execution results. Herdr owns displays.

At a decision point, read the owning system. Refresh or discard stale
observations automatically. Suplex owns task intent, authorization, review
records, and prompt dispatch ownership; these are legitimate inputs to its
commands. A missing display or stale cached status does not establish that an
operation is unsafe.

See [the no-mirror-gates rule](AGENTS.md#no-mirror-gates) and
[delivery operations](rust/src/delivery/operations.rs).

## Unchanged observations

Repeated observation of the same external state should not create a new user
action or invalidate a command merely because a poll occurred. Record useful
observations without treating bookkeeping changes as new task intent.
