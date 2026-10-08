# Frozen migration inputs

Captured from the TypeScript engine at revision `6bb0a43f` on 2026-09-26.
These are synthetic test databases, not user data. Keep the inputs immutable;
native tests copy them before migrating. The source SQL in `migrations/` is unchanged.

`apps/server/tests/platform/migrations.rs` preserves the runner and data guarantees from
`tests/migrations.test.ts`, `tests/native-cutover-migration.test.ts`, and
`tests/task-queued-migration.test.ts`. Six standalone SQL transformation cases
remain in `tests/migrations.test.ts` and use Node's built-in SQLite.

- `openrouter`: populated role session before the provider table rebuild; every field must survive.
- `identity`: internal and external agents with shared names, grants, credentials, and consumed/pending pairing codes before the identity correction; exact rows and uniqueness/foreign-key constraints are checked.
- `identity-collision`: colliding internal/external IDs must roll back rows, schema changes, and migration history.
- `cutover`: populated phase-era state must preserve users and project configuration, remove obsolete phase tables, and reopen without duplicate profiles.
- `queued`: manual, queued, archived, active, cancelled, and delivered controls plus a historical command receipt; only the intended queued status and receipt fields change, and the updated constraints still apply.

The `*-expected.json` files are results from the original TypeScript migration
runner on disposable copies. Current Rust tests never execute TypeScript.

| File | SHA-256 |
| --- | --- |
| `cutover-before.sqlite` | `9ded29ed488ba0bc15d91799f726b15c736a5a45be578b0a840406545b09357a` |
| `identity-before.sqlite` | `c4f57aab38cdba4c6d60bf9d04c52487d774029cab7852be29972b888cb5f3c6` |
| `identity-collision-before.sqlite` | `bf88037bfa20ab7c9d6a774c41984c72cd963cb7ca91a833358b190572da376b` |
| `identity-collision-expected.json` | `66fb770b4da522d9d55207e32ad4a8702f8765978c01c3fb4835d6921311b06e` |
| `identity-expected.json` | `29ec99a386fb641f8c65245043b0842dbe39c3ae2ec31c1522e12c930da6f67e` |
| `openrouter-before.sqlite` | `27ed6f2b95ee06745ade3337fe56c86587e1e97a6da610c1de2ed1e8e0f05b53` |
| `openrouter-expected.json` | `cd52b8890daaa8d7e422be21861356f47df734af61e074d3612fded64fd71a37` |
| `queued-before.sqlite` | `c900eaac0ec44eaef1c9ee1dfb73ed724e925c667f34bdd5cbee6b919c271ad7` |
