import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivityContext } from "../src/temporal/activities/context.js";
import { createGovernanceActivities } from "../src/temporal/activities/governance.js";

test("records a plan blocker response when the durable subject has no hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-plan-blocker-response-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const now = new Date().toISOString();
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('admin', 'Admin', 'admin', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'owner/repo', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief', ?), ('blocker', 'company', 'decision-blocker', 'blocker.md', 'text/markdown', 1, ?, 'blocker', ?)").run("a".repeat(64), now, "b".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("c".repeat(64), now, now);
    });
    const staged = await new ArtifactStore(config.artifactRoot).stage("company", "plan-blocker-response", {
      filename: "answer.md",
      mimeType: "text/markdown",
      bytes: Buffer.from("Proceed with option A.", "utf8"),
    });
    const activities = createGovernanceActivities(createActivityContext(database, config));
    const result = await activities.recordPlanBlockerResponse({
      taskId: "task",
      companyId: "company",
      workflowId: "workflow",
      actorUserId: "admin",
      blockerArtifactId: "blocker",
      expectedWorkflowRevision: 3,
      answerStagingRef: staged.ref,
      idempotencyKey: "blocker-answer-1",
    });

    expect(result.duplicate).not.toBe(true);
    expect(database.authQuery((db) => db.prepare("SELECT blocker_artifact_sha256, answer_artifact_sha256, subject_hash FROM forge_plan_blocker_responses").get())).toEqual({
      blocker_artifact_sha256: null,
      answer_artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      subject_hash: null,
    });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
