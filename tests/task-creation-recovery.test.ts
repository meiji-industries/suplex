import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { canonicalJson } from "../src/canonical-json.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase, projectionStateHash } from "../src/database.js";
import { reconcileTaskCreationIntents } from "../src/task-creation-recovery.js";
import { expectedInitialIssueWorkflowState, initialStateFixture } from "./fixtures/issue-state.js";

test("revision-zero state is one schema-parsed canonical value", () => {
  const fromCreation = initialStateFixture();
  const fromWorkflow = expectedInitialIssueWorkflowState();
  expect(canonicalJson(fromCreation)).toBe(canonicalJson(fromWorkflow));
  expect(projectionStateHash(fromCreation)).toBe(projectionStateHash(fromWorkflow));
});

test("an artifact manifest is persisted before bytes and cleanup is exact", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-artifact-recovery-test-"));
  try {
    const store = new ArtifactStore(root);
    const bytes = Buffer.from("brief body", "utf8");
    const planned = store.plan("company-recovery", "creation-recovery", "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes });
    const manifest = planned;
    await expect(stat(join(root, planned.stagingPath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, planned.storagePath))).rejects.toMatchObject({ code: "ENOENT" });

    const stored = await store.write(planned, bytes);
    expect(stored.storagePath).toBe(manifest.storagePath);
    expect(await store.getArtifact(stored)).toEqual(bytes);
    await store.removePlanned(planned);
    await expect(stat(join(root, planned.stagingPath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, planned.storagePath))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("committed task creation converges after unavailable and concurrent workflow starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-task-creation-recovery-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const config = createTestConfig(root);
  const now = new Date().toISOString();
  try {
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user-1', 'User', 'user', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-1', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project-1', 'company-1', 'Project', ?, ?, 'acme/forge', 'main', 'main', 'pnpm install', 'pnpm test', '[]', '{}', 'active', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief-1', 'company-1', 'task-brief', 'task.md', 'text/markdown', 1, ?, 'company-1/brief-1.bin', ?)").run("0".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task-1', 'company-1', 'project-1', 'Task', 'brief-1', '[]', '{}', 0, 'workflow-1', 'revision-1', 'key-1', ?, ?, ?)").run("1".repeat(64), now, now);
      db.prepare("INSERT INTO forge_task_creation_intents (id, company_id, project_id, task_id, workflow_id, idempotency_key, project_revision_id, state, attempt, lease_token, lease_expires_at, created_at, updated_at) VALUES ('creation-1', 'company-1', 'project-1', 'task-1', 'workflow-1', 'key-1', 'revision-1', 'workflow_starting', 1, 'lease-1', ?, ?, ?)").run(now, now, now);
    });

    await reconcileTaskCreationIntents(database, config, async () => { throw new Error("legacy workflow service unavailable"); });
    expect(database.authQuery((db) => db.prepare("SELECT state, error_code FROM forge_task_creation_intents WHERE id = 'creation-1'").get())).toEqual({ state: "workflow_starting", error_code: "workflow_start_ambiguous" });

    const starts: string[] = [];
    const start: NonNullable<Parameters<typeof reconcileTaskCreationIntents>[2]> = async (_config, input) => {
      starts.push(input.workflowId!);
      expect(input).toMatchObject({ workflowId: "workflow-1", issueId: "task-1", projectRevisionId: "revision-1", requestHash: "1".repeat(64), roleProfiles: {} });
      return { workflowId: input.workflowId!, runId: "run-1", existing: starts.length > 1 };
    };
    await Promise.all([reconcileTaskCreationIntents(database, config, start), reconcileTaskCreationIntents(database, config, start)]);
    expect(starts).toEqual(["workflow-1", "workflow-1"]);
    expect(database.authQuery((db) => db.prepare("SELECT state, error_code, lease_token, lease_expires_at FROM forge_task_creation_intents WHERE id = 'creation-1'").get())).toEqual({ state: "started", error_code: null, lease_token: null, lease_expires_at: null });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
