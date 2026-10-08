# Identity and backup test retirement

The frontend and protocol tests use the running Rust server. These backend test files are removed only after their native checks pass. SQL migrations and captured fixtures remain immutable.

| TypeScript test file | Native coverage |
| --- | --- |
| `backup.test.ts` | `platform::backup::tests`: snapshot excludes credentials; OAuth tokens/codes/families are absent after restore, cursor key rotates, the same connection identity survives reapproval; provider credential table stays absent; exact health age boundary and invalid/missing verification. |
| `backup-integrity.test.ts` | `platform::backup::tests`: artifact round trip, checksums, unsafe paths, truncated archive, missing entry, unsupported version, existing destination refusal, valid archive succeeds after failures. |
| `backup-api.test.ts` | `http::routes::admin_platform::tests::administrators_create_list_download_and_restore_backups` covers list/create/download, in-place restore, preserved current session, invalid upload and unsafe/missing names. `platform::backup::tests::cross_host_restore_preserves_live_session_by_username` checks different user IDs on the two hosts with the same username and real hashed session. |

New regression checks live in `apps/server/tests/platform/backup.rs`, included in the native module's test context. Backup verification: seven native backup tests pass. Identity verification: 20 tests pass. HTTP route verification: 68 tests pass. The OAuth SDK test passes against Rust, and all seven browser files pass (11 tests).

| TypeScript test file | Native coverage |
| --- | --- |
| `auth.test.ts` | `identity::auth`, `identity::admin`, and `identity::companies` cover session hashing/sign-out/rollover, identity normalization, raw audit metadata, live membership scope, audited renames, and revocation. `identity::ceremony` now also checks bootstrap replacement/expiry/single use, invalid signed response rejection, real signed recovery, prior admin session/credential revocation, preserved recovery audit metadata, and rejection of nonlocal HTTP passkey origins. |
| `auth-api.test.ts`, `auth-routes.test.ts` | `http::routes::{auth,admin_identity,companies,health,update}::tests`, `http::access`, and `http::session::tests` cover body/CSRF/authority ordering, session cookie bytes, sign-out, anonymous/member/admin/company scope, encoded and repeated cookies, loopback/direct/Serve Tailnet trust. Passkey HTTP routes are retired and return 404. Hosted account login tests use isolated TCP listeners to verify browser binding, secure session cookies, and live company membership; auth browser coverage uses the Rust host. |
| `avatars-api.test.ts` | `http::routes::avatars::tests::avatars_share_one_table_directory_and_image_route` retains shared user/company/project/agent storage, upload validation, scope, removal, and repository favicon fallback. |
| `external-agents.test.ts` | Six `identity::external_agents::tests` cover canonical identity/extension transaction, hashed one-time pairing and separate-connection races, duplicate names, admin scope, cross-company database constraints, atomic grant replacement, deny-all, reissue, rotation/revocation, indistinguishable invalid/expired/replaced codes, repeated client profile names, and explicit audit actor IDs. |
| `external-agents-api.test.ts` | `http::routes::external_agent_administration::tests` exercises the full admin CRUD/pair/scope/reissue/rotate/revoke lifecycle and live authorization/validation order. |
| `oauth-mcp.test.ts` | The official MCP SDK test remains in TypeScript and starts Rust through `nativeFixture`. It checks discovery, authorization-code flow, tools, task ownership, create/read/conditional poll, validation, and refresh. Four native `http::routes::oauth::tests` cover discovery/DCR, consent/PKCE, rotation/replay/revocation/reapproval, denial, CSRF, live host/agent/grant authority, durable state, same-name client isolation and per-source throttling. |

`tests/agent-api.test.ts` is tracked separately in `agent-api-retirement.md`; its retirement is not claimed by this audit. The former fake WebAuthn adapter is removed; Rust tests use an in-process software authenticator for signed ceremonies.
