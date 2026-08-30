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
    projection: db.prepare("SELECT * FROM forge_issue_projections WHERE task_id = ?").get("task-integrity"),
    timeline: db.prepare("SELECT * FROM forge_issue_timeline WHERE task_id = ? ORDER BY stream_id").all("task-integrity"),
    snapshots: db.prepare("SELECT * FROM forge_workflow_snapshots WHERE task_id = ? ORDER BY revision").all("task-integrity"),
  }));
}

function expectProjectionConflict(operation: () => void): void {
  let failure: unknown;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ProjectionPersistenceFailure);
  expect(failure).toMatchObject({ code: "conflict" });
}

test("stale replays are idempotent and conflicting workflow history is immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-integrity-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    const initial = createEvent(0, "backlog", "workflow-integrity:0");
    const planning = createEvent(1, "planning", "workflow-integrity:1");
    database.projectIssueEvent(initial);
    database.projectIssueEvent(planning);
    const before = durableProjection(database);

    expect(() => database.projectIssueEvent(initial)).not.toThrow();
    expect(durableProjection(database)).toEqual(before);

    const conflict = structuredClone(planning);
    conflict.state.pendingAction = "Different planning state";
    expectProjectionConflict(() => database.projectIssueEvent(conflict));
    expect(durableProjection(database)).toEqual(before);

    const reusedIdentity = createEvent(2, "planning", "workflow-integrity:1");
    expectProjectionConflict(() => database.projectIssueEvent(reusedIdentity));
    expect(durableProjection(database)).toEqual(before);

    const conflictingRebuild = structuredClone(planning);
    conflictingRebuild.state.pendingAction = "Conflicting history";
    expectProjectionConflict(() => database.replaceIssueProjectionFromEvents("task-integrity", [initial, planning, conflictingRebuild]));
    expect(durableProjection(database)).toEqual(before);
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

test("projection activity rolls back timeline writes when snapshot persistence fails", async () => {
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

test("projection activity rolls back timeline and snapshots when latest projection persistence fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-latest-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    const projection = createProjectionActivities(createActivityContext(database, createTestConfig(root)));
    await projection.projectIssueState(createEvent(0, "backlog", "workflow-integrity:0"));
    const before = durableProjection(database);
    const planning = createEvent(1, "planning", "workflow-integrity:1");
    database.authQuery((db) => db.exec(`CREATE TRIGGER fail_latest_projection
      BEFORE UPDATE OF revision ON forge_issue_projections
      WHEN NEW.task_id = 'task-integrity' AND NEW.revision = 1
      BEGIN SELECT RAISE(ABORT, 'injected latest projection failure'); END`));

    const rejection = projection.projectIssueState(planning);
    await expect(rejection).rejects.toBeInstanceOf(ProjectionPersistenceFailure);
    await expect(rejection).rejects.toMatchObject({ code: "write-failed" });
    expect(durableProjection(database)).toEqual(before);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("projection activity rolls back retention and durable rows when observation persistence fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-observation-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    const projection = createProjectionActivities(createActivityContext(database, createTestConfig(root)));
    for (let revision = 0; revision <= 50; revision += 1) {
      await projection.projectIssueState(createEvent(revision, revision === 0 ? "backlog" : "planning", `workflow-integrity:${revision}`));
    }
    const before = durableProjection(database);
    const next = createEvent(51, "planning", "workflow-integrity:51");
    database.authQuery((db) => db.exec(`CREATE TRIGGER fail_projection_observation
      BEFORE UPDATE OF authoritative_revision, authoritative_event_hash ON forge_issue_projections
      WHEN NEW.task_id = 'task-integrity' AND NEW.authoritative_revision = 51
      BEGIN SELECT RAISE(ABORT, 'injected observation failure'); END`));

    const rejection = projection.projectIssueState(next);
    await expect(rejection).rejects.toBeInstanceOf(ProjectionPersistenceFailure);
    await expect(rejection).rejects.toMatchObject({ code: "write-failed" });
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

test("projectIssueState fails closed when a reset reuses an older revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-reset-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    const newer = createEvent(26, "planning", "workflow-integrity:26");
    database.projectIssueEvent(newer);
    const before = durableProjection(database);
    const reset = createEvent(25, "planning", "workflow-integrity:25");
    reset.state.pendingAction = "Workflow reset state";
    expectProjectionConflict(() => database.projectIssueState({ taskId: reset.state.issueId, companyId: reset.state.companyId, projectId: reset.state.projectId, workflowId: reset.state.workflowId, runId: "run-after-reset", revision: reset.state.revision, phase: reset.state.phase, owner: reset.state.owner, allowedCommands: reset.state.allowedCommands, pendingAction: reset.state.pendingAction, lastEventId: reset.state.lastEventId, state: reset.state }));
    expect(durableProjection(database)).toEqual(before);
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
    expect(database.authQuery((db) => ({
      projection: db.prepare("SELECT last_run_id FROM forge_issue_projections WHERE task_id = ?").get("task-integrity"),
      timeline: db.prepare("SELECT run_id FROM forge_issue_timeline WHERE task_id = ?").get("task-integrity"),
      snapshot: db.prepare("SELECT run_id FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get("task-integrity"),
    }))).toEqual({
      projection: { last_run_id: "run-integrity" },
      timeline: { run_id: "run-integrity" },
      snapshot: { run_id: "run-integrity" },
    });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a reset workflow cannot rewrite a persisted revision from an earlier run", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-projection-reset-test-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  try {
    fixture(database);
    database.projectIssueEvent(createEvent(0, "backlog", "workflow-integrity:0"));
    database.projectIssueEvent(createEvent(1, "planning", "workflow-integrity:1"));
    const before = durableProjection(database);

    const afterReset = createEvent(1, "planning", "workflow-integrity:1");
    afterReset.state.pendingAction = "Lead planning after the reset";
    const resetEvent = IssueProjectionEventSchema.parse({ ...afterReset, runId: "run-after-reset" });
    expectProjectionConflict(() => database.projectIssueEvent(resetEvent));
    expect(durableProjection(database)).toEqual(before);

    const sameRun = createEvent(1, "planning", "workflow-integrity:1");
    sameRun.state.pendingAction = "Conflicting same-run state";
    expectProjectionConflict(() => database.projectIssueEvent(sameRun));
    expect(durableProjection(database)).toEqual(before);
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
    database.projectIssueEvent(createEvent(0, "backlog", "workflow-integrity:0"));
    const retainedTransition = createEvent(1, "planning", "workflow-integrity:1");
    database.projectIssueEvent(retainedTransition);
    for (let revision = 2; revision <= 80; revision += 1) database.projectIssueEvent(createEvent(revision, "planning", `workflow-integrity:${revision}`));
    const revisions = database.authQuery((db) => db.prepare("SELECT revision FROM forge_workflow_snapshots WHERE task_id = ? ORDER BY revision").all("task-integrity") as Array<{ revision: number }>).map((row) => row.revision);
    expect(revisions[0]).toBe(0);
    expect(revisions.slice(1)).toEqual(Array.from({ length: 50 }, (_, index) => 31 + index));
    const beforeReplay = durableProjection(database);
    expect(() => database.projectIssueEvent(retainedTransition)).not.toThrow();
    expect(durableProjection(database)).toEqual(beforeReplay);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
