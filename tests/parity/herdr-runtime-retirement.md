# Herdr and runtime locator backend test retirement

The retired TypeScript Herdr tests are replaced by native tests against the Rust implementation and disposable CLI children. No Herdr service or TypeScript backend is launched by these checks.

| Former test file | Native checks |
| --- | --- |
| `herdr-client.test.ts` | `integrations::herdr::tests` verifies process/pane identity, argv without shell interpolation, pane layout and sizing, native-row and Unicode viewport sizing, strict JSON envelopes, missing-resource probes from stdout/stderr, error/timeout classification, empty `pane run` success, and metadata set/clear arguments. |
| `herdr-readiness.test.ts` | `integrations::herdr_readiness::tests` verifies healthy, missing CLI, unreachable API, private protocol mismatch, incomplete diagnostics, ambiguous probes, text status, and redacted socket paths. The missing CLI case also executes a real missing binary probe. |
| `herdr-terminal-bridge.test.ts` | `integrations::herdr_bridge::tests` verifies record parsing; control argv, NDJSON input, release and takeover; read-only snapshot and live sequence; observer width growth/replacement and recovery after unexpected exit. All child processes and pane files are disposable. |
| `runtime-locators.test.ts` | `coordination::root_bridge::tests::root_binding_tracks_current_identity_and_reuses_valid_token` verifies native `suplex mcp root` location, current identity, reused UUID token, invalid identity refusal, and 0700/0600 directory/binding permissions. |

Read-only observer loss or replacement does not close the bridge or require a user to repair pane observations. The checks assert Herdr's actual child and CLI responses rather than comparing cached pane metadata.
