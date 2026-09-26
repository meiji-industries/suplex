# Frozen task detail responses

Captured from the TypeScript `tests/support/task-ui-read-interop.ts` helper at
`6bb0a43f` before engine retirement. The database and Codex transcript contain
only synthetic task data. `task-detail-read.json` records the full responses
for activity, execution, and diff summary; `$SESSION` replaces the random
session ID. The Rust test copies the database and transcript to a disposable
installation, signs in the fixture user, and compares every status, cache
header, and JSON body with the frozen responses.

SHA-256 of `task-detail-database.sqlite`:
`f23ed5c21158a8e4fb7e4a62e139c435b6bad7070be1a39da55aa8108efe4418`.
