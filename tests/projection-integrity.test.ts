import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase, ProjectionPersistenceFailure, projectionStateHash } from "../src/database.js";
import { createActivityContext } from "../src/engine/activities/context.js";
import { createProjectionActivities } from "../src/engine/activities/projection.js";
import { buildInitialIssueWorkflowState, IssueProjectionEventSchema, IssueWorkflowStateSchema, type IssueProjectionEvent } from "../src/engine/issue-contracts.js";

function createEvent(revision: number, phase: "backlog" | "planning" | "ci_waiting" | "development", lastEventId: string): IssueProjectionEvent {
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
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)").run("project-integrity", "company-integrity", "Project", "/tmp/integrity-repo", "/tmp/integrity-worktrees", "main", "main", "true", "true", "[]", "{}", now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, 'task-brief', 'task.md', 'text/markdown', 1, ?, ?, ?)").run("artifact-integrity", "company-integrity", "a".repeat(64), "company-integrity/objects/aa/placeholder.bin", now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', '{}', 0, ?, ?, ?, ?, ?, ?)").run("task-integrity", "company-integrity", "project-integrity", "Integrity task", "artifact-integrity", "workflow-integrity", "revision-integrity", "integrity-key", "b".repeat(64), now, now);
  });
}

function durableProjection(database: ForgeDatabase): unknown {
  return database.authQuery((db) => ({
    projection: db.prepare("SELECT revision, pending_action, last_event_id, event_hash, authoritative_revision, authoritative_event_hash FROM forge_issue_projections WHERE task_id = ?").get("task-integrity"),
    timeline: db.prepare("SELECT revision, event_hash FROM forge_issue_timeline WHERE task_id = ? ORDER BY stream_id").all("task-integrity"),
    snapshots: db.prepare("SELECT revision, state_json FROM forge_workflow_snapshots WHERE task_id = ? ORDER BY revision").all("task-integrity"),
  }));
}

test("stale projections do not write and re-issued events replace their state", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-integrity-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    const initial = createEvent(0, "backlog", "workflow-integrity:0");
    const planning = createEvent(1, "planning", "workflow-integrity:1");
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

test("a successful projection clears a stale workflow stall", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-stall-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    database.projectIssueEvent(createEvent(0, "backlog", "workflow-integrity:0"));
    database.authTransaction((db) => db.prepare("UPDATE forge_issue_projections SET projection_status = 'stalled', projection_status_message = 'Activity pushDeliveryBranch failed' WHERE task_id = ?").run("task-integrity"));
    database.projectIssueEvent(createEvent(1, "planning", "workflow-integrity:1"));
    expect(database.authQuery((db) => db.prepare("SELECT projection_status, projection_status_message FROM forge_issue_projections WHERE task_id = ?").get("task-integrity"))).toEqual({ projection_status: "current", projection_status_message: null });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("records one timeline row for repeated observations of a phase", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-phase-events-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    database.projectIssueEvent(createEvent(0, "backlog", "workflow-integrity:0"));
    database.projectIssueEvent(createEvent(1, "ci_waiting", "workflow-integrity:1"));
    database.projectIssueEvent(createEvent(2, "ci_waiting", "workflow-integrity:2"));
    database.projectIssueEvent(createEvent(3, "ci_waiting", "workflow-integrity:3"));
    database.projectIssueEvent(createEvent(4, "development", "workflow-integrity:4"));

    expect(database.authQuery((db) => db.prepare("SELECT revision, event_type FROM forge_issue_timeline WHERE task_id = ? ORDER BY revision").all("task-integrity"))).toEqual([
      { revision: 0, event_type: "task_created" },
      { revision: 1, event_type: "phase_ci_waiting" },
      { revision: 4, event_type: "phase_development" },
    ]);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("projection activity rejects invalid schema and preserves prior authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-invalid-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    const projection = createProjectionActivities(createActivityContext(database, createTestConfig(root)));
    await projection.projectIssueState(createEvent(0, "backlog", "workflow-integrity:0"));
    const before = durableProjection(database);
    const invalid = { schemaVersion: 1, runId: "run-integrity", eventId: "workflow-integrity:bad", state: { issueId: "task-integrity" } } as unknown as IssueProjectionEvent;

    const rejection = projection.projectIssueState(invalid);
    await expect(rejection).rejects.toBeInstanceOf(ProjectionPersistenceFailure);
    await expect(rejection).rejects.toMatchObject({ code: "invalid-input" });
    expect(durableProjection(database)).toEqual(before);
    expect(() => database.observeIssueProjection(invalid)).toThrow(ProjectionPersistenceFailure);
    expect(durableProjection(database)).toEqual(before);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("projection activity rejects task identity mismatch and preserves prior authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-identity-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    const projection = createProjectionActivities(createActivityContext(database, createTestConfig(root)));
    await projection.projectIssueState(createEvent(0, "backlog", "workflow-integrity:0"));
    const before = durableProjection(database);
    const mismatched = createEvent(1, "planning", "workflow-integrity:1");
    mismatched.state.companyId = "company-other";

    const rejection = projection.projectIssueState(mismatched);
    await expect(rejection).rejects.toBeInstanceOf(ProjectionPersistenceFailure);
    await expect(rejection).rejects.toMatchObject({ code: "identity-mismatch" });
    expect(durableProjection(database)).toEqual(before);
    expect(() => database.observeIssueProjection(mismatched)).toThrow(ProjectionPersistenceFailure);
    expect(durableProjection(database)).toEqual(before);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("projection activity rejects a SQLite transaction failure and rolls back every projection row", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-transaction-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    const projection = createProjectionActivities(createActivityContext(database, createTestConfig(root)));
    await projection.projectIssueState(createEvent(0, "backlog", "workflow-integrity:0"));
    const before = durableProjection(database);
    const planning = createEvent(1, "planning", "workflow-integrity:1");
    database.authQuery((db) => db.exec(`CREATE TRIGGER fail_projection_snapshot
      BEFORE INSERT ON forge_workflow_snapshots
      WHEN NEW.task_id = 'task-integrity' AND NEW.revision = 1
      BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END`));

    const rejection = projection.projectIssueState(planning);
    await expect(rejection).rejects.toBeInstanceOf(ProjectionPersistenceFailure);
    await expect(rejection).rejects.toMatchObject({ code: "write-failed" });
    expect(durableProjection(database)).toEqual(before);
    database.authQuery((db) => db.exec("DROP TRIGGER fail_projection_snapshot"));
    expect(() => database.observeIssueProjection(planning)).toThrow(ProjectionPersistenceFailure);
    expect(durableProjection(database)).toEqual(before);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("projection activity rolls back durable rows when observation metadata fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-observation-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    const projection = createProjectionActivities(createActivityContext(database, createTestConfig(root)));
    await projection.projectIssueState(createEvent(0, "backlog", "workflow-integrity:0"));
    const before = durableProjection(database);
    const planning = createEvent(1, "planning", "workflow-integrity:1");
    database.authQuery((db) => db.exec(`CREATE TRIGGER fail_projection_observation
      BEFORE UPDATE OF authoritative_revision, authoritative_event_hash ON forge_issue_projections
      WHEN NEW.task_id = 'task-integrity' AND NEW.authoritative_revision = 1
      BEGIN SELECT RAISE(ABORT, 'injected observation failure'); END`));

    const rejection = projection.projectIssueState(planning);
    await expect(rejection).rejects.toBeInstanceOf(ProjectionPersistenceFailure);
    await expect(rejection).rejects.toMatchObject({ code: "write-failed" });
    expect(durableProjection(database)).toEqual(before);
    database.authQuery((db) => db.exec("DROP TRIGGER fail_projection_observation"));
    expect(() => database.observeIssueProjection(planning)).toThrow(ProjectionPersistenceFailure);
    expect(durableProjection(database)).toEqual(before);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("valid projection activity replay and observation are idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-replay-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    const projection = createProjectionActivities(createActivityContext(database, createTestConfig(root)));
    await projection.projectIssueState(createEvent(0, "backlog", "workflow-integrity:0"));
    const planning = createEvent(1, "planning", "workflow-integrity:1");
    await expect(projection.projectIssueState(planning)).resolves.toEqual(planning.state);
    const projected = durableProjection(database);

    await expect(projection.projectIssueState(planning)).resolves.toEqual(planning.state);
    expect(() => database.observeIssueProjection(planning)).not.toThrow();
    expect(durableProjection(database)).toEqual(projected);
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
      db.prepare("INSERT INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, source, event_type, metadata_json, created_at, event_hash) VALUES ('workflow-integrity:0', ?, ?, ?, 0, 'workflow', 'task_created', ?, ?, ?)").run("task-integrity", "company-integrity", "workflow-integrity", JSON.stringify({ revision: 0, stateHash: creationHash }), now, creationHash);
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

    // `engine workflow reset` starts a new run that re-derives revision 1 with different state.
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

test("workflow snapshots keep revision 0 and only the newest 50 revisions per task", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-integrity-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    for (let revision = 0; revision <= 80; revision += 1) database.projectIssueEvent(createEvent(revision, revision === 0 ? "backlog" : "planning", `workflow-integrity:${revision}`));
    const revisions = database.authQuery((db) => db.prepare("SELECT revision FROM forge_workflow_snapshots WHERE task_id = ? ORDER BY revision").all("task-integrity") as Array<{ revision: number }>).map((row) => row.revision);
    expect(revisions[0]).toBe(0);
    expect(revisions.slice(1)).toEqual(Array.from({ length: 50 }, (_, index) => 31 + index));
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
