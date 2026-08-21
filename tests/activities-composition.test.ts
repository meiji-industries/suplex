import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { DeveloperExecutionLeaseRepository } from "../src/developer-execution-leases.js";
import { withSupervisorResultHash } from "../src/developer-supervisor-protocol.js";
import { createActivities } from "../src/temporal/activities.js";
import { createActivityContext } from "../src/temporal/activities/context.js";
import { createAcceptanceActivities } from "../src/temporal/activities/acceptance.js";
import { createCapacityActivities } from "../src/temporal/activities/capacity.js";
import { createCiActivities } from "../src/temporal/activities/ci.js";
import { createDeliveryReviewActivities } from "../src/temporal/activities/delivery-review.js";
import { createDevelopmentActivities } from "../src/temporal/activities/development.js";
import { createFinalReviewActivities } from "../src/temporal/activities/final-review.js";
import { createGovernanceActivities } from "../src/temporal/activities/governance.js";
import { createMergeConflictActivities } from "../src/temporal/activities/merge-conflict.js";
import { createPlanningActivities } from "../src/temporal/activities/planning.js";
import { createProjectionActivities } from "../src/temporal/activities/projection.js";
import { createReleaseActivities } from "../src/temporal/activities/release.js";
import { createTargetBaseActivities } from "../src/temporal/activities/target-base.js";

const expectedActivityKeys = [
  "acceptDelivery",
  "authorizeFinalPlan",
  "authorizePlanRevision",
  "cancelCapacity",
  "cancelCapacityExecution",
  "cancelDeveloperExecution",
  "consolidateLeadPlan",
  "createSuccessor",
  "finalReview",
  "finalizeCapacity",
  "findActiveDeveloperExecution",
  "inspectCapacity",
  "observeDeveloperExecution",
  "planCiRepair",
  "planDeliveryRepair",
  "planMergeConflict",
  "preparePlanRevision",
  "projectIssueState",
  "publishRelease",
  "rateLimitCapacity",
  "reconcileAcceptance",
  "reconcileCapacityOwnership",
  "reconcileCi",
  "reconcileDeveloperDeliveryEvidence",
  "reconcileMerge",
  "reconcileTargetBase",
  "recordDecisionBlockerResolution",
  "recordDeliveryBlocker",
  "recordDeliveryDecision",
  "recordPlanBlockerResponse",
  "recordPlanDecision",
  "recordProbeStarted",
  "requestCapacity",
  "requeueCapacity",
  "rerunCi",
  "resolveMergeConflict",
  "resolveMergeConflictSupervised",
  "reviewDelivery",
  "runCiRepair",
  "runDeveloperExecution",
  "runDeveloperExecutionSupervised",
  "runDeveloperRepair",
  "runDeveloperRepairSupervised",
  "runLeadPlanning",
  "runSupplementalReview",
  "tryAcquireCapacity",
  "updateCiFromBase",
].sort();

test("activity factories compose the frozen activity key set without overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-activities-composition-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);

  try {
    const context = createActivityContext(database, config);
    const factoryResults = [
      createProjectionActivities(context),
      createPlanningActivities(context),
      createGovernanceActivities(context),
      createCapacityActivities(context),
      createDevelopmentActivities(context),
      createDeliveryReviewActivities(context),
      createReleaseActivities(context),
      createTargetBaseActivities(context),
      createCiActivities(context),
      createFinalReviewActivities(context),
      createAcceptanceActivities(context),
      createMergeConflictActivities(context),
    ];
    const factoryKeys = factoryResults.flatMap((factory) => Object.keys(factory));
    const activities = createActivities(database, config);

    expect(new Set(factoryKeys).size).toBe(factoryKeys.length);
    expect(Object.keys(activities).length).toBe(factoryKeys.length);
    expect(Object.keys(activities).sort()).toEqual(expectedActivityKeys);
    expect(factoryKeys.sort()).toEqual(expectedActivityKeys);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a retry finalizes a result_ready supervisor result while its execution row is still running", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-activity-result-ready-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const executionId = `developer_${"a".repeat(24)}`;
  const now = new Date().toISOString();
  try {
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', ?, ?, 'acme/forge', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(root, root, now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief_1', 'company_1', 'task-brief', 'brief.md', 'text/markdown', 0, ?, 'company_1/brief.bin', ?), ('delivery_1', 'company_1', 'developer-reconciliation', 'delivery.json', 'application/json', 0, ?, 'company_1/delivery.bin', ?), ('evidence_1', 'company_1', 'developer-evidence-manifest', 'evidence.json', 'application/json', 0, ?, 'company_1/evidence.bin', ?)").run("0".repeat(64), now, "1".repeat(64), now, "2".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', 'brief_1', '[]', '{}', 0, 'workflow_1', 'revision_1', 'result-ready-key', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES (?, 'task_1', 'company_1', 'workflow_1', 1, 1, 'running', 'forge/issue/task_1', ?, ?, ?, ?)").run(executionId, join(root, "worktree"), "b".repeat(40), now, now);
    });
    const leases = new DeveloperExecutionLeaseRepository(database, config.runtimeRoot);
    const executionRoot = await leases.ensureExecutionRoot(executionId);
    const token = "result-ready-token";
    await writeFile(join(executionRoot, "lease-token"), token, { mode: 0o600 });
    const lease = leases.reserve({ executionId, companyId: "company_1", taskId: "task_1", workflowId: "workflow_1", attempt: 1, turnKind: "implementation", canonicalWorktreePath: join(root, "worktree"), worktreeIdentityHash: "w".repeat(64), leaseToken: token }).lease;
    leases.markSupervisorStarting(executionId);
    leases.setSupervisorIdentity(executionId, { pid: 99_001, processGroup: 99_001, startTime: "gone", executable: "node", argv: ["node"], ownerUid: null });
    leases.setChildIdentity(executionId, { pid: 99_002, processGroup: 99_002, startTime: "gone", executable: "node", argv: ["node"], ownerUid: null });
    await mkdir(join(root, "worktree"), { recursive: true });
    const output = Buffer.from("completed\n");
    await writeFile(join(executionRoot, "events.jsonl"), output);
    const identity = { pid: 1, processGroup: 1, startTime: "start", executable: "node", argv: ["node"], ownerUid: null };
    const supervisorResult = withSupervisorResultHash({ version: 1, executionId, leaseTokenHash: lease.leaseTokenHash, supervisor: identity, child: identity, exitCode: 0, exitSignal: null, outputPath: "events.jsonl", outputSha256: createHash("sha256").update(output).digest("hex"), outputTruncated: false, startedAt: now, finishedAt: now });
    await writeFile(join(executionRoot, "result.json"), JSON.stringify(supervisorResult));
    const context = createActivityContext(database, config);
    const outcome = await context.runSupervised({ taskId: "task_1", companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: executionId, developerAttempt: 1, turnKind: "implementation" }, async () => {
      database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'completed', finished_at = ? WHERE id = ? AND status = 'running'").run(now, executionId));
      return { developerExecutionId: executionId, developerSessionRef: "developer-session", branchName: "forge/issue/task_1", targetBaseSha: "b".repeat(40), currentStep: null, resultCommit: "c".repeat(40), resultTree: "d".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "delivery_1", evidenceArtifactId: "evidence_1", deliverySummary: "Recovered and verified delivery", outcome: "completed" as const };
    });
    expect(outcome).toMatchObject({ status: "completed", resultHash: supervisorResult.resultHash });
    expect(database.authQuery((db) => db.prepare("SELECT status, finished_at AS finishedAt FROM forge_developer_executions WHERE id = ?").get(executionId))).toMatchObject({ status: "completed", finishedAt: now });
    expect(database.authQuery((db) => db.prepare("SELECT failure_code AS failureCode FROM forge_developer_executions WHERE id = ?").get(executionId))).toEqual({ failureCode: null });
    expect(leases.readClaim(executionId)?.resultHash).toBe(supervisorResult.resultHash);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test("a terminal execution row never reclaims a stale supervisor result", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-activity-stale-result-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  const executionId = `developer_${"b".repeat(24)}`;
  const freshExecutionId = `developer_${"c".repeat(24)}`;
  const now = new Date().toISOString();
  try {
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', ?, ?, 'acme/forge', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(root, root, now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief_1', 'company_1', 'task-brief', 'brief.md', 'text/markdown', 0, ?, 'company_1/brief.bin', ?)").run("0".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', 'brief_1', '[]', '{}', 0, 'workflow_1', 'revision_1', 'stale-result-key', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at) VALUES (?, 'task_1', 'company_1', 'workflow_1', 1, 1, 'completed', 'forge/issue/task_1', ?, ?, ?, ?)").run(executionId, join(root, "worktree"), "b".repeat(40), now, now);
    });
    const leases = new DeveloperExecutionLeaseRepository(database, config.runtimeRoot);
    const executionRoot = await leases.ensureExecutionRoot(executionId);
    const token = "stale-result-token";
    await writeFile(join(executionRoot, "lease-token"), token, { mode: 0o600 });
    const lease = leases.reserve({ executionId, companyId: "company_1", taskId: "task_1", workflowId: "workflow_1", attempt: 1, turnKind: "implementation", canonicalWorktreePath: join(root, "worktree"), worktreeIdentityHash: "s".repeat(64), leaseToken: token }).lease;
    const output = Buffer.from("stale\n");
    await writeFile(join(executionRoot, "events.jsonl"), output);
    const identity = { pid: 1, processGroup: 1, startTime: "start", executable: "node", argv: ["node"], ownerUid: null };
    await writeFile(join(executionRoot, "result.json"), JSON.stringify(withSupervisorResultHash({ version: 1, executionId, leaseTokenHash: lease.leaseTokenHash, supervisor: identity, child: identity, exitCode: 0, exitSignal: null, outputPath: "events.jsonl", outputSha256: createHash("sha256").update(output).digest("hex"), outputTruncated: false, startedAt: now, finishedAt: now })));
    const context = createActivityContext(database, config);
    let startedFresh = false;
    const outcome = await context.runSupervised({ taskId: "task_1", companyId: "company_1", workflowId: "workflow_1", planRevision: 1, developerTurnExecutionId: executionId, developerAttempt: 1, turnKind: "implementation" }, async () => {
      startedFresh = true;
      return { developerExecutionId: freshExecutionId, developerSessionRef: "fresh-session", branchName: "forge/issue/task_1", targetBaseSha: "b".repeat(40), currentStep: null, resultCommit: "c".repeat(40), resultTree: "d".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "fresh-delivery", evidenceArtifactId: "fresh-evidence", deliverySummary: "Fresh result", outcome: "completed" as const };
    });
    expect(startedFresh).toBe(true);
    expect(outcome).toMatchObject({ status: "completed", result: { developerExecutionId: freshExecutionId } });
    expect(leases.readClaim(executionId)).toBeUndefined();
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
