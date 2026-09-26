# Identity and backup test retirement

The frontend and protocol tests use the running Rust server. These backend test files are removed only after their native checks pass. SQL migrations and captured fixtures remain immutable.

| TypeScript test file | Native coverage |
| --- | --- |
| `backup.test.ts` | `platform::backup::tests`: snapshot excludes credentials; OAuth tokens/codes/families are absent after restore, cursor key rotates, the same connection identity survives reapproval; provider credential table stays absent; exact health age boundary and invalid/missing verification. |
| `backup-integrity.test.ts` | `platform::backup::tests`: artifact round trip, checksums, unsafe paths, truncated archive, missing entry, unsupported version, existing destination refusal, valid archive succeeds after failures. |
| `backup-api.test.ts` | `http::routes::admin_platform::tests::administrators_create_list_download_and_restore_backups` covers list/create/download, in-place restore, preserved current session, invalid upload and unsafe/missing names. `platform::backup::tests::cross_host_restore_preserves_live_session_by_username` checks different user IDs on the two hosts with the same username and real hashed session. |

New regression checks live in `rust/tests/platform/backup.rs`, included in the native module's test context. Backup verification: seven native backup tests pass. The auth, OAuth, external-agent and avatar audit is still in progress.
