# Frozen task-history native route fixture

Captured from `tests/support/task-history-read-interop.ts` against the TypeScript source at revision `6bb0a43f`, before engine retirement. History page, WebSocket snapshot, new native turn, reconnect, and shutdown close frame.

The database contains synthetic users and tasks only. The expected JSON excludes the source process path and session cookie. Rust creates a fresh session in a disposable copy, applies the same native file/row changes, and compares exact response status, headers, and JSON bodies.

SHA-256:

- `database.sqlite`: `3a927f2c966b8d1e3ffd8c5437dde7e39e12067514e8c0b5a88dc622a9e37879`
- `expected.json`: `34ac8b76d7aa5886ae318228421636a1d2f9c73c3e5360927bf5974eb238859b`
- `runtime/9ea54b37-9c6d-43af-b4bf-c989163cfdba/turn-msg_history.jsonl`: `517642c568aadb3beb761d235f04f1973280db33da423877d930916bb92305fa`
- `runtime/9ea54b37-9c6d-43af-b4bf-c989163cfdba/turn-msg_second.jsonl`: `b2aab4adaac440b976994673a95662ac1c446ebe463cdc4de569c2046b5fa6fd`
- `turn-msg_third.jsonl`: `7b4e71e132b112829832d6e737a254576d1e85f6c815d36aaf5b75e1db6bcf60`
