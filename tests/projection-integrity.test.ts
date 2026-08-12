import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { buildInitialIssueWorkflowState, IssueProjectionEventSchema, IssueWorkflowStateSchema, type IssueProjectionEvent } from "../src/temporal/issue-contracts.js";

function createEvent(revision: number, phase: "backlog" | "planning", lastEventId: string): IssueProjectionEvent {
  const state = IssueWorkflowStateSchema.parse({
    ...buildInitialIssueWorkflowState({
      workflowId: "workflow-integrity",
      companyId: "company-integrity",
      projectId: "project-integrity",
      issueId: "task-integrity",
      projectRevisionId: "revision-integrity",
      briefArtifactId: "artifact-integrity",
      briefSha256: "a".repeat(64),
      imageArtifactIds: [],
      requestHash: "b".repeat(64),
      roleProfiles: {},
      supplementalReview: false,
      repairCycleLimit: 2,
    }),
    phase,
    revision,
    owner: phase === "backlog" ? "human" : "lead",
    allowedCommands: phase === "backlog" ? ["start_planning"] : [],
    pendingAction: phase === "backlog" ? "Start planning" : "Lead planning",
    lastEventId,
  });
  return IssueProjectionEventSchema.parse({ schemaVersion: 1, runId: "run-integrity", eventId: lastEventId, state });
}

function fixture(database: ForgeDatabase): void {
  const now = "2026-08-11T00:00:00.000Z";
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES (?, ?, 'active', ?)").run("company-integrity", "Integrity", now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)").run("project-integrity", "company-integrity", "Project", "/tmp/integrity-repo", "/tmp/integrity-worktrees", "main", "main", "true", "true", "[]", "[]", "{}", "revision-integrity", now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, 'task-brief', 'task.md', 'text/markdown', 1, ?, ?, ?)").run("artifact-integrity", "company-integrity", "a".repeat(64), "company-integrity/objects/aa/placeholder.bin", now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', '{}', 0, ?, ?, ?, ?, ?, ?)").run("task-integrity", "company-integrity", "project-integrity", "Integrity task", "artifact-integrity", "workflow-integrity", "revision-integrity", "integrity-key", "b".repeat(64), now, now);
  });
}

test("stale projections do not write and conflicting events fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-integrity-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    const initial = createEvent(0, "backlog", "workflow-integrity:0");
    const planning = createEvent(1, "planning", "workflow-integrity:1");
    database.projectIssueEvent(initial);
    database.observeIssueProjection(planning);
    expect(database.authQuery((db) => db.prepare("SELECT authoritative_revision, length(authoritative_event_hash) AS hash_length FROM forge_issue_projections WHERE task_id = ?").get("task-integrity"))).toEqual({ authoritative_revision: 1, hash_length: 64 });
    database.projectIssueEvent(planning);
    const before = database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_issue_timeline WHERE task_id = ?").get("task-integrity"));
    database.projectIssueEvent(createEvent(0, "backlog", "workflow-integrity:old"));
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_issue_timeline WHERE task_id = ?").get("task-integrity"))).toEqual(before);

    const conflict = createEvent(1, "planning", "workflow-integrity:1");
    conflict.state.pendingAction = "Different planning state";
    await expect(Promise.resolve().then(() => database.projectIssueEvent(conflict))).rejects.toMatchObject({ code: "projection_event_conflict" });
    expect(database.authQuery((db) => db.prepare("SELECT code FROM forge_projection_integrity_findings WHERE task_id = ? ORDER BY detected_at DESC LIMIT 1").get("task-integrity"))).toEqual({ code: "projection_event_conflict" });
    expect(() => database.projectIssueEvent(planning)).not.toThrow();
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = ?").get("task-integrity"))).toEqual({ revision: 1, phase: "planning" });

    const conflictingRebuild = structuredClone(planning);
    conflictingRebuild.state.pendingAction = "Conflicting history";
    expect(() => database.replaceIssueProjectionFromEvents("task-integrity", [initial, planning, conflictingRebuild])).toThrow();
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = ?").get("task-integrity"))).toEqual({ revision: 1, phase: "planning" });
    expect(database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_timeline WHERE task_id = ? ORDER BY revision").all("task-integrity"))).toEqual([{ revision: 0 }, { revision: 1 }]);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
