# WebAuthn compatibility spike

The synthetic cryptographic corpus is accepted by `@simplewebauthn/server` 13.3.2 and the Rust adapter. It uses real P-256, P-521, Ed25519, and RSA key pairs, signed assertions, and `none`, packed self-attestation, and certificate-backed packed attestation. Only public keys and responses are retained in `tests/fixtures/webauthn-interop.json`; the fixture generator discards private keys. Rust reads the same responses and returns the exact credential ID, raw COSE public key bytes, transports, and counter that TypeScript stores. TypeScript accepts assertions made with those Rust-returned values. This proves both storage directions for the synthetic material without reenrollment or schema changes.

| COSE algorithm | TS | Rust path | Result |
|---|---|---|---|
| EdDSA `-8` | accepted | webauthn-rs-core 0.5.4 | accepted |
| ES256 `-7` | accepted | webauthn-rs-core | accepted |
| ES512 `-36` | accepted | OpenSSL fallback | accepted |
| PS256/384/512 `-37/-38/-39` | accepted | OpenSSL fallback | accepted |
| RS256 `-257` | accepted | OpenSSL fallback for registration; core for assertion | accepted |
| RS384/512 `-258/-259` | accepted | OpenSSL fallback | accepted |
| legacy RS1 `-65535` | accepted | OpenSSL fallback | accepted |

The fallback checks the same challenge, origin, RP ID hash, credential ID, user presence, user verification, signed bytes, and counter rule as the TypeScript adapter. It also checks token-binding status, authenticator-data length/extensions, user-handle type, backup-flag consistency, and RSA-PSS digest-length salt. TypeScript ignores `crossOrigin`; the signed cross-origin fixture succeeds in the fallback too. `0 → 0` counters and backup eligible/backed up credentials authenticate. Stale positive counters, bad challenges, origins, RP IDs, UV flags, signatures, token-binding statuses, and malformed `none` attestation statements and invalid packed signatures are rejected. Packed self-attestation succeeds for ES256 and RSA, including a TS-accepted RSA case where the attestation hash algorithm differs from the credential algorithm. RSA padding follows the credential algorithm; a wrong-padding vector fails in both. The adapter reconstructs webauthn-rs-core state from Suplex's existing challenge and credential columns; no new WebAuthn state is persisted.

Certificate-backed packed and FIDO U2F signed vectors pass both verifiers. The U2F adapter enforces the zero AAGUID and retains the signed leaf when extra x5c entries are supplied. The attestation checks for Suplex's installed SimpleWebAuthn v13.3.2 caller and verifier are:

| Format | Installed SDK trust and statement branch | Rust path and evidence |
|---|---|---|
| `none` | Empty statement | Core and shared synthetic positive/negative |
| `packed` | Self signature or x5c leaf; no configured roots | Core plus RSA/hash fallback; signed positive and mutation negatives |
| `fido-u2f` | Zero AAGUID, signed leaf, no configured roots | Core with leaf-preserving adapter; signed positive and mutation negatives |
| `tpm` | pubArea/certInfo/AIK profile/signature; no configured roots | Narrow statement verifier for every TPM registration, including RS1; current signed upstream positive and signature/pubArea/certInfo negatives |
| `apple` | x5c to bundled Apple root, valid time, nonce, credential key | Core statement verification plus root chain; archived signed positive at its 2020 issue time and current expiry negative |
| `android-key` | keyDescription challenge and app scope, statement signature, full x5c chain ending in one of four bundled Google Hardware roots | Narrow SDK-equivalent statement verifier and root policy; archived software-root positive under a test-only root, mutated signature and default-root rejection. Core's additional Keymaster origin/purpose rule is not applied. |
| `android-safetynet` | JWT time, nonce, default CTS=true, leaf CN, GlobalSign chain, signature | Narrow JWT verifier and bundled root; signed controlled-root CTS=true positive, production-root rejection, CTS=false rejection, padded JWT and malformed algorithm vectors. SDK upstream's signed CTS=false sample is rejected under Suplex defaults even at its issue time. |

The certificate roots are public PEMs copied from the installed SDK package. Rooted formats check the whole supplied chain and certificate validity. The async registration path checks each certificate's first CRL distribution URL using the SDK's soft-failure rule for unavailable or malformed CRLs and caches parsed revocation lists through their `nextUpdate`; a locally served CRL revoking the leaf rejects. Challenge consumption commits before verifier/network work, the shared database lock is released during the CRL wait, and the admitted task continues if the HTTP waiter disappears. A controlled wait test proves unrelated database access and eventual persistence. TypeScript's response `id`/`rawId` equality check remains, while registration stores the credential ID inside authenticator data even if the outer ID differs; paired SDK and Rust service tests prove this behavior.

The Android Key controlled-root vector is an archived software attestation and is deliberately rejected by both production root lists. SafetyNet's CTS=true vector uses a synthetic test root; the archived SDK fixture has CTS=false. These prove signed statement logic and root enforcement but do not constitute a default-root CTS=true physical attestation. The Apple positive uses a test-local historical clock; it is expired now. Existing signed TypeScript↔Rust registration/authentication through both services and their shared SQLite database, plus an isolated TCP ceremony flow, were proven in the earlier ceremony cohort. A physical authenticator is additional evidence rather than a separate release gate.

Checks for this extension: `node tests/fixtures/webauthn-safetynet-synthetic.mjs`; `pnpm exec vitest run tests/webauthn-interop.test.ts` (7 tests); `cargo +1.93.1 test --manifest-path rust/Cargo.toml identity::webauthn` and focused Rust ceremony/HTTP tests; `pnpm run typecheck`; `cargo +1.93.1 clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings`. Final staged-snapshot counts and independent review are recorded with the cohort commit.
