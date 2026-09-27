# Frozen task-template native route fixture

Captured from `tests/support/task-template-read-interop.ts` against the TypeScript source at revision `6bb0a43f`, before engine retirement. Project template list order and normalized stored configuration.

The database contains synthetic users and tasks only. The expected JSON excludes the source process path and session cookie. Rust creates a fresh session in a disposable copy, applies the same native file/row changes, and compares exact response status, headers, and JSON bodies.

SHA-256:

- `database.sqlite`: `97772a27c6b5b1ded788ed66feccf76cc9f593aaa91885b6e9ea2132556e3f4d`
- `expected.json`: `c23c42d4b6a939645234eb59a987c6eed7a46538a105b05049b00c8ea9ab15db`
