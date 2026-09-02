import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { buildInitialIssueWorkflowState, IssueProjectionEventSchema, IssueWorkflowStateSchema, type IssueProjectionEvent } from "../src/engine/issue-contracts.js";
import { at } from "../src/issue-phases.js";

function event(revision: number, companyId = "company"): IssueProjectionEvent {
  const state = IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState({ workflowId: "workflow", companyId, projectId: "project", issueId: "task", projectRevisionId: "revision", briefArtifactId: "brief", briefSha256: "a".repeat(64), imageArtifactIds: [], requestHash: "b".repeat(64), roleProfiles: {}, supplementalReview: false, repairCycleLimit: 2 }),
    revision, ...at(revision === 0 ? "backlog" : "planning"), owner: revision === 0 ? "human" : "lead", allowedCommands: revision === 0 ? ["start_planning"] : [], pendingAction: revision === 0 ? "Start planning" : "Planning", lastEventId: `workflow:${revision}`,
  });
  return IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run", eventId: state.lastEventId, state });
}

function fixture(database: ForgeDatabase): void {
  const now = "2026-09-01T00:00:00.000Z";
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/tmp/repo', '/tmp/worktrees', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'task.md', 'text/markdown', 1, ?, 'brief', ?)").run("a".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), now, now);
  });
}

async function withDatabase(run: (database: ForgeDatabase) => void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try { fixture(database); run(database); } finally { database.close(); await rm(root, { recursive: true, force: true }); }
}

test("identity mismatch throws", async () => {
  await withDatabase((database) => {
    expect(() => database.projectIssueEvent(event(0, "other-company"))).toThrowError(expect.objectContaining({ code: "identity-mismatch" }));
  });
});

test("a stale revision is ignored and returns false", async () => {
  await withDatabase((database) => {
    database.projectIssueEvent(event(1));
    expect(database.projectIssueEvent(event(0))).toBe(false);
  });
});

test("a newer revision upserts and is readable", async () => {
  await withDatabase((database) => {
    database.projectIssueEvent(event(0));
    expect(database.projectIssueEvent(event(1))).toBe(true);
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'task'").get())).toEqual({ revision: 1, phase: "planning" });
  });
});
