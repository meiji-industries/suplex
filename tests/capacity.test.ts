import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { CapacityManager } from "../src/capacity.js";
import { ForgeDatabase } from "../src/database.js";

test("INV-14 developer capacity stays held through a live ledger and releases once after it ends", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-capacity-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    const now = "2026-08-12T00:00:00.000Z";
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-capacity', 'Capacity', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-capacity', 'company-capacity', 'Capacity', ?, ?, 'main', 'main', '', '', '[]', '[]', '{}', 'active', ?, ?)").run(root, join(root, "worktrees"), now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-capacity', 'company-capacity', 'task-brief', 'brief.md', 'text/markdown', 0, ?, 'capacity/brief.bin', ?)").run("0".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task-capacity', 'company-capacity', 'project-capacity', 'Capacity', 'brief-capacity', '[]', '{}', 0, 'workflow-capacity', 'missing', 'capacity-key', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES ('developer_capacity_execution', 'task-capacity', 'company-capacity', 'workflow-capacity', 1, 1, 'running', 'forge/issue/task-capacity', ?, ?, ?, ?)").run(join(root, "worktrees", "task-capacity"), "a".repeat(40), now, now);
    });
    const capacity = new CapacityManager(database, { externalTurnCapacity: 1 });
    const first = capacity.request({ companyId: "company-capacity", taskId: "task-capacity", workflowId: "workflow-capacity", turnKind: "developer", requestedAt: now });
    expect(capacity.request({ companyId: "company-capacity", taskId: "task-capacity", workflowId: "workflow-capacity", turnKind: "developer", requestedAt: now }).id).toBe(first.id);
    expect(capacity.tryAcquire(first.id).acquired).toBe(true);
    expect(capacity.reconcileFromLedgers(now)).toBe(0);
    database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'failed' WHERE id = 'developer_capacity_execution'").run());
    expect(capacity.reconcileFromLedgers(now)).toBe(1);
    expect(capacity.release(first.id, "duplicate-release", now)).toBe(false);
    expect(database.authQuery((db) => db.prepare("SELECT status, release_reason FROM forge_capacity_requests WHERE id = ?").get(first.id))).toEqual({ status: "stale", release_reason: "worker-restart-ledger-reconciled" });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
