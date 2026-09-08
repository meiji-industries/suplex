import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { runCommand } from "../src/platform/command-runner.js";
import { ForgeDatabase } from "../src/platform/database.js";
import { CliHerdrClient } from "../src/integrations/herdr/client.js";
import { OpenCodeTaskRuntime } from "../src/runtimes/opencode/task-runtime.js";
import { readOpenCodeServer, stopOpenCodeServer } from "../src/runtimes/opencode/server.js";
import { RootController } from "../src/coordination/root-controller.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";

assert.equal(process.env.HERDR_ENV, "1", "Run this proof inside Herdr");
const directory = await mkdtemp(join(tmpdir(), "forge-native-delivery-"));
const worktree = join(directory, "repo");
await mkdir(worktree);
const git = (args: string[]) => runCommand({ command: "git", args: ["-C", worktree, ...args], taskId: null, stepId: null });
await git(["init", "-b", "proof"]);
await git(["config", "user.name", "Forge proof"]);
await git(["config", "user.email", "proof@example.invalid"]);
await writeFile(join(worktree, "README.md"), "Disposable native delivery proof.\n");
await git(["add", "README.md"]);
await git(["commit", "-m", "Initial proof"]);
const baselineSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
const database = new ForgeDatabase(join(directory, "forge.sqlite"));
const token = randomUUID();
const stamp = new Date().toISOString();
const configuration = { repository: "proof/local", repositoryPath: worktree, worktreeRoot: directory, branch: "proof", baseBranch: "main", baselineSha, startingSha: baselineSha, setupCommand: "", verificationCommand: "git diff --check", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: stamp };
database.authTransaction(db => {
  db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Proof', 'active', ?)").run(stamp);
  db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project', 'company', 'Proof', ?, ?, 'main', '', 'git diff --check', ?, ?)").run(worktree, directory, stamp, stamp);
  db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user', 'Proof', 'proof', 'admin', 'active', ?, ?)").run(stamp, stamp);
  db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, description, configuration_json, idempotency_key, request_hash, creator_user_id, created_at, updated_at) VALUES ('task', 'company', 'project', 'Native delivery proof', '', ?, 'native-proof', ?, 'user', ?, ?)").run(JSON.stringify(configuration), "a".repeat(64), stamp, stamp);
});
const store = new TaskControlStore(database);
const profile = { profileId: "proof", provider: "openai", model: "gpt-5.6-luna", reasoningLevel: "max", serviceTier: "priority" } as const;
store.create({ taskId: "task", startImmediately: true, objective: `Delegate a Worker to create proof.txt containing exactly ${token} followed by a newline. Have it verify the content, run git diff --check, and commit only proof.txt. Review its result and read proof.txt yourself. Use forge_root observe for the current worktree HEAD, then request complete_local_work with that expectedHead. This is a local_worktree target. No GitHub or remote operation is needed. Do not ask a human for approval of this disposable proof.`, deliveryTarget: "local_worktree", deliveryIntent: { repository: "proof/local", headBranch: "proof", baseBranch: "main", baselineSha, pullRequestNumber: null }, rootProfile: profile, workerProfile: profile, worktree: { path: worktree, branch: "proof", baseSha: baselineSha, headSha: baselineSha, dirty: false } });
const herdr = new CliHerdrClient();
const controller = new RootController(store, new OpenCodeTaskRuntime(database.filename(), herdr));
try {
  const deadline = Date.now() + 240_000;
  while (store.get("task").status === "active") {
    await controller.recover("task");
    assert.ok(Date.now() < deadline, `Native delivery proof timed out in ${directory}`);
    await delay(1_000);
  }
  assert.equal(store.get("task").status, "delivered", JSON.stringify(store.get("task")));
  assert.equal(await readFile(join(worktree, "proof.txt"), "utf8"), `${token}\n`);
  assert.equal((await git(["status", "--porcelain"])).stdout.trim(), "");
  const headSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
  assert.notEqual(headSha, baselineSha);
  assert.equal((await git(["show", "--format=", "--name-only", "HEAD"])).stdout.trim(), "proof.txt");
  console.log(JSON.stringify({ directory, delivered: true, headSha, localOnly: true }, null, 2));
} finally {
  const sessions = database.authQuery(db => z.array(z.object({ id: z.string(), pane_id: z.string().nullable() })).parse(db.prepare("SELECT id, pane_id FROM forge_task_sessions").all()));
  for (const session of sessions) {
    const server = await readOpenCodeServer(join(directory, "runtime", "task-sessions", session.id));
    if (server) await stopOpenCodeServer(server);
    if (session.pane_id && await herdr.getPane(session.pane_id)) await herdr.closePane(session.pane_id);
  }
  database.close();
}
