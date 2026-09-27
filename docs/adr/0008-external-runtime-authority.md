# ADR 0008: External runtime authority

Original decision amended 2026-09-27 to distinguish task intent from native
execution and remove receipt language that could be read as a second authority.

## Decision

Suplex owns task intent, authorization, configuration, review records, native
session assignment, and prompt dispatch ownership. Native agent runtimes own
admitted messages, tool execution, and turn results. Git owns local repository
facts. Repository providers own remote branches, pull requests, checks, and
merges. Herdr owns display attachments and pane observations.

UI and recovery combine Suplex-owned intent with observations from those
systems. A saved observation can help locate work, but cannot replace an
owner read when deciding whether an operation is safe. Display loss does not
establish execution failure or prevent archive.

See [the engineering rule](../../AGENTS.md#no-mirror-gates) and
[recovery behavior](../recovery-hardening.md).
