import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { createActivityContext } from "../src/engine/activities/context.js";
import { createPlanningActivities } from "../src/engine/activities/planning.js";

test("planner notes without a Lead session reach a terminal forwarding state", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-planner-note-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const now = new Date().toISOString();
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_1', 'User', 'user', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', '/repo', '/worktrees', 'acme/forge', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief_1', 'company_1', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief.md', ?)").run("a".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', 'brief_1', '[]', '{}', 0, 'workflow_1', 'revision_1', 'key_1', ?, ?)").run(now, now);
    });
    await createPlanningActivities(createActivityContext(database, config)).recordPlannerNote({ taskId: "task_1", companyId: "company_1", workflowId: "workflow_1", revision: 0, actorUserId: "user_1", commandId: "command_1", note: "Please add coverage." });
    expect(database.authQuery((db) => db.prepare("SELECT forward_status, forward_error_code FROM forge_planner_notes WHERE id = 'planner_note_command_1'").get())).toEqual({ forward_status: "failed", forward_error_code: "lead-session-unavailable" });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
