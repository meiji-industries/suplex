import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { DeveloperExecutionLeaseRepository, DeveloperLeaseFailure, claimKey, deriveDeveloperExecutionId } from "../src/developer-execution-leases.js";
import { developerExecutionId } from "../src/temporal/deterministic-id.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-developer-lease-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const executionId = deriveDeveloperExecutionId("workflow_1", 1, 1, "implementation");
  const now = new Date().toISOString();
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', ?, ?, 'acme/forge', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief_1', 'company_1', 'task-brief', 'brief.md', 'text/markdown', 0, ?, 'company_1/brief_1.bin', ?)").run("0".repeat(64), now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('artifact_delivery', 'company_1', 'developer-delivery', 'delivery.json', 'application/json', 0, ?, 'company_1/delivery.bin', ?), ('artifact_evidence', 'company_1', 'agent-evidence', 'evidence.jsonl', 'application/x-ndjson', 0, ?, 'company_1/evidence.bin', ?)").run("1".repeat(64), now, "2".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', 'brief_1', '[]', '{}', 0, 'workflow_1', 'revision_1', 'lease-key', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES (?, 'task_1', 'company_1', 'workflow_1', 1, 1, 'starting', 'forge/issue/task_1', ?, ?, ?, ?)").run(executionId, join(root, "worktree"), "a".repeat(40), now, now);
  });
  return { root, database, executionId };
}

test("INV-01/INV-07/INV-08 execution identity is deterministic, claims are idempotent, and conflicts block", async () => {
  const value = await fixture();
  try {
    const executionId = value.executionId;
    expect(executionId).toMatch(/^developer_[a-f0-9]{24}$/);
    const repo = new DeveloperExecutionLeaseRepository(value.database, value.root);
    const first = repo.reserve({ executionId, companyId: "company_1", taskId: "task_1", workflowId: "workflow_1", attempt: 1, turnKind: "implementation", canonicalWorktreePath: join(value.root, "worktree"), worktreeIdentityHash: "w".repeat(64) });
    const second = repo.reserve({ executionId, companyId: "company_1", taskId: "task_1", workflowId: "workflow_1", attempt: 1, turnKind: "implementation", canonicalWorktreePath: join(value.root, "worktree"), worktreeIdentityHash: "w".repeat(64) });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.lease.leaseTokenHash).toBe(first.lease.leaseTokenHash);
    repo.markSupervisorStarting(executionId);
    repo.setChildIdentity(executionId, { pid: 100, processGroup: 100, startTime: "start", executable: "node", argv: ["node", "child"], ownerUid: 501 });
    expect(claimKey(executionId, "r".repeat(64))).toHaveLength(64);
    repo.recordResultReady(executionId, { resultHash: "r".repeat(64), exitCode: 0, exitSignal: null, outputTruncated: false });
    const claim = repo.claim({ executionId, resultHash: "r".repeat(64), activityResultJson: "{\"kind\":\"delivery\"}", deliveryArtifactId: "artifact_delivery", evidenceArtifactId: "artifact_evidence" });
    expect(claim.conflict).toBe(false);
    expect(repo.claim({ executionId, resultHash: "r".repeat(64), activityResultJson: "{\"kind\":\"delivery\"}", deliveryArtifactId: "artifact_delivery", evidenceArtifactId: "artifact_evidence" }).conflict).toBe(false);
    expect(() => repo.claim({ executionId, resultHash: "x".repeat(64), activityResultJson: "{}", deliveryArtifactId: "artifact_delivery", evidenceArtifactId: "artifact_evidence" })).not.toThrow();
    expect(repo.claim({ executionId, resultHash: "x".repeat(64), activityResultJson: "{}", deliveryArtifactId: "artifact_delivery", evidenceArtifactId: "artifact_evidence" }).conflict).toBe(true);
    expect(repo.get(executionId)?.status).toBe("ownership_ambiguous");
    expect(value.database.authQuery((db) => db.prepare("SELECT existing_result_hash, conflicting_result_hash FROM forge_developer_result_conflicts WHERE execution_id = ?").get(executionId))).toEqual({ existing_result_hash: "r".repeat(64), conflicting_result_hash: "x".repeat(64) });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("INV-02/INV-03 supervisor and child identities are write-once", async () => {
  const value = await fixture();
  try {
    const repo = new DeveloperExecutionLeaseRepository(value.database, value.root);
    const executionId = value.executionId;
    repo.reserve({ executionId, companyId: "company_1", taskId: "task_1", workflowId: "workflow_1", attempt: 1, turnKind: "implementation", canonicalWorktreePath: join(value.root, "worktree"), worktreeIdentityHash: "i".repeat(64) });
    repo.markSupervisorStarting(executionId);
    const identity = { pid: 100, processGroup: 100, startTime: "start", executable: "node", argv: ["node", "child"], ownerUid: 501 };
    repo.setSupervisorIdentity(executionId, identity);
    repo.setSupervisorIdentity(executionId, identity);
    expect(() => repo.setSupervisorIdentity(executionId, { ...identity, pid: 101 })).toThrow(DeveloperLeaseFailure);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("a terminal execution's stale active lease is released before its worktree is retried", async () => {
  const value = await fixture();
  try {
    const repo = new DeveloperExecutionLeaseRepository(value.database, value.root);
    const worktree = join(value.root, "worktree");
    repo.reserve({ executionId: value.executionId, companyId: "company_1", taskId: "task_1", workflowId: "workflow_1", attempt: 1, turnKind: "implementation", canonicalWorktreePath: worktree, worktreeIdentityHash: "w".repeat(64) });
    value.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'blocked' WHERE id = ?").run(value.executionId));
    const nextId = deriveDeveloperExecutionId("workflow_1", 1, 2, "implementation");
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES (?, 'task_1', 'company_1', 'workflow_1', 1, 2, 'starting', 'forge/issue/task_1', ?, ?, ?, ?)").run(nextId, worktree, "a".repeat(40), new Date().toISOString(), new Date().toISOString()));
    expect(repo.reserve({ executionId: nextId, companyId: "company_1", taskId: "task_1", workflowId: "workflow_1", attempt: 2, turnKind: "implementation", canonicalWorktreePath: worktree, worktreeIdentityHash: "w".repeat(64) }).created).toBe(true);
    expect(repo.get(value.executionId)?.status).toBe("interrupted");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("a command-hashed Developer execution and its supervisor lease insert in one transaction", async () => {
  const value = await fixture();
  try {
    const executionId = developerExecutionId("workflow_1", 1, 2, "implementation", "start-development-command");
    const worktree = join(value.root, "worktree-command-hashed");
    const repo = new DeveloperExecutionLeaseRepository(value.database, value.root);
    value.database.authTransaction((db) => {
      db.prepare("UPDATE forge_developer_executions SET status = 'blocked' WHERE id = ?").run(value.executionId);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES (?, 'task_1', 'company_1', 'workflow_1', 1, 2, 'starting', 'forge/issue/task_1', ?, ?, ?, ?)").run(executionId, worktree, "a".repeat(40), new Date().toISOString(), new Date().toISOString());
      repo.reserveInTransaction(db, { executionId, companyId: "company_1", taskId: "task_1", workflowId: "workflow_1", attempt: 2, turnKind: "implementation", canonicalWorktreePath: worktree, worktreeIdentityHash: "h".repeat(64), leaseToken: "command-hashed-token" });
    });
    expect(repo.get(executionId)).toMatchObject({ executionId, status: "reserved" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});
