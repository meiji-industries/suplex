# MCP transport spike

`rmcp` 3.4.1 covers the transport modes used by Suplex's current MCP entrypoints.

The probe in `rust/examples/mcp_transport_spike.rs` exposes one `ping` tool. With
`stdio`, actual JSON-RPC `initialize`, `tools/list`, and `tools/call` requests
returned the tool and `pong` over stdin/stdout. With `http`, separate POSTs to
the Axum listener returned HTTP 200 `application/json` for the same operations,
without a session ID. The HTTP process used loopback port 55263 and was stopped
after the probe.

Stateless HTTP requires `NeverSessionManager` with both `json_response(true)`
and `legacy_session_mode(false)`. Leaving the legacy default enabled made
`initialize` return HTTP 500 because the never-session manager rejects session
creation. The Rust server must also retain Suplex's existing host, origin,
Bearer token, and task authorization checks before wiring any real MCP tool.

The probe establishes transport support. It does not establish route, tool,
schema, authentication, or response parity. Those need the corresponding Rust
modules and existing HTTP tests.
