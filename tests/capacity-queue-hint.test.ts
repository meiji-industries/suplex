import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { applyQueueHintProjection } from "../src/engine/activities/context.js";

test("queue hint is restored when the agent slot is acquired and never clobbers a newer write", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-capacity-queue-hint-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    const now = "2026-08-30T00:00:00.000Z";
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief', 'text/plain', 1, ?, 'brief', ?)").run("a".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), now, now);
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES ('task', 'company', 'project', 'workflow', 1, 'planning', 'lead', '[]', 'Lead planning', ?, 'workflow:1')").run(now);
    });

    const restore = applyQueueHintProjection(database, "task", { provider: "codex", position: 2, activeCount: 2 });
    expect(database.authQuery((db) => db.prepare("SELECT pending_action FROM forge_issue_projections WHERE task_id = 'task'").get()))
      .toEqual({ pending_action: "Waiting for a codex agent slot (2 active, position 2)" });

    restore();
    expect(database.authQuery((db) => db.prepare("SELECT pending_action FROM forge_issue_projections WHERE task_id = 'task'").get()))
      .toEqual({ pending_action: "Lead planning" });

    // A queued turn that ends while a newer projection write (the normal
    // pipeline) has replaced the hint must leave that newer value untouched.
    applyQueueHintProjection(database, "task", { provider: "codex", position: 2, activeCount: 2 });
    database.authQuery((db) => db.prepare("UPDATE forge_issue_projections SET pending_action = 'Approve final plan' WHERE task_id = 'task'").run());
    restore();
    expect(database.authQuery((db) => db.prepare("SELECT pending_action FROM forge_issue_projections WHERE task_id = 'task'").get()))
      .toEqual({ pending_action: "Approve final plan" });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
