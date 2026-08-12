import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";

import { Connection } from "@temporalio/client";
import proto from "@temporalio/proto";
import { NativeConnection, Worker } from "@temporalio/worker";

import { createTestConfig } from "../src/config.js";
import { createForgeServer, type ForgeServer } from "../src/server.js";
import { ForgeDatabase } from "../src/database.js";
import { runtimeIdentifiers } from "../src/runtime-identifiers.js";
import { createActivities } from "../src/temporal/activities.js";
import { approveIssuePlan, connectTemporal, ensureTemporalFoundation, queryIssueWorkflow, queryProbeWorkflow, rejectIssuePlan, repairIssueDelivery, reviewIssueDelivery, startIssueDevelopment, startIssuePlanning, startIssueWorkflow, startProbeWorkflow } from "../src/temporal/service.js";

const replayDurationKeys = new Set(["firstWorkflowTaskBackoff", "workflowTaskTimeout", "startToCloseTimeout", "scheduleToCloseTimeout", "scheduleToStartTimeout", "heartbeatTimeout", "initialInterval", "maximumInterval"]);

function sanitizeReplayValue(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeReplayValue(item));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (replayDurationKeys.has(key ?? "") && Object.keys(record).length === 0) return "0s";
  if ((typeof record.seconds === "string" || typeof record.seconds === "number") && (record.nanos === undefined || typeof record.nanos === "number")) {
    const nanos = typeof record.nanos === "number" ? record.nanos : 0;
    if (key === "eventTime") return new Date(Number(record.seconds) * 1000 + nanos / 1_000_000).toISOString();
    const fraction = nanos === 0 ? "" : `.${String(nanos).padStart(9, "0").replace(/0+$/, "")}`;
    return `${record.seconds}${fraction}s`;
  }
  return Object.fromEntries(Object.entries(record).map(([entryKey, entryValue]) => [entryKey, sanitizeReplayValue(entryValue, entryKey)]));
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not allocate a Temporal test port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

test("starts, persists, restarts, and queries a probe Workflow in isolated test infrastructure", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-temporal-test-"));
  const temporalPort = await availablePort();
  let config = createTestConfig(root, { taskQueue: `tasks-test-${process.pid}-${randomUUID().slice(0, 8)}` });
  let temporalProcess: ChildProcess | undefined;
  let temporalError = "";
  let worker: Worker | undefined;
  let workerRun: Promise<void> | undefined;
  let workerConnection: NativeConnection | undefined;
  let database: ForgeDatabase | undefined;
  let api: ForgeServer | undefined;
  let workflowId = "";

  try {
    temporalProcess = spawn("temporal", [
      "server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(temporalPort),
      "--db-filename", join(root, "temporal.db"), "--namespace", config.temporalNamespace,
      "--search-attribute", "CompanyId=Keyword", "--search-attribute", "ProjectId=Keyword", "--search-attribute", "IssueId=Keyword",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    temporalProcess.stderr?.on("data", (chunk: Buffer) => {
      temporalError += chunk.toString();
    });
    config = createTestConfig(root, {
      taskQueue: config.taskQueue,
      temporalAddress: `127.0.0.1:${temporalPort}`,
    });
    let temporalConnection: Connection | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        temporalConnection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "1 second" });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    expect(temporalConnection).toBeDefined();
    if (!temporalConnection) {
      throw new Error(`Temporal connection was not established: ${temporalError}`);
    }
    await ensureTemporalFoundation(temporalConnection, config);
    temporalConnection.close();

    database = new ForgeDatabase(config.databasePath);
    const integrationAgent = {
      runLeadPlanning: async () => ({ leadSessionRef: "session_integration", leadExecutionId: "agent_integration", leadEvidenceArtifactId: "artifact_integration_evidence", leadOutputArtifactId: "artifact_integration_output", leadOutputKind: "plan" as const, leadSummary: "Integration plan", materialCategories: ["security_permissions" as const], material: true }),
      reviewDelivery: async () => ({ reviewId: "delivery_review_integration", leadExecutionId: "agent_review_integration", leadSessionRef: "session_integration", opinionArtifactId: "artifact_review_opinion", evidenceArtifactId: "artifact_review_evidence", outcome: "blocking" as const, summary: "Integration delivery needs one bounded repair.", repairPlan: "Apply the controlled repair.", findings: [{ findingId: "finding_integration", severity: "blocking" as const, rationale: "Controlled fixture defect.", evidenceRef: "fixture", disposition: "open" as const, repairInstruction: "Apply the controlled repair." }], targetBaseSha: "a".repeat(40), subjectCommit: "b".repeat(40), subjectTree: "c".repeat(40) }),
    };
    const integrationDeveloper = {
      run: async () => ({ developerExecutionId: "developer_integration", developerSessionRef: "session_developer_integration", worktreePath: join(root, "worktrees", "issue-restart"), branchName: "forge/issue/issue-restart", targetBaseSha: "a".repeat(40), currentStep: 1, resultCommit: "b".repeat(40), resultTree: "c".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "artifact_delivery", evidenceArtifactId: "artifact_developer_evidence", deliverySummary: "Developer delivery", outcome: "completed" as const }),
      runRepair: async () => ({ developerExecutionId: "developer_repair_integration", developerSessionRef: "session_developer_integration", supersedesExecutionId: "developer_integration", worktreePath: join(root, "worktrees", "issue-restart"), branchName: "forge/issue/issue-restart", targetBaseSha: "a".repeat(40), resultCommit: "d".repeat(40), resultTree: "e".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "artifact_repaired_delivery", evidenceArtifactId: "artifact_repaired_evidence", deliverySummary: "Developer repair", outcome: "completed" as const, cycle: 1 }),
    };
    workerConnection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({
      connection: workerConnection,
      namespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
      workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)),
      activities: createActivities(database, config, { agent: integrationAgent, developer: integrationDeveloper }),
    });
    workerRun = worker.run();
    api = await createForgeServer(config);
    expect((await api.app.inject({ method: "GET", url: "/api/auth/status" })).statusCode).toBe(200);

    const started = await startProbeWorkflow(config, { probeId: "probe-restart", companyId: "company-1" });
    workflowId = started.workflowId;
    let state = await queryProbeWorkflow(config, workflowId, started.runId);
    for (let attempt = 0; attempt < 20 && state.status !== "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await queryProbeWorkflow(config, workflowId, started.runId);
    }
    expect(state.status).toBe("running");
    expect(database.getProbe("probe-restart")).toEqual({
      workflowId,
      probeId: "probe-restart",
      companyId: "company-1",
      status: "running",
    });

    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('issue-admin', 'Issue Admin', 'issue-admin@forge.local', 'admin', 'active', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('issue-company', 'Issue Company', 'active', ?)").run(new Date().toISOString());
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('issue-project', 'issue-company', 'Issue Project', ?, ?, 'acme/forge', 'main', 'main', 'pnpm install', 'pnpm test', '[\"Tests / unit\"]', '[]', '{}', 'active', 'issue-revision', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, actor_user_id, created_at) VALUES ('issue-revision', 'issue-project', 1, 'issue-identity', '{}', 'issue-admin', ?)").run(new Date().toISOString());
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('issue-brief', 'issue-company', 'task-brief', 'task.md', 'text/markdown', 4, ?, 'issue-company/issue-brief.bin', ?)").run("0".repeat(64), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-restart', 'issue-company', 'issue-project', 'Restart issue', 'issue-brief', '[]', '{}', 0, ?, 'issue-revision', 'issue-restart-key', ?, ?)").run(`${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-restart`, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-continuation', 'issue-company', 'issue-project', 'Continue issue', 'issue-brief', '[]', '{}', 0, ?, 'issue-revision', 'issue-continuation-key', ?, ?)").run(`${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-continuation`, new Date().toISOString(), new Date().toISOString());
    });
    const startedIssue = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-restart", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false });
    let issueState = await queryIssueWorkflow(config, startedIssue.workflowId);
    for (let attempt = 0; attempt < 20 && issueState.phase !== "backlog"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      issueState = await queryIssueWorkflow(config, startedIssue.workflowId);
    }
    expect(issueState).toMatchObject({ issueId: "issue-restart", phase: "backlog", revision: 0, allowedCommands: ["start_planning"] });
    const plannedIssue = await startIssuePlanning(config, startedIssue.workflowId, { expectedRevision: 0, actorUserId: "issue-admin" });
    expect(plannedIssue).toMatchObject({ phase: "approval", revision: 1, owner: "human", planMaterial: true, materialCategories: ["security_permissions"] });
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-restart'").get())).toEqual({ revision: 1, phase: "approval" });
    const revisionRequested = await rejectIssuePlan(config, startedIssue.workflowId, { expectedRevision: 1, actorUserId: "issue-admin", note: "Please address the security boundary" });
    expect(revisionRequested).toMatchObject({ phase: "planning", revision: 2, allowedCommands: ["start_planning"], planRevision: null, planMaterial: null });
    const replannedIssue = await startIssuePlanning(config, startedIssue.workflowId, { expectedRevision: 2, actorUserId: "issue-admin" });
    expect(replannedIssue).toMatchObject({ phase: "approval", revision: 3, planRevision: 3, planMaterial: true });
    const approvedIssue = await approveIssuePlan(config, startedIssue.workflowId, { expectedRevision: 3, actorUserId: "issue-admin", note: "Approve revised plan" });
    expect(approvedIssue).toMatchObject({ phase: "ready_for_development", revision: 4, allowedCommands: ["start_development", "cancel_issue"] });
    const deliveredIssue = await startIssueDevelopment(config, startedIssue.workflowId, { expectedRevision: 4, actorUserId: "issue-admin" });
    expect(deliveredIssue).toMatchObject({ phase: "delivery_ready", revision: 6, allowedCommands: ["review_delivery", "cancel_issue"], developerExecutionId: "developer_integration", developerSessionRef: "session_developer_integration", branchName: "forge/issue/issue-restart", targetBaseSha: "a".repeat(40), resultCommit: "b".repeat(40) });
    const repairRequired = await reviewIssueDelivery(config, startedIssue.workflowId, { expectedRevision: 6, actorUserId: "issue-admin" });
    expect(repairRequired).toMatchObject({ phase: "repair_required", revision: 8, allowedCommands: ["repair_delivery", "cancel_issue"], deliveryReviewId: "delivery_review_integration", deliveryReviewOutcome: "blocking", repairCycle: 0 });
    const repairedIssue = await repairIssueDelivery(config, startedIssue.workflowId, { expectedRevision: 8, actorUserId: "issue-admin" });
    expect(repairedIssue).toMatchObject({ phase: "delivery_ready", revision: 10, allowedCommands: ["review_delivery", "cancel_issue"], developerExecutionId: "developer_repair_integration", developerSessionRef: "session_developer_integration", resultCommit: "d".repeat(40), repairCycle: 1, deliveryReviewId: null, deliveryReviewOutcome: null });

    const startedContinuation = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-continuation", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false, continueAsNewAfter: 2 });
    let continuationState = await queryIssueWorkflow(config, startedContinuation.workflowId);
    for (let attempt = 0; attempt < 20 && continuationState.phase !== "backlog"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continuationState = await queryIssueWorkflow(config, startedContinuation.workflowId);
    }
    expect(continuationState).toMatchObject({ phase: "backlog", revision: 0, continuationCount: 0 });
    await startIssuePlanning(config, startedContinuation.workflowId, { expectedRevision: 0, actorUserId: "issue-admin" });
    const progressState = await approveIssuePlan(config, startedContinuation.workflowId, { expectedRevision: 1, actorUserId: "issue-admin", note: "Approved for development" });
    expect(progressState).toMatchObject({ phase: "ready_for_development", revision: 2, continuationCount: 0 });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      continuationState = await queryIssueWorkflow(config, startedContinuation.workflowId);
      if (continuationState.continuationCount === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(continuationState).toMatchObject({ workflowId: startedContinuation.workflowId, companyId: "issue-company", projectId: "issue-project", issueId: "issue-continuation", projectRevisionId: "issue-revision", phase: "ready_for_development", revision: 2, owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development", lastEventId: `${startedContinuation.workflowId}:2`, continuationCount: 1, lastSummaryHash: null, leadSessionRef: "session_integration", leadExecutionId: "agent_integration", leadEvidenceArtifactId: "artifact_integration_evidence", leadOutputArtifactId: "artifact_integration_output", leadOutputKind: "plan", leadSummary: "Integration plan", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], supplementalReviewUsed: false });
    expect(continuationState.decisionId).toMatch(/^decision_/);
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-continuation'").get())).toEqual({ revision: 2, phase: "ready_for_development" });
    expect(database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_timeline WHERE task_id = 'issue-continuation' ORDER BY revision").all())).toEqual([{ revision: 0 }, { revision: 1 }, { revision: 2 }]);
    if (process.env.FORGE_REPLAY_CAPTURE_PATH) {
      const replayClient = await connectTemporal(config);
      try {
        const history = await replayClient.client.workflow.getHandle(startedIssue.workflowId).fetchHistory();
        const replayHistory = proto.temporal.api.history.v1.History.create(history);
        const replayJson = proto.temporal.api.history.v1.History.toObject(replayHistory, { longs: String, enums: String, bytes: String, defaults: false, arrays: true, objects: true });
        await writeFile(process.env.FORGE_REPLAY_CAPTURE_PATH, JSON.stringify(sanitizeReplayValue(replayJson), null, 2));
      } finally {
        replayClient.connection.close();
      }
    }

    worker.shutdown();
    await workerRun;
    workerRun = undefined;
    worker = undefined;
    await workerConnection.close();
    workerConnection = undefined;
    database.close();
    database = undefined;
    await api.app.close();
    api.database.close();
    api = undefined;

    const reopenedDatabase = new ForgeDatabase(config.databasePath);
    database = reopenedDatabase;
    workerConnection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({
      connection: workerConnection,
      namespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
      workflowsPath: fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url)),
      activities: createActivities(reopenedDatabase, config, { agent: integrationAgent }),
    });
    workerRun = worker.run();
    api = await createForgeServer(config);
    expect((await api.app.inject({ method: "GET", url: "/api/auth/status" })).statusCode).toBe(200);
    const afterRestart = await queryProbeWorkflow(config, workflowId, started.runId);
    expect(afterRestart.status).toBe("running");
    expect(reopenedDatabase.getProbe("probe-restart")?.workflowId).toBe(workflowId);
    worker.shutdown();
    await workerRun;
    workerRun = undefined;
    worker = undefined;
    await workerConnection.close();
    workerConnection = undefined;
    database.close();
    database = undefined;
    await api.app.close();
    api.database.close();
    api = undefined;
  } finally {
    worker?.shutdown();
    await workerRun?.catch(() => undefined);
    await workerConnection?.close();
    database?.close();
    if (api) {
      await api.app.close().catch(() => undefined);
      api.database.close();
    }
    temporalProcess?.kill("SIGTERM");
    if (temporalProcess && temporalProcess.exitCode === null) {
      await new Promise((resolve) => temporalProcess!.once("exit", resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});
