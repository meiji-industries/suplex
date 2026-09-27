# WebAuthn implementation decision

Use the high-level `webauthn-rs` passkey API and library verification rather
than a custom attestation subsystem. Current code and signed authenticator
tests live under [identity](../../rust/src/identity/).

Store serialized registration/authentication state in the challenge column and
serialized passkey state in the credential blob. Preserve account/session
identity, CSRF, one-use challenges, revocation, and counter updates.

The Rust port deliberately permits reenrollment of credentials from the retired
TypeScript server rather than preserving its credential encoding and algorithm
support. Leave old rows intact; an incompatible passkey requires reenrollment.
This does not require a schema migration. See [installation guidance](../../README.md#set-up-an-installation).

This is an implementation decision, not a current live-authentication or
packaged-release verification. Inspect the native dependency tree when packaging;
library verification does not imply that transitive native libraries are absent.
