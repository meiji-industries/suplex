# WebAuthn implementation decision

Use high-level `webauthn-rs`: `WebauthnBuilder`, `start_passkey_registration`/`finish_passkey_registration`, and the corresponding authentication methods. Use the library's supported algorithms/options with attestation `none` and required user verification.

The 0.5.4 high-level probe accepts signed ES256 and RS256 registration and rejects EdDSA. The user explicitly accepts adaptation or reenrollment because they are the sole passkey user. Do not retain a core adapter, historical algorithm fallback, or custom attestation subsystem to preserve the old behavior.

Store serialized library registration/authentication state in the existing challenge column and serialized Passkey state in the existing credential blob. Preserve account/session identity, CSRF, one-use challenges, revocation, and counter updates. Leave old credential rows intact; an incompatible passkey requires reenrollment. This is an explicit exception to cross-backend credential compatibility, with no schema migration.

The high-level integration passes freshly signed registration and authentication, database reopen, counter updates from 7 to 8, equal-counter rejection, and challenge replay rejection. A separate isolated TCP check verifies the raw user response, session/CSRF cookies, and registration completion after its waiter disconnects. The tests use an ephemeral P-256 authenticator; no historical credential compatibility is claimed. Both signed checks pass locally and are configured to run explicitly in Rust CI and the local parity command; hosted CI has not run.

Remove direct OpenSSL, x509-parser, CBOR storage glue, custom roots and revocation code. Use library verification for incoming formats. OpenSSL remains a transitive dependency of the WebAuthn library, so packaging must inspect the actual native dependency tree. This decision records the Rust port work; current behavior is implemented under `rust/src/identity` and verified by its Rust tests.
