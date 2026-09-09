# ADR 0010: Hermes runtime contract boundary

## Decision

`/api/hermes/openapi.json` publishes version `v1` for an already paired Hermes
agent. It includes only creator-scoped task reads, autonomous backlog task
creation, and capability discovery.

Pairing, credential rotation, revocation, and administration remain provisioning
interfaces outside this contract because their responses can contain credentials
or pairing codes. Board sessions and development login are not Hermes runtime
authority. Every published route requires a persisted, current paired-agent
credential; project grants are rechecked at admission.

Task control, delivery, merge, and human decisions are explicitly unavailable
to Hermes. The contract reports those limitations rather than exposing routes
that would imply authority.
