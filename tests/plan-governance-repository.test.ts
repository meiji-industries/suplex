import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { PlanGovernanceRepository } from "../src/plan-governance-repository.js";

test("records a blocker response idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-blocker-response-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = "2026-08-13T00:00:00.000Z";
  const blockerSha256 = "a".repeat(64);
  const answerSha256 = "b".repeat(64);

  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user', 'User', 'user', 'member', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief', ?), ('blocker', 'company', 'lead-output', 'blocker.json', 'application/json', 1, ?, 'blocker', ?), ('evidence', 'company', 'lead-evidence', 'evidence.json', 'application/json', 1, ?, 'evidence', ?), ('answer', 'company', 'plan-blocker-response', 'answer.md', 'text/markdown', 1, ?, 'answer', ?)").run("0".repeat(64), now, blockerSha256, now, "c".repeat(64), now, answerSha256, now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'task-key', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at) VALUES ('analyst', 'task', 'company', 'workflow', 'analyst', 'completed', 1, ?)").run(now);
      db.prepare("INSERT INTO forge_issue_outputs (id, task_id, company_id, workflow_id, execution_id, revision, kind, output_artifact_id, evidence_artifact_id, session_ref, summary, created_at, artifact_sha256, legacy_unverified) VALUES ('output', 'task', 'company', 'workflow', 'analyst', 1, 'decision_blocker', 'blocker', 'evidence', 'session', 'Needs a decision', ?, ?, 0)").run(now, blockerSha256);
    });

    const repository = new PlanGovernanceRepository(database);
    const input = { taskId: "task", companyId: "company", workflowId: "workflow", blockerArtifactId: "blocker", blockerArtifactSha256: blockerSha256, answerArtifactId: "answer", answerArtifactSha256: answerSha256, actorUserId: "user", expectedWorkflowRevision: 4, idempotencyKey: "response-key", subjectHash: "d".repeat(64) };
    const recorded = repository.recordBlockerResponseIdempotently(input);
    const retried = repository.recordBlockerResponseIdempotently(input);

    expect(recorded).toMatchObject({ duplicate: false, answerArtifactId: "answer", answerArtifactSha256: answerSha256 });
    expect(retried).toEqual({ ...recorded, duplicate: true });
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_plan_blocker_responses WHERE task_id = 'task'").get())).toEqual({ count: 1 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
