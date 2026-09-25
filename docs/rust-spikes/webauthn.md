# WebAuthn compatibility spike

The synthetic cryptographic corpus is accepted by `@simplewebauthn/server` 13.3.2 and the Rust adapter. It uses real P-256, P-521, Ed25519, and RSA key pairs, signed assertions, and `none` attestation. Only public keys and responses are retained in `tests/fixtures/webauthn-interop.json`; the fixture generator discards private keys. Rust reads the same responses and returns the exact credential ID, raw COSE public key bytes, transports, and counter that TypeScript stores. TypeScript accepts assertions made with those Rust-returned values. This proves both storage directions for the synthetic material without reenrollment or schema changes.

| COSE algorithm | TS | Rust path | Result |
|---|---|---|---|
| EdDSA `-8` | accepted | webauthn-rs-core 0.5.4 | accepted |
| ES256 `-7` | accepted | webauthn-rs-core | accepted |
| ES512 `-36` | accepted | OpenSSL fallback | accepted |
| PS256/384/512 `-37/-38/-39` | accepted | OpenSSL fallback | accepted |
| RS256 `-257` | accepted | webauthn-rs-core | accepted |
| RS384/512 `-258/-259` | accepted | OpenSSL fallback | accepted |
| legacy RS1 `-65535` | accepted | OpenSSL fallback | accepted |

The fallback checks the same challenge, origin, RP ID hash, credential ID, user presence, user verification, signed bytes, and counter rule as the TypeScript adapter. It also checks token-binding status, authenticator-data length/extensions, user-handle type, backup-flag consistency, and RSA-PSS digest-length salt. TypeScript ignores `crossOrigin`; the signed cross-origin fixture succeeds in the fallback too. `0 → 0` counters and backup eligible/backed up credentials authenticate. Stale positive counters, bad challenges, origins, RP IDs, UV flags, signatures, token-binding statuses, and malformed `none` attestation statements are rejected. The adapter reconstructs webauthn-rs-core state from Suplex's existing challenge and credential columns; no new WebAuthn state is persisted.

Registration with direct or other non-`none` attestation is rejected for now. TypeScript verifies several such formats and configured trust roots; accepting them in Rust without that verification would weaken the current rule. Authentication of a credential already stored with those attestation formats works because Suplex stores only its public key and counter. This gap must be closed before full registration parity. A hardware authenticator, existing installation database, HTTP session flow, and restart handoff have not yet been exercised.

Checks: `node tests/fixtures/webauthn-interop.mjs`; `pnpm exec vitest run tests/webauthn-interop.test.ts` (2 passed); `cargo +1.93.1 test --manifest-path rust/Cargo.toml identity::webauthn` (3 passed); `pnpm run typecheck` and `cargo +1.93.1 clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings` (passed). Independent rerun and ceremony review by the contract parity agent passed with no blocking finding for this spike.
