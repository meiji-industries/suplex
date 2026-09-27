# JSON bytes used by persisted hashes

For maintainers changing persisted hashes, this page explains the JSON compatibility boundary and its limits.

[The Rust serializer](../../rust/src/shared/js_json.rs) produces JavaScript-like
`JSON.stringify` bytes for normalized `serde_json::Value` data. Some stored
task and agent API revisions hash those bytes. Substituting ordinary
`serde_json::to_string` can change a digest without changing the apparent JSON
value: JavaScript puts array-index object keys before other keys and formats
numbers after binary64 conversion, including exponent and negative-zero cases.
The [hash-byte fixtures](../../rust/tests/hash_bytes.rs) compare the bytes and
hex or base64url digests against recorded JavaScript output.

This is a limited compatibility boundary. The current serializer receives an
already parsed Rust value. It does not preserve raw JSON syntax, lone UTF-16
surrogates, or an overflow exponent that the Rust parser cannot represent.
Those cases were identified during the TypeScript-to-Rust investigation, but
the present fixture test does not prove HTTP acceptance parity for them.
Validation of JavaScript string lengths also needs UTF-16 code-unit counting;
the current [Worker evidence module](../../rust/src/coordination/worker_evidence.rs)
does that for its own limits. Check each new request boundary before claiming
equivalent validation across runtimes.

[Architecture index](README.md)
