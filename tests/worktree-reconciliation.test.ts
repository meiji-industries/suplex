import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { reconcileWorktrees } from "../src/worktree-reconciliation.js";

test("missing terminal worktrees are recorded once with an event hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-worktree-reconcile-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const now = new Date().toISOString();
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', '/repo', ?, 'acme/forge', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(config.worktreeRoot, now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief_1', 'company_1', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief.md', ?)").run("a".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', 'brief_1', '[]', '{}', 0, 'workflow_1', 'revision_1', 'key_1', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, event_hash, authoritative_revision, projected_at) VALUES ('task_1', 'company_1', 'project_1', 'workflow_1', 3, 'cancelled', 'human', '[]', '', ?, 'workflow_1:3', ?, 3, ?)").run(now, "a".repeat(64), now);
      db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, status, reserved_at) VALUES ('worktree_1', 'task_1', 'company_1', 'project_1', 'workflow_1', '/repo', ?, ?, 'forge/task_1', ?, 'hash', 'active', ?)").run(config.worktreeRoot, join(config.worktreeRoot, "gone"), "a".repeat(40), now);
    });
    expect((await reconcileWorktrees(database, config, { exists: async () => false })).outcomes[0]?.status).toBe("removed_externally_terminal");
    expect(database.authQuery((db) => db.prepare("SELECT event_hash AS eventHash FROM forge_issue_timeline WHERE event_type = 'worktree_removed_externally'").get())).toEqual({ eventHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await reconcileWorktrees(database, config, { exists: async () => false })).outcomes[0]?.status).toBe("already_recorded");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
