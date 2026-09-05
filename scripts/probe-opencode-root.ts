import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ForgeDatabase } from "../src/database.js";
import { RootController } from "../src/root-controller.js";
import { TaskControlStore } from "../src/root-session-store.js";
import { OpenCodeTaskRuntime } from "../src/opencode-task-runtime.js";
import { readOpenCodeServer, openCodeServerClient, openCodeProcessAlive } from "../src/opencode-server.js";

const executable = process.argv[2];
assert.ok(executable, "Usage: tsx scripts/probe-opencode-root.ts <absolute-opencode-executable>");
const directory = await mkdtemp(join(tmpdir(), "forge-native-root-proof-"));
const database = new ForgeDatabase(join(directory, "forge.sqlite"));
const token = randomUUID();
await writeFile(join(directory, "README.md"), `Read proof ${token}\n`);
const stamp = new Date().toISOString();
database.authTransaction((db) => {
  db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(stamp);
  db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'meiji-industries/forge', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(directory, directory, stamp, stamp);
  db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief', 'text/plain', 1, ?, 'brief', ?)").run("a".repeat(64), stamp);
  db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), stamp, stamp);
});
const store = new TaskControlStore(database);
const profile = { profileId: "proof", provider: "openai", model: "gpt-5.6-luna", reasoningLevel: "max", serviceTier: "priority" } as const;
store.create({ startImmediately: true,
  taskId: "task", objective: "This is a capability probe only. Read README.md using the native read tool. Then call forge_root with kind ask_human and question equal to the exact line you read. Do not delegate Workers or request delivery operations. No GitHub action is needed.",
  deliveryTarget: "merged", deliveryIntent: { repository: "meiji-industries/forge", headBranch: `probe-${token}`, baseBranch: "main", baselineSha: "a", pullRequestNumber: null },
  rootProfile: profile, workerProfile: profile, worktree: { path: directory, branch: `probe-${token}`, baseSha: "a", headSha: "a", dirty: false },
});
const unavailable = async (): Promise<never> => { throw new Error("No display in this native bridge probe"); };
const runtime = new OpenCodeTaskRuntime(database.filename(), { getPane: async () => null, createWorkspace: unavailable, splitPane: unavailable, renamePane: async () => {}, runPaneCommand: async () => {}, reportPaneMetadata: async () => {} }, executable);
const controller = new RootController(store, runtime);
try {
  await controller.recover("task");
  const root = store.currentSession("task", "root");
  assert.ok(root?.nativeSessionId);
  const server = await readOpenCodeServer(join(directory, "runtime", "task-sessions", root.id));
  assert.ok(server);
  const client = openCodeServerClient(server);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const control = store.get("task");
    const messages = await client.getMessages(root.nativeSessionId, { directory });
    const tools = messages.flatMap((message) => message.parts.filter((part) => part.type === "tool"));
    if (control.status === "waiting_human") {
      assert.equal(control.humanQuestion, `Read proof ${token}`);
      assert.ok(tools.some((part) => part.tool === "read"));
      assert.ok(tools.some((part) => part.tool === "forge_root_forge_root"));
      process.stdout.write(`${JSON.stringify({ directory, nativeSessionId: root.nativeSessionId, question: control.humanQuestion, tools: tools.map((part) => part.tool), nativeMessages: messages.map((message) => ({ id: message.info.id, role: message.info.role })) }, null, 2)}\n`);
      break;
    }
    assert.ok(Date.now() < deadline, `Root bridge proof timed out in ${directory}`);
    await delay(250);
  }
} finally {
  const root = store.currentSession("task", "root");
  const server = root ? await readOpenCodeServer(join(directory, "runtime", "task-sessions", root.id)) : null;
  if (server && openCodeProcessAlive(server.pid)) {
    process.kill(server.pid, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (openCodeProcessAlive(server.pid) && Date.now() < deadline) await delay(50);
    assert.equal(openCodeProcessAlive(server.pid), false, "Disposable server must stop");
  }
  database.close();
}
