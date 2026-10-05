# task-response-native parity fixture

The full raw `GET /api/tasks/:id` response was captured from the synthetic `nativeApp` TypeScript fixture at source revision `6bb0a43f`. The Rust test copies the SQLite snapshot, creates a fresh session for its fixture user, and compares the complete response bytes and status. No real provider or repository data is present.

SHA-256:

- `database.sqlite`: `4c633a9ef6c18eaea78503754e0a1e859c2ae7b8991af3ac126d5c2661522641`
- `expected.json`: `8c3d24dfc106efd74372bf774edfdc0d9d377fb422190c1d24a5002b96799216`
