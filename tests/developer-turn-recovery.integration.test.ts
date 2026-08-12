import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { deriveDeveloperExecutionId } from "../src/developer-execution-leases.js";
import { DeveloperSupervisorInvocationSchema, DeveloperSupervisorResultSchema } from "../src/developer-supervisor-protocol.js";
import { runDeveloperTurn } from "../src/developer-turn-runner.js";

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for durable Developer result");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("INV-02/INV-03/INV-05/INV-06 competing supervisors preserve one child, growing output, and one final result", async () => {
  // Keep the Unix control-socket path below macOS's AF_UNIX pathname limit.
  const root = await mkdtemp(join("/tmp", "fg-dev-"));
  const executionId = `developer_${"e".repeat(24)}`;
  const executionRoot = join(root, "developer-executions", executionId);
  const outputPath = join(root, "output.log");
  const launchCountPath = join(root, "launches.log");
  try {
    await mkdir(executionRoot, { recursive: true, mode: 0o700 });
    const fixture = fileURLToPath(new URL("./fixtures/developer-turn-child.mjs", import.meta.url));
    const invocation = DeveloperSupervisorInvocationSchema.parse({ version: 1, executionId, command: process.execPath, args: [fixture, "--duration", "400", "--output", outputPath, "--launch-count", launchCountPath], cwd: process.cwd(), env: {} });
    await writeFile(join(executionRoot, "invocation.json"), `${JSON.stringify(invocation)}\n`);
    const source = fileURLToPath(new URL("../src/developer-supervisor.ts", import.meta.url));
    const supervisor = spawn(process.execPath, ["--import", "tsx", source, executionRoot], { stdio: ["ignore", "ignore", "pipe", "pipe"] });
    const competingSupervisor = spawn(process.execPath, ["--import", "tsx", source, executionRoot], { stdio: ["ignore", "ignore", "pipe", "pipe"] });
    competingSupervisor.unref();
    let stderr = "";
    supervisor.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    supervisor.unref();
    const tokenPipe = supervisor.stdio[3];
    if (!tokenPipe || typeof tokenPipe === "string" || !("end" in tokenPipe)) throw new Error("supervisor token pipe unavailable");
    tokenPipe.end("integration-token");
    const competingTokenPipe = competingSupervisor.stdio[3];
    if (!competingTokenPipe || typeof competingTokenPipe === "string" || !("end" in competingTokenPipe)) throw new Error("competing supervisor token pipe unavailable");
    competingTokenPipe.end("integration-token");
    let result;
    try {
      result = await waitFor(async () => {
        try { return DeveloperSupervisorResultSchema.parse(JSON.parse(await readFile(join(executionRoot, "result.json"), "utf8"))); } catch { return undefined; }
      });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; supervisor stderr: ${stderr}`);
    }
    expect(result.executionId).toBe(executionId);
    expect(result.outputTruncated).toBe(false);
    expect((await readFile(outputPath, "utf8"))).toContain("completed");
    expect((await readFile(launchCountPath, "utf8")).trim().split(/\r?\n/)).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("INV-01/INV-02 retry starts the same turn after worker loss before supervisor spawn", async () => {
  const root = await mkdtemp(join("/tmp", "fg-pre-spawn-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const workflowId = "workflow_pre_spawn";
  const executionId = deriveDeveloperExecutionId(workflowId, 1, 1, "implementation");
  const worktreePath = join(root, "worktree");
  const launchCountPath = join(root, "launches.log");
  const outputPath = join(root, "output.log");
  try {
    await mkdir(worktreePath, { recursive: true });
    const now = new Date().toISOString();
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_pre_spawn', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_pre_spawn', 'company_pre_spawn', 'Project', ?, ?, 'acme/forge', 'main', 'main', '', '', '[]', '[]', '{}', 'active', ?, ?)").run(root, root, now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief_pre_spawn', 'company_pre_spawn', 'task-brief', 'brief.md', 'text/markdown', 0, ?, 'company_pre_spawn/brief.bin', ?)").run("0".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_pre_spawn', 'company_pre_spawn', 'project_pre_spawn', 'Task', 'brief_pre_spawn', '[]', '{}', 0, ?, 'revision_pre_spawn', 'pre-spawn-key', ?, ?)").run(workflowId, now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES (?, 'task_pre_spawn', 'company_pre_spawn', ?, 1, 1, 'starting', 'forge/issue/task_pre_spawn', ?, ?, ?, ?)").run(executionId, workflowId, worktreePath, "a".repeat(40), now, now);
    });
    const fixture = fileURLToPath(new URL("./fixtures/developer-turn-child.mjs", import.meta.url));
    const input = { database, config, executionId, developerAttempt: 1, planRevision: 1, turnKind: "implementation" as const, companyId: "company_pre_spawn", taskId: "task_pre_spawn", workflowId, canonicalWorktreePath: worktreePath, worktreeIdentityHash: "w".repeat(64), command: process.execPath, args: [fixture, "--duration", "100", "--output", outputPath, "--launch-count", launchCountPath], cwd: root, env: { PATH: process.env.PATH ?? "" } };
    await expect(runDeveloperTurn({ ...input, spawnSupervisor: () => { throw new Error("simulated worker loss before supervisor spawn"); } })).rejects.toThrow("simulated worker loss");
    const result = await runDeveloperTurn(input);
    expect(result.terminal).toBe("result");
    expect((await readFile(launchCountPath, "utf8")).trim().split(/\r?\n/)).toHaveLength(1);
  } finally { database.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
});
