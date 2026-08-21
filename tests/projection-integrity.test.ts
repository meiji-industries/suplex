import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase, projectionStateHash } from "../src/database.js";
import { createActivityContext } from "../src/temporal/activities/context.js";
import { createProjectionActivities } from "../src/temporal/activities/projection.js";
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
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)").run("project-integrity", "company-integrity", "Project", "/tmp/integrity-repo", "/tmp/integrity-worktrees", "main", "main", "true", "true", "[]", "{}", "revision-integrity", now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, 'task-brief', 'task.md', 'text/markdown', 1, ?, ?, ?)").run("artifact-integrity", "company-integrity", "a".repeat(64), "company-integrity/objects/aa/placeholder.bin", now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', '{}', 0, ?, ?, ?, ?, ?, ?)").run("task-integrity", "company-integrity", "project-integrity", "Integrity task", "artifact-integrity", "workflow-integrity", "revision-integrity", "integrity-key", "b".repeat(64), now, now);
  });
}

test("stale projections do not write and re-issued events replace their state", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-integrity-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    const initial = createEvent(0, "backlog", "workflow-integrity:0");
    const planning = createEvent(1, "planning", "workflow-integrity:1");
    database.observeIssueProjection(planning);
    database.projectIssueEvent(planning);
    database.projectIssueEvent(initial);
    expect(database.authQuery((db) => db.prepare("SELECT authoritative_revision, length(authoritative_event_hash) AS hash_length FROM forge_issue_projections WHERE task_id = ?").get("task-integrity"))).toEqual({ authoritative_revision: 0, hash_length: 64 });
    expect(database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_timeline WHERE task_id = ? ORDER BY revision").all("task-integrity"))).toEqual([{ revision: 0 }]);
    const before = database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_issue_timeline WHERE task_id = ?").get("task-integrity"));
    database.projectIssueEvent(initial);
    expect(database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_issue_timeline WHERE task_id = ?").get("task-integrity"))).toEqual(before);

    const conflict = createEvent(1, "planning", "workflow-integrity:1");
    conflict.state.pendingAction = "Different planning state";
    expect(() => database.projectIssueEvent(conflict)).not.toThrow();
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase, pending_action FROM forge_issue_projections WHERE task_id = ?").get("task-integrity"))).toEqual({ revision: 1, phase: "planning", pending_action: "Different planning state" });
    expect(() => database.projectIssueEvent(conflict)).not.toThrow();

    const conflictingRebuild = structuredClone(planning);
    conflictingRebuild.state.pendingAction = "Conflicting history";
    expect(() => database.replaceIssueProjectionFromEvents("task-integrity", [initial, planning, conflictingRebuild])).not.toThrow();
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase, pending_action FROM forge_issue_projections WHERE task_id = ?").get("task-integrity"))).toEqual({ revision: 1, phase: "planning", pending_action: "Conflicting history" });
    expect(database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_timeline WHERE task_id = ? ORDER BY revision").all("task-integrity"))).toEqual([{ revision: 0 }, { revision: 1 }]);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("projectIssueState replaces a higher projection revision after a workflow reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-reset-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    const newer = createEvent(26, "planning", "workflow-integrity:26");
    database.projectIssueEvent(newer);
    const reset = createEvent(25, "planning", "workflow-integrity:25");
    reset.state.pendingAction = "Workflow reset state";
    database.projectIssueState({ taskId: reset.state.issueId, companyId: reset.state.companyId, projectId: reset.state.projectId, workflowId: reset.state.workflowId, runId: "run-after-reset", revision: reset.state.revision, phase: reset.state.phase, owner: reset.state.owner, allowedCommands: reset.state.allowedCommands, pendingAction: reset.state.pendingAction, lastEventId: reset.state.lastEventId, state: reset.state });
    expect(database.authQuery((db) => db.prepare("SELECT revision, pending_action, last_run_id FROM forge_issue_projections WHERE task_id = ?").get("task-integrity"))).toEqual({ revision: 25, pending_action: "Workflow reset state", last_run_id: "run-after-reset" });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow's first projection accepts the creation row when only stateChangedAt differs", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-initial-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    // Creation path (TaskService.createTask) writes authoritative revision-0 rows at its own timestamp…
    const creationState = IssueWorkflowStateSchema.parse({ ...createEvent(0, "backlog", "workflow-integrity:0").state, stateChangedAt: "2026-08-11T00:00:00.000Z" });
    const creationHash = projectionStateHash(creationState);
    const now = "2026-08-11T00:00:00.000Z";
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, event_hash, authoritative_revision, authoritative_event_hash, projected_at) VALUES (?, ?, ?, ?, 0, 'backlog', 'human', ?, 'Start planning', ?, 'workflow-integrity:0', ?, 0, ?, ?)").run("task-integrity", "company-integrity", "project-integrity", "workflow-integrity", JSON.stringify(["start_planning"]), now, creationHash, creationHash, now);
      db.prepare("INSERT INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, event_type, metadata_json, created_at, event_hash) VALUES ('workflow-integrity:0', ?, ?, ?, 0, 'task_created', ?, ?, ?)").run("task-integrity", "company-integrity", "workflow-integrity", JSON.stringify({ revision: 0, stateHash: creationHash }), now, creationHash);
      db.prepare("INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES (?, ?, ?, 0, ?, ?)").run("task-integrity", "company-integrity", "workflow-integrity", JSON.stringify(creationState), now);
    });
    // …then the workflow's first projectIssueState projects the same canonical state at ITS timestamp.
    const workflowEvent = createEvent(0, "backlog", "workflow-integrity:0");
    workflowEvent.state.stateChangedAt = "2026-08-11T00:00:01.000Z";
    // Exercise the real projectIssueState activity seam.
    const context = createActivityContext(database, createTestConfig(root));
    const projection = createProjectionActivities(context);
    await expect(projection.projectIssueState(workflowEvent)).resolves.toBeTruthy();
    const workflowHash = projectionStateHash(IssueWorkflowStateSchema.parse(workflowEvent.state));
    expect(database.authQuery((db) => db.prepare("SELECT authoritative_event_hash FROM forge_issue_projections WHERE task_id = ?").get("task-integrity"))).toEqual({ authoritative_event_hash: workflowHash });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a reset workflow's new run supersedes the abandoned run's projected revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-reset-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    database.projectIssueEvent(createEvent(0, "backlog", "workflow-integrity:0"));
    database.projectIssueEvent(createEvent(1, "planning", "workflow-integrity:1"));

    // `temporal workflow reset` starts a new run that re-derives revision 1 with different state.
    const afterReset = createEvent(1, "planning", "workflow-integrity:1");
    afterReset.state.pendingAction = "Lead planning after the reset";
    const resetEvent = IssueProjectionEventSchema.parse({ ...afterReset, runId: "run-after-reset" });
    expect(() => database.projectIssueEvent(resetEvent)).not.toThrow();
    database.observeIssueProjection(resetEvent);
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase, pending_action, last_run_id FROM forge_issue_projections WHERE task_id = ?").get("task-integrity")))
      .toEqual({ revision: 1, phase: "planning", pending_action: "Lead planning after the reset", last_run_id: "run-after-reset" });
    expect(database.authQuery((db) => db.prepare("SELECT run_id FROM forge_issue_timeline WHERE task_id = ? ORDER BY revision").all("task-integrity")))
      .toEqual([{ run_id: "run-integrity" }, { run_id: "run-after-reset" }]);

    // The projection activity only carries workflow identity, so a re-issued
    // event from that path must also replace the earlier projection.
    const sameRun = createEvent(1, "planning", "workflow-integrity:1");
    sameRun.state.pendingAction = "Conflicting same-run state";
    expect(() => database.projectIssueEvent(IssueProjectionEventSchema.parse({ ...sameRun, runId: "run-after-reset" }))).not.toThrow();
    expect(database.authQuery((db) => db.prepare("SELECT pending_action FROM forge_issue_projections WHERE task_id = ?").get("task-integrity")))
      .toEqual({ pending_action: "Conflicting same-run state" });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
