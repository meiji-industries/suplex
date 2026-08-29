import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { reconcileSuccessorIntents } from "../src/successor-recovery.js";

test("successor reconciliation survives a start fault and converges under concurrent retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-successor-recovery-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root);
  const now = new Date().toISOString();
  try {
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user-1', 'User', 'user', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-1', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-1', 'company-1', 'Project', ?, ?, 'acme/forge', 'main', 'main', 'pnpm install', 'pnpm test', '[]', '{}', 'active', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-1', 'company-1', 'task-brief', 'task.md', 'text/markdown', 1, ?, 'company-1/brief-1.bin', ?), ('reason-1', 'company-1', 'continuation-reason', 'reason.md', 'text/markdown', 1, ?, 'company-1/reason-1.bin', ?)").run("0".repeat(64), now, "1".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, successor_task_id, created_at, updated_at) VALUES ('predecessor', 'company-1', 'project-1', 'Original', 'brief-1', '[]', '{}', 0, 'workflow-original', 'revision-1', 'original-key', ?, 'successor', ?, ?)").run("2".repeat(64), now, now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, predecessor_task_id, created_at, updated_at) VALUES ('successor', 'company-1', 'project-1', 'Continue: Original', 'brief-1', '[]', '{}', 0, 'workflow-successor', 'revision-1', 'successor-key', ?, 'predecessor', ?, ?)").run("3".repeat(64), now, now);
      db.prepare("INSERT INTO forge_successor_intents (id, predecessor_task_id, predecessor_workflow_id, accepted_revision, successor_task_id, successor_workflow_id, company_id, project_id, project_revision_id, actor_user_id, reason_artifact_id, state, created_at, updated_at) VALUES ('intent-1', 'predecessor', 'workflow-original', 7, 'successor', 'workflow-successor', 'company-1', 'project-1', 'revision-1', 'user-1', 'reason-1', 'workflow_starting', ?, ?)").run(now, now);
    });

    await reconcileSuccessorIntents(database, config, async () => { throw new Error("legacy workflow service unavailable"); });
    expect(database.authQuery((db) => db.prepare("SELECT state FROM forge_successor_intents WHERE id = 'intent-1'").get())).toEqual({ state: "workflow_starting" });

    const starts: string[] = [];
    const start: NonNullable<Parameters<typeof reconcileSuccessorIntents>[2]> = async (_config, input) => {
      starts.push(input.workflowId!);
      expect(input).toMatchObject({ workflowId: "workflow-successor", issueId: "successor", predecessorTaskId: "predecessor", projectRevisionId: "revision-1", roleProfiles: {} });
      return { workflowId: input.workflowId!, runId: "run-successor" };
    };
    await Promise.all([reconcileSuccessorIntents(database, config, start), reconcileSuccessorIntents(database, config, start)]);
    expect(starts).toEqual(["workflow-successor", "workflow-successor"]);
    expect(database.authQuery((db) => db.prepare("SELECT state FROM forge_successor_intents WHERE id = 'intent-1'").get())).toEqual({ state: "linked" });
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_audit_events WHERE action = 'successor_linked'").get())).toEqual({ count: 1 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
