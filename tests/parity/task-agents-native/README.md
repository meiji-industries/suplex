# Frozen task-agents native route fixture

Captured from `tests/support/task-agents-read-interop.ts` against the TypeScript source at revision `6bb0a43f`, before engine retirement. Batch and single-task agent reads, invalid queries, an archived task, native turn disappearance, and user revocation.

The database contains synthetic users and tasks only. The expected JSON excludes the source process path and session cookie. Rust creates a fresh session in a disposable copy, applies the same native file/row changes, and compares exact response status, headers, and JSON bodies.

SHA-256:

- `database.sqlite`: `0a5cd933487df6b324cca0502f0bf1cfd30b956c7a3689733ebbc01796df4a83`
- `expected.json`: `5f6f4b0bf9388246e19d2dde4885f6837b8d818e3bc3da7f004d8ff692d99be8`
- `runtime/2cba0339-71cc-4bd4-8ce1-09d41215103f/turn.json`: `5bffc6daebcc8073d28a10dd4bfe292755a5f8b0023f6d6a4e59b5308f8ebe86`
