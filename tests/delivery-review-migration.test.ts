import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";

test("migration 0019 backfills immutable review attempts once and protects supersession", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-review-migration-test-"));
  const oldMigrationRoot = join(root, "drizzle");
  const filename = join(root, "forge.sqlite");
  const repositoryRoot = process.cwd();
  let legacy: ForgeDatabase | undefined;
  try {
    await cp(join(repositoryRoot, "drizzle"), oldMigrationRoot, { recursive: true, filter: (source) => !source.endsWith("20260811055500_delivery_review_attempts_and_lineage.sql") });

    process.chdir(root);
    legacy = new ForgeDatabase(filename);
    const now = "2026-08-11T00:00:00.000Z";
    const sha = (letter: string) => letter.repeat(40);
    legacy.authTransaction((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_1', 'User', 'user@forge.local', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', ?, ?, 'acme/forge', 'main', 'main', 'pnpm install', 'pnpm test', '[]', '{}', 'active', 'revision_1', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), now, now);
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, created_at) VALUES ('revision_1', 'project_1', 1, 'identity_1', '{}', ?, ?, 'user_1', ?)").run(sha("a"), sha("b"), now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company_1', ?, ?, ?, 1, ?, ?, ?)").run("brief_1", "task-brief", "brief.md", "text/markdown", sha("0"), "company_1/brief_1.bin", now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company_1', ?, ?, ?, 1, ?, ?, ?), (?, 'company_1', ?, ?, ?, 1, ?, ?, ?), (?, 'company_1', ?, ?, ?, 1, ?, ?, ?)").run("evidence_1", "agent-evidence", "evidence.jsonl", "application/x-ndjson", sha("1"), "company_1/evidence_1.bin", now, "opinion_1", "delivery-review", "opinion.json", "application/json", sha("2"), "company_1/opinion_1.bin", now, "repair_evidence_1", "agent-evidence", "repair.jsonl", "application/x-ndjson", sha("3"), "company_1/repair_evidence_1.bin", now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', 'brief_1', '[]', '{}', 0, 'workflow_1', 'revision_1', 'key_1', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, session_ref, started_at, finished_at, evidence_artifact_id) VALUES ('agent_review_1', 'task_1', 'company_1', 'workflow_1', 'planner', 'completed', 1, 'session_lead', ?, ?, 'evidence_1')").run(now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, session_ref, started_at, finished_at, result_commit, result_tree, dirty_state, delivery_artifact_id, evidence_artifact_id) VALUES ('developer_1', 'task_1', 'company_1', 'workflow_1', 1, 1, 'completed', 'forge/issue/task_1', ?, ?, 'session_developer', ?, ?, ?, ?, 'clean', 'opinion_1', 'repair_evidence_1')").run(join(root, "worktrees/task_1"), sha("a"), now, now, sha("b"), sha("c"));
      db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, created_at) VALUES ('review_approved', 'task_1', 'company_1', 'workflow_1', 1, ?, ?, ?, 'agent_review_1', 'session_lead', 'approved', 'Approved.', 'opinion_1', 'evidence_1', ?), ('review_blocking', 'task_1', 'company_1', 'workflow_1', 1, ?, ?, ?, 'agent_review_1', 'session_lead', 'blocking', 'Needs repair.', 'opinion_1', 'evidence_1', ?)").run(sha("a"), sha("b"), sha("c"), now, sha("a"), sha("d"), sha("e"), now);
      db.prepare("INSERT INTO forge_delivery_findings (id, review_id, task_id, company_id, severity, rationale, evidence_ref, disposition, repair_instruction, created_at) VALUES ('finding_1', 'review_blocking', 'task_1', 'company_1', 'blocking', 'Defect.', 'fixture', 'open', 'Repair it.', ?)").run(now);
      db.prepare("INSERT INTO forge_delivery_repairs (id, task_id, company_id, workflow_id, review_id, developer_execution_id, cycle, status, subject_commit, result_commit, evidence_artifact_id, created_at) VALUES ('repair_legacy', 'task_1', 'company_1', 'workflow_1', 'review_blocking', 'developer_1', 1, 'completed', ?, ?, 'repair_evidence_1', ?)").run(sha("d"), sha("f"), now);
    });
    legacy.close();
    legacy = undefined;

    process.chdir(repositoryRoot);
    let current = new ForgeDatabase(filename);
    expect(current.authQuery((db) => db.prepare("SELECT id, status, completed_review_id, correction_attempts, developer_execution_id, developer_session_ref FROM forge_delivery_review_attempts ORDER BY id").all())).toEqual([
      { id: "review_attempt_backfill_review_approved", status: "completed", completed_review_id: "review_approved", correction_attempts: null, developer_execution_id: null, developer_session_ref: null },
      { id: "review_attempt_backfill_review_blocking", status: "completed", completed_review_id: "review_blocking", correction_attempts: null, developer_execution_id: null, developer_session_ref: null },
    ]);
    current.close();
    current = new ForgeDatabase(filename);
    expect(current.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_delivery_review_attempts").get())).toEqual({ count: 2 });
    current.authTransaction((db) => {
      db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, supersedes_review_id, created_at) VALUES ('review_fresh', 'task_1', 'company_1', 'workflow_1', 1, ?, ?, ?, 'agent_review_1', 'session_lead', 'approved', 'Fresh approval.', 'opinion_1', 'evidence_1', 'review_blocking', ?)").run(sha("a"), sha("g"), sha("h"), now);
      expect(() => db.prepare("INSERT INTO forge_delivery_reviews (id, task_id, company_id, workflow_id, plan_revision, base_sha, subject_commit, subject_tree, lead_execution_id, session_ref, outcome, summary, opinion_artifact_id, evidence_artifact_id, supersedes_review_id, created_at) VALUES ('review_duplicate_fresh', 'task_1', 'company_1', 'workflow_1', 1, ?, ?, ?, 'agent_review_1', 'session_lead', 'approved', 'Duplicate.', 'opinion_1', 'evidence_1', 'review_blocking', ?)").run(sha("a"), sha("i"), sha("j"), now)).toThrow();
    });
    current.close();
  } finally {
    if (legacy) legacy.close();
    process.chdir(repositoryRoot);
    await rm(root, { recursive: true, force: true });
  }
});
