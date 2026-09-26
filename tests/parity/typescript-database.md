# Frozen TypeScript database

`typescript-database.sqlite` was created by the TypeScript `SuplexDatabase` at
`6bb0a43f` on the `feature/rust-engine` branch. It contains the 149 migrations
available at that revision and one synthetic company (`ts-interop`). No user
installation data is included. SHA-256:
`090cd70e36111f3e62beef4b2f17ebb8e5346b522cf7abe6cde41a054754cf20`.

The Rust compatibility test opens this file read-only, verifies its migration
ledger, and migrates a disposable copy. Keep this file unchanged as new
migrations are added.
