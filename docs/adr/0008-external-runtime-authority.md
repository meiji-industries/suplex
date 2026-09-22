# ADR 0008: External runtime authority

## Decision

Suplex owns durable task and workflow intent, exact bindings and coordinates,
operation and turn ledgers, accepted artifacts, receipts, and audit.

Herdr owns current local pane, process, and agent status. GitHub owns current
remote refs, pull requests, checks, and merge facts.

Suplex UI and recovery derive projections from durable intent plus fresh
observations. They do not maintain a second mutable runtime copy. External
observations are persisted only as immutable evidence or receipts, never as a
cache with command authority.
