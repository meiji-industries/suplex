import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { reconcileDeveloperExecutions, type DeveloperProcessController } from "../src/developer-recovery.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-developer-recovery-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', ?, ?, 'acme/forge', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(root, root, now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief_1', 'company_1', 'task-brief', 'brief.md', 'text/markdown', 0, ?, 'company_1/brief.bin', ?)").run("0".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', 'brief_1', '[]', '{}', 0, 'workflow_1', 'revision_1', 'recovery-key', ?, ?)").run(now, now);
  });
  return { root, database };
}

function running(database: ForgeDatabase, id: string, pid: number): void {
  const now = new Date().toISOString();
  database.authQuery((db) => db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, process_pid, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES (?, 'task_1', 'company_1', 'workflow_1', 1, 1, 'running', ?, 'forge/issue/task_1', '/tmp/forge-worktree-task_1', ?, ?, ?)").run(id, pid, "a".repeat(40), now, now));
}

const dead: DeveloperProcessController = { inspect: async () => undefined, signalGroup: async () => undefined };
const live: DeveloperProcessController = { inspect: async (pid) => ({ pid, processGroupId: pid, processStartIdentity: `${pid}:started`, command: "codex" }), signalGroup: async () => undefined };

test("a dead Builder is marked failed so the workflow can retry", async () => {
  const value = await fixture();
  try {
    const id = `developer_${"a".repeat(24)}`;
    running(value.database, id, 101);
    expect(await reconcileDeveloperExecutions(value.database, dead)).toEqual([{ executionId: id, status: "failed", reason: "process-missing" }]);
    expect(value.database.authQuery((db) => db.prepare("SELECT status, failure_code AS failureCode, failure_summary AS failureSummary FROM forge_developer_executions WHERE id = ?").get(id))).toEqual({ status: "failed", failureCode: "developer-process-missing", failureSummary: "Builder process is no longer running." });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("a live Builder survives worker recovery unchanged", async () => {
  const value = await fixture();
  try {
    const id = `developer_${"b".repeat(24)}`;
    running(value.database, id, 102);
    expect(await reconcileDeveloperExecutions(value.database, live)).toEqual([{ executionId: id, status: "active", reason: "process-alive" }]);
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_developer_executions WHERE id = ?").get(id))).toEqual({ status: "running" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});
