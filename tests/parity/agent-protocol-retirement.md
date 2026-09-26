# Paired agent protocol test retirement

| Retired TypeScript suite | Native coverage |
| --- | --- |
| `agent-machine-discovery.integration` | `http::routes::discovery::tests::public_artifacts_are_anonymous_secret_free_and_name_closed_runtime_routes` and `http::routes::agent_api::tests::a_paired_agent_follows_the_public_map_without_the_web_application` cover public artifact discovery, pairing, authenticated OpenAPI and idempotent backlog creation. Agent API/identity tests cover grant secrecy, unavailable commands and no execution on read/create; HTTP logging tests preserve credential redaction. |
| `suplex-mcp-bridge` | `integrations::suplex` has six passing checks for tool/OpenAPI schema alignment, stdio bridge operations, OAuth transport, settings errors and secret-safe credential refusal. The real loopback bridge journey now removes profile metadata and verifies unchanged grants; it also runs the shipped Python client against `/api/hermes/me`. The official MCP SDK test remains in TypeScript against the native host. |

Verification: the six native Suplex integration checks, public discovery and paired-agent journey all passed. The local fixture uses no provider account.
