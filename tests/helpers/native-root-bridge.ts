import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { nativeFixture } from "./native-browser.js";

type Fixture = Awaited<ReturnType<typeof nativeFixture>>;

export async function nativeRootBridge(fixture: Fixture, taskId: string) {
  const sessionId = `root_${randomUUID()}`;
  const now = new Date().toISOString();
  fixture.database.prepare("UPDATE suplex_task_controls SET status = 'active', root_session_id = ?, updated_at = ? WHERE task_id = ?")
    .run(sessionId, now, taskId);
  fixture.database.prepare("INSERT INTO suplex_task_sessions (id,task_id,kind,generation,is_current,lifecycle,created_at,updated_at) VALUES (?,?,'root',1,1,'reserved',?,?)")
    .run(sessionId, taskId, now, now);
  const identity = { taskId, sessionId, generation: 1 };
  const executable = resolve(process.env.SUPLEX_RUST_BIN ?? "rust/target/debug/suplex");
  const runtime = join(fixture.directory, "root-bridge", sessionId);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const bindingPath = join(runtime, "root.binding.json");
  await writeFile(bindingPath, JSON.stringify({
    version: 1, token, root: identity,
    databasePath: fixture.config.databasePath,
    artifactRoot: fixture.config.artifactRoot,
    server: { command: executable, args: ["mcp", "root"] },
  }), { mode: 0o600 });
  return {
    identity,
    server: { command: executable, args: ["mcp", "root"], environment: { SUPLEX_ROOT_BINDING: bindingPath, SUPLEX_ROOT_TOKEN: token } },
  };
}
