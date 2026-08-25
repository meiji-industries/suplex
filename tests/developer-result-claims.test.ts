import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { claimDeveloperResult } from "../src/developer-result-claims.js";

async function fixture(): Promise<{ database: ForgeDatabase; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "forge-developer-claims-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'owner/repo', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(now, now);
    for (const id of ["brief", "delivery", "evidence"]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company', 'test', ?, 'application/json', 1, ?, ?, ?)").run(id, `${id}.json`, id.repeat(64).slice(0, 64), `${id}.json`, now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("a".repeat(64), now, now);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES ('execution', 'task', 'company', 'workflow', 1, 1, 'running', 'issue/task', '/worktrees/task', ?, ?, ?)").run("b".repeat(40), now, now);
  });
  return { database, root };
}

const first = { developerExecutionId: "execution", outcome: "completed" };
const claim = (resultHash: string | null, activityResult = first) => ({ executionId: "execution", claimKey: "developer:execution", resultHash, activityResult, deliveryArtifactId: "delivery", evidenceArtifactId: "evidence" });

test("returns the original activity result for a same-hash Developer retry", async () => {
  const { database, root } = await fixture();
  try {
    expect(claimDeveloperResult(database, claim("a".repeat(64)))).toEqual(first);
    expect(claimDeveloperResult(database, claim("a".repeat(64), { developerExecutionId: "execution", outcome: "blocked" }))).toEqual(first);
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_developer_result_claims").get())).toEqual({ count: 1 });
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("records a conflict and returns the first result for a differing Developer result hash", async () => {
  const { database, root } = await fixture();
  try {
    claimDeveloperResult(database, claim("a".repeat(64)));
    expect(claimDeveloperResult(database, claim("b".repeat(64), { developerExecutionId: "execution", outcome: "blocked" }))).toEqual(first);
    expect(database.authQuery((db) => db.prepare("SELECT existing_result_hash, conflicting_result_hash FROM forge_developer_result_conflicts").get())).toEqual({ existing_result_hash: "a".repeat(64), conflicting_result_hash: "b".repeat(64) });
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("returns the original result when a legacy claim has no hash", async () => {
  const { database, root } = await fixture();
  try {
    expect(claimDeveloperResult(database, claim(null))).toEqual(first);
    expect(claimDeveloperResult(database, claim("a".repeat(64), { developerExecutionId: "execution", outcome: "blocked" }))).toEqual(first);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
