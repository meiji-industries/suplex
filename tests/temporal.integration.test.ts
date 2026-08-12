import { mkdtemp, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";

import { createTestConfig } from "../src/config.js";
import { createForgeServer, type ForgeServer } from "../src/server.js";
import { ForgeDatabase } from "../src/database.js";
import { ArtifactStore } from "../src/artifacts.js";
import { runtimeIdentifiers } from "../src/runtime-identifiers.js";
import { createActivities } from "../src/temporal/activities.js";
import { replayIssueHistory, type ReplayHistory } from "../src/temporal/replay.js";
import { AgentFailure } from "../src/codex-lead.js";
import { ProjectionRebuildService } from "../src/projection-rebuild.js";
import { approveIssuePlan, cancelIssue, cancelIssueDevelopment, connectTemporal, continueIssueWork, ensureTemporalFoundation, queryIssueWorkflow, queryProbeWorkflow, rejectIssuePlan, repairIssueDelivery, reviseIssuePlan, reviewIssueDelivery, startIssueDevelopment, startIssuePlanning, startIssueWorkflow, startProbeWorkflow } from "../src/temporal/service.js";
import { activityPayloadInterceptors } from "../src/temporal/payload-boundary-interceptors.js";
import { buildProductionWorkflowBundle, temporalDataConverter } from "../src/temporal/workflow-bundle.js";
import type { DeliveryReviewServiceInput, DeveloperRepairActivityInput } from "../src/temporal/issue-contracts.js";
import { runReplayScenarioCorpus } from "./replay-scenario-driver.js";
import { captureWorkflowHistory } from "../scripts/capture-workflow-history.js";

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
    const workflowBundle = await buildProductionWorkflowBundle();

    database = new ForgeDatabase(config.databasePath);
    let permanentPlanningFailure = false;
    let permanentPlanningCalls = 0;
    let developerFailure = false;
    let planningMaterial = true;
    let preservedWorktreeCompatibility: boolean | null = null;
    let revisionDisposition: "reuse" | "new" = "new";
    let revisionAuthorizationCalls = 0;
    let holdPlanning = false;
    let releasePlanning = (): void => {};
    let planningGate = Promise.resolve();
    const integrationAgent = {
      runLeadPlanning: async () => {
        if (holdPlanning) await planningGate;
        if (permanentPlanningFailure) {
          permanentPlanningCalls += 1;
          throw new AgentFailure("model-unavailable", "The configured model is unavailable for the active provider account. Select a supported model, then retry.", { nonRetryable: true });
        }
        return { leadSessionRef: "session_integration", leadExecutionId: "agent_integration", leadEvidenceArtifactId: "artifact_integration_evidence", leadOutputArtifactId: "artifact_integration_output", leadOutputKind: "plan" as const, leadSummary: "Integration plan", materialCategories: planningMaterial ? ["security_permissions" as const] : [], material: planningMaterial, preservedWorktreeCompatibility };
      },
      reviewDelivery: async (input: DeliveryReviewServiceInput) => {
        const review = { kind: "delivery_review", summary: "Integration delivery needs one bounded repair.", outcome: "blocking", repairPlan: "Apply the controlled repair.", findings: [{ findingId: "finding_integration", severity: "blocking", rationale: "Controlled fixture defect.", evidenceRef: "fixture", disposition: "open", repairInstruction: "Apply the controlled repair." }] };
        const artifact = await new ArtifactStore(config.artifactRoot).put(input.companyId, "delivery-review", { filename: "integration-review.json", mimeType: "application/json", bytes: Buffer.from(JSON.stringify(review), "utf8") });
        database!.authTransaction((db) => db.prepare("INSERT OR IGNORE INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt));
        return { outcome: "completed" as const, attemptId: "delivery_review_attempt_integration", correctionAttempts: 0, subject: input.subject, review: { reviewId: "delivery_review_integration", leadExecutionId: "agent_review_integration", leadSessionRef: "session_integration", opinionArtifactId: artifact.id, evidenceArtifactId: "artifact_review_evidence", opinion: "blocking" as const, summary: review.summary, repairPlan: review.repairPlan, findings: [{ findingId: "finding_integration", severity: "blocking" as const, rationale: "Controlled fixture defect.", evidenceRef: "fixture", disposition: "open" as const, repairInstruction: "Apply the controlled repair." }], supersedesReviewId: input.supersedesReviewId ?? null } };
      },
    };
    const integrationDeveloper = {
      run: async (input: { executionId?: string }) => {
        if (developerFailure) throw new AgentFailure("process-exited", "The agent invocation did not complete.");
        return { developerExecutionId: input.executionId ?? "developer_integration", developerSessionRef: "session_developer_integration", worktreePath: join(root, "worktrees", "issue-restart"), branchName: "forge/issue/issue-restart", targetBaseSha: "a".repeat(40), currentStep: 1, resultCommit: "b".repeat(40), resultTree: "c".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "artifact_delivery", evidenceArtifactId: "artifact_developer_evidence", deliverySummary: "Developer delivery", outcome: "completed" as const };
      },
      runRepair: async (input: DeveloperRepairActivityInput) => ({ outcome: "completed" as const, repairAttemptId: "delivery_repair_attempt_integration", cycle: input.cycle, reviewId: input.reviewId, subject: { planRevision: input.planRevision, targetBaseSha: input.targetBaseSha, subjectCommit: input.subjectCommit, subjectTree: input.subjectTree, developerExecutionId: input.developerExecutionId, deliveryArtifactId: "artifact_delivery", developerEvidenceArtifactId: "artifact_developer_evidence", leadSessionRef: input.leadSessionRef, developerSessionRef: input.developerSessionRef }, developerExecutionId: "developer_repair_integration", developerSessionRef: "session_developer_integration", worktreePath: join(root, "worktrees", "issue-restart"), branchName: "forge/issue/issue-restart", resultCommit: "d".repeat(40), resultTree: "e".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "artifact_repaired_delivery", evidenceArtifactId: "artifact_repaired_evidence", summary: "Developer repair" }),
    };
    const ciCalls = new Map<string, number>();
    const ciPlanInputs: Array<{ leadSessionRef: string; ciAttemptId: string }> = [];
    const ciRepairInputs: Array<{ priorDeveloperSessionRef: string; ciAttemptId: string }> = [];
    const baseActivities = createActivities(database, config, { agent: integrationAgent, developer: integrationDeveloper });
    const integrationActivities = {
      ...baseActivities,
      async projectIssueState(event: Parameters<typeof baseActivities.projectIssueState>[0]) {
        return event.state.issueId.startsWith("ci-") ? event.state : baseActivities.projectIssueState(event);
      },
      async reconcileTargetBase(input: Parameters<typeof baseActivities.reconcileTargetBase>[0]) {
        if (!input.taskId.startsWith("ci-")) return baseActivities.reconcileTargetBase(input);
        return { outcome: "no_drift" as const, checkId: `target_base_${input.taskId}`, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: input.expectedBaseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree };
      },
      async runDeveloperExecution(input: Parameters<typeof baseActivities.runDeveloperExecution>[0]) {
        return input.taskId.startsWith("ci-") ? integrationDeveloper.run(input) : baseActivities.runDeveloperExecution(input);
      },
      async runDeveloperExecutionSupervised(input: Parameters<typeof baseActivities.runDeveloperExecutionSupervised>[0]) {
        if (!input.taskId.startsWith("ci-")) return baseActivities.runDeveloperExecutionSupervised(input);
        const { worktreePath: _worktreePath, ...result } = await integrationDeveloper.run({ executionId: input.developerTurnExecutionId });
        return { status: "completed" as const, result, resultHash: "a".repeat(64) };
      },
      async runLeadPlanning(input: Parameters<typeof baseActivities.runLeadPlanning>[0]) {
        return input.taskId.startsWith("ci-") ? integrationAgent.runLeadPlanning() : baseActivities.runLeadPlanning(input);
      },
      async reconcileCi(input: Parameters<typeof baseActivities.reconcileCi>[0]) {
        if (!input.taskId.startsWith("ci-")) return baseActivities.reconcileCi(input);
        const calls = (ciCalls.get(input.taskId) ?? 0) + 1;
        ciCalls.set(input.taskId, calls);
        const retryAt = new Date(Date.now() + 150).toISOString();
        const common = { runId: `ci_run_${input.taskId}`, attemptId: `ci_attempt_${input.taskId}_${calls}`, attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: input.expectedHeadSha, evidenceArtifactId: `artifact_ci_${input.taskId}_${calls}`, policyHash: "f".repeat(64), propagationDeadline: new Date(Date.now() + 300_000).toISOString(), overallDeadline: new Date(Date.now() + 3_600_000).toISOString() };
        if (input.taskId === "ci-rate" && calls === 1) return { ...common, outcome: "rate_limited" as const, reason: "provider_rate_limited", owner: "system" as const, repairable: false, summary: "GitHub rate limit is active", retryAt, nextPollAt: retryAt };
        if (input.taskId === "ci-repair") return { ...common, outcome: "failed" as const, reason: "required_check_failed", owner: "lead" as const, repairable: true, summary: "Required check failed", retryAt: null, nextPollAt: null };
        return { ...common, outcome: "passed" as const, reason: "checks_passed", owner: null, repairable: false, summary: "All required checks passed", retryAt: null, nextPollAt: null };
      },
      async planCiRepair(input: Parameters<typeof baseActivities.planCiRepair>[0]) {
        ciPlanInputs.push({ leadSessionRef: input.leadSessionRef, ciAttemptId: input.ciAttemptId });
        return { planId: "ci_plan_integration", planArtifactId: "artifact_ci_plan", evidenceArtifactId: "artifact_ci_plan_evidence", leadExecutionId: "agent_ci_plan", leadSessionRef: input.leadSessionRef, summary: "Repair the exact failed check" };
      },
      async runCiRepair(input: Parameters<typeof baseActivities.runCiRepair>[0]) {
        ciRepairInputs.push({ priorDeveloperSessionRef: input.priorDeveloperSessionRef, ciAttemptId: input.ciAttemptId });
        return { repairId: "ci_repair_integration", developerExecutionId: "developer_ci_repair", developerSessionRef: input.priorDeveloperSessionRef, worktreePath: input.worktreePath, branchName: input.branchName, priorCommit: input.priorCommit, priorTree: input.priorTree, resultCommit: "d".repeat(40), resultTree: "e".repeat(40), deliveryArtifactId: "artifact_ci_repaired_delivery", evidenceArtifactId: "artifact_ci_repaired_evidence", summary: "Exact CI repair complete", outcome: "completed" as const };
      },
      async finalReview(input: Parameters<typeof baseActivities.finalReview>[0]) {
        if (!input.taskId.startsWith("ci-")) return baseActivities.finalReview(input);
        return { finalReviewId: `final_review_${input.taskId}`, leadExecutionId: `agent_final_${input.taskId}`, leadSessionRef: input.leadSessionRef, opinionArtifactId: `artifact_final_opinion_${input.taskId}`, evidenceArtifactId: `artifact_final_evidence_${input.taskId}`, reviewArtifact: { artifactId: `artifact_final_review_${input.taskId}`, companyId: "issue-company", kind: "delivery-review" as const, sha256: "f".repeat(64), byteSize: 1, mimeType: "application/json" }, outcome: "approved" as const, summary: "Exact release approved" };
      },
      async findActiveDeveloperExecution() { return null; },
      async preparePlanRevision(input: Parameters<typeof baseActivities.preparePlanRevision>[0]) {
        const revisionRequestId = `revision_${input.workflowId}_${input.requestRevision}`;
        return revisionDisposition === "reuse"
          ? { status: "accepted" as const, revisionRequestId, coordinates: { disposition: "reuse" as const, revisionRequestId, developerExecutionId: "developer-preserved", branchName: "forge/issue/preserved", baseSha: "a".repeat(40), headSha: "b".repeat(40), treeSha: "c".repeat(40), dirtyState: "clean" as const } }
          : { status: "accepted" as const, revisionRequestId, coordinates: { disposition: "new" as const, revisionRequestId, exactBaseSha: input.exactBaseSha ?? "a".repeat(40) } };
      },
      async authorizePlanRevision() { revisionAuthorizationCalls += 1; },
      async createSuccessor(input: Parameters<typeof baseActivities.createSuccessor>[0]) {
        return { successorTaskId: input.successorTaskId, successorWorkflowId: input.successorWorkflowId, predecessorTaskId: input.predecessorTaskId, projectRevisionId: "issue-revision", creationRevision: input.acceptedRevision };
      },
    };
    workerConnection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({
      connection: workerConnection,
      namespace: config.temporalNamespace,
      taskQueue: config.taskQueue,
      workflowBundle,
      dataConverter: temporalDataConverter,
      interceptors: { activity: activityPayloadInterceptors },
      activities: integrationActivities,
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
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, created_at) VALUES ('issue-revision', 'issue-project', 1, 'issue-identity', ?, ?, ?, 'issue-admin', ?)").run(JSON.stringify({ repository: "acme/forge", repositoryPath: join(root, "repo"), worktreeRoot: join(root, "worktrees"), baseBranch: "main", targetBranch: "main", baseSha: "a".repeat(40), targetSha: "b".repeat(40), setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"] }), "a".repeat(40), "b".repeat(40), new Date().toISOString());
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('issue-brief', 'issue-company', 'task-brief', 'task.md', 'text/markdown', 4, ?, 'issue-company/issue-brief.bin', ?)").run("0".repeat(64), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-restart', 'issue-company', 'issue-project', 'Restart issue', 'issue-brief', '[]', '{}', 0, ?, 'issue-revision', 'issue-restart-key', ?, ?)").run(`${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-restart`, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-continuation', 'issue-company', 'issue-project', 'Continue issue', 'issue-brief', '[]', '{}', 0, ?, 'issue-revision', 'issue-continuation-key', ?, ?)").run(`${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-continuation`, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-permanent-failure', 'issue-company', 'issue-project', 'Permanent failure issue', 'issue-brief', '[]', '{}', 0, ?, 'issue-revision', 'issue-permanent-failure-key', ?, ?)").run(`${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-permanent-failure`, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-start-failure', 'issue-company', 'issue-project', 'Developer start failure', 'issue-brief', '[]', '{}', 0, ?, 'issue-revision', 'issue-start-failure-key', ?, ?)").run(`${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-start-failure`, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-developer-failure', 'issue-company', 'issue-project', 'Developer activity failure', 'issue-brief', '[]', '{}', 0, ?, 'issue-revision', 'issue-developer-failure-key', ?, ?)").run(`${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-developer-failure`, new Date().toISOString(), new Date().toISOString());
    });
    const startedIssue = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-restart", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false });
    const duplicateIssue = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-restart", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false });
    expect(duplicateIssue).toMatchObject({ workflowId: startedIssue.workflowId, runId: startedIssue.runId, existing: true });
    let issueState = await queryIssueWorkflow(config, startedIssue.workflowId);
    for (let attempt = 0; attempt < 20 && issueState.phase !== "backlog"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      issueState = await queryIssueWorkflow(config, startedIssue.workflowId);
    }
    expect(issueState).toMatchObject({ issueId: "issue-restart", phase: "backlog", revision: 0, allowedCommands: ["start_planning"] });
    holdPlanning = true;
    planningGate = new Promise<void>((resolve) => { releasePlanning = resolve; });
    const plannedIssuePromise = startIssuePlanning(config, startedIssue.workflowId, { expectedRevision: 0, actorUserId: "issue-admin" });
    let projectedPlanning: { revision: number; phase: string } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      projectedPlanning = database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-restart'").get()) as { revision: number; phase: string } | undefined;
      if (projectedPlanning?.phase === "planning") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(projectedPlanning).toEqual({ revision: 1, phase: "planning" });
    releasePlanning();
    holdPlanning = false;
    const plannedIssue = await plannedIssuePromise;
    expect(plannedIssue).toMatchObject({ phase: "approval", revision: 2, owner: "human", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"] });
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-restart'").get())).toEqual({ revision: 2, phase: "approval" });
    const revisionRequested = await rejectIssuePlan(config, startedIssue.workflowId, { expectedRevision: 2, actorUserId: "issue-admin", note: "Please address the security boundary" });
    expect(revisionRequested).toMatchObject({ phase: "planning", revision: 3, allowedCommands: ["start_planning"], planRevision: null, planMaterial: null });
    const replannedIssue = await startIssuePlanning(config, startedIssue.workflowId, { expectedRevision: 3, actorUserId: "issue-admin" });
    expect(replannedIssue).toMatchObject({ phase: "approval", revision: 5, planRevision: 4, planMaterial: true });
    const approvedIssue = await approveIssuePlan(config, startedIssue.workflowId, { expectedRevision: 5, actorUserId: "issue-admin", note: "Approve revised plan" });
    expect(approvedIssue).toMatchObject({ phase: "ready_for_development", revision: 6, allowedCommands: ["start_development", "cancel_issue", "revise_plan"] });
    const deliveredIssue = await startIssueDevelopment(config, startedIssue.workflowId, { expectedRevision: 6, actorUserId: "issue-admin" });
    expect(deliveredIssue).toMatchObject({ phase: "delivery_ready", revision: 8, allowedCommands: ["review_delivery", "cancel_issue", "revise_plan"], developerExecutionId: expect.stringMatching(/^developer_[a-f0-9]{24}$/), developerSessionRef: "session_developer_integration", branchName: "forge/issue/issue-restart", targetBaseSha: "a".repeat(40), resultCommit: "b".repeat(40) });
    const repairRequired = await reviewIssueDelivery(config, startedIssue.workflowId, { expectedRevision: 8, actorUserId: "issue-admin" });
    expect(repairRequired).toMatchObject({ phase: "repair_required", revision: 10, allowedCommands: ["repair_delivery", "cancel_issue", "revise_plan"], deliveryReviewId: "delivery_review_integration", deliveryReviewOutcome: "blocking", repairCycle: 0 });
    const repairedIssue = await repairIssueDelivery(config, startedIssue.workflowId, { expectedRevision: 10, actorUserId: "issue-admin" });
    expect(repairedIssue).toMatchObject({ phase: "delivery_ready", revision: 12, allowedCommands: ["review_delivery", "cancel_issue", "revise_plan"], developerExecutionId: "developer_repair_integration", developerSessionRef: "session_developer_integration", resultCommit: "d".repeat(40), repairCycle: 1, deliveryReviewId: null, deliveryReviewOutcome: null });
    const revisedIssue = await reviseIssuePlan(config, startedIssue.workflowId, { expectedRevision: 12, actorUserId: "issue-admin", reason: "The accepted delivery needs a bounded follow-up plan.", worktreeDisposition: "new", exactBaseSha: "a".repeat(40) });
    expect(revisedIssue).toMatchObject({ phase: "planning", revision: 13, revisionRequestId: `revision_${startedIssue.workflowId}_12`, revisedExecutionCoordinates: { disposition: "new", exactBaseSha: "a".repeat(40) } });
    const replannedWithNewCoordinates = await startIssuePlanning(config, startedIssue.workflowId, { expectedRevision: 13, actorUserId: "issue-admin" });
    expect(replannedWithNewCoordinates).toMatchObject({ phase: "approval", revisionRequestId: `revision_${startedIssue.workflowId}_12`, planRevision: 14 });

    const ciContinuation = (issueId: string, extra: Record<string, unknown> = {}) => ({ phase: "ci_waiting" as const, revision: 20, owner: "lead" as const, allowedCommands: ["cancel_issue" as const], pendingAction: "Waiting for required CI", lastEventId: `${issueId}-20`, continuationCount: 0, lastSummaryHash: null, leadSessionRef: "session_ci_lead", leadExecutionId: "agent_ci_lead", leadOutputArtifactId: "artifact_ci_lead_output", deliveryReviewId: `delivery_${issueId}`, planRevision: 1, developerExecutionId: "developer_ci_original", developerSessionRef: "session_ci_developer", worktreePath: join(root, "worktrees", issueId), branchName: `forge/issue/${issueId}`, targetBaseSha: "a".repeat(40), resultCommit: "b".repeat(40), resultTree: "c".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "artifact_ci_delivery", developerEvidenceArtifactId: "artifact_ci_developer_evidence", releaseId: `release_${issueId}`, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", expectedHeadSha: "b".repeat(40), expectedHeadTree: "c".repeat(40), ciAttempt: 0, ciOutcome: "waiting" as const, ciNextPollAt: null, ...extra });
    const startCiFixture = (issueId: string, extra: Record<string, unknown> = {}) => startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId, projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false, continuationState: ciContinuation(issueId, extra) });
    const waitForPhase = async (fixtureWorkflowId: string, phase: string) => {
      let fixtureState = await queryIssueWorkflow(config, fixtureWorkflowId);
      for (let attempt = 0; attempt < 40 && fixtureState.phase !== phase; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        fixtureState = await queryIssueWorkflow(config, fixtureWorkflowId);
      }
      return fixtureState;
    };

    planningMaterial = false;
    const routine = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "ci-routine", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false, continuationState: { ...ciContinuation("ci-routine"), phase: "ready_for_development", revision: 4, owner: "lead", allowedCommands: ["start_development", "cancel_issue", "revise_plan"], pendingAction: "Start development", lastEventId: "ci-routine-4", planMaterial: false, materialCategories: [], releaseId: null, pullRequestNumber: null, pullRequestUrl: null, expectedHeadSha: null, expectedHeadTree: null, ciRunId: null, ciOutcome: null, developerExecutionId: null, developerSessionRef: null, resultCommit: null, resultTree: null, deliveryArtifactId: null, developerEvidenceArtifactId: null } });
    expect(await startIssueDevelopment(config, routine.workflowId, { expectedRevision: 4, actorUserId: "issue-admin" })).toMatchObject({ phase: "delivery_ready", planMaterial: false });

    planningMaterial = true;
    preservedWorktreeCompatibility = false;
    revisionDisposition = "reuse";
    const incompatible = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "ci-incompatible", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false, continuationState: { ...ciContinuation("ci-incompatible"), phase: "delivery_ready", revision: 8, owner: "lead", allowedCommands: ["review_delivery", "cancel_issue", "revise_plan"], pendingAction: "Lead delivery review", lastEventId: "ci-incompatible-8" } });
    const incompatibleRequested = await reviseIssuePlan(config, incompatible.workflowId, { expectedRevision: 8, actorUserId: "issue-admin", reason: "The preserved implementation conflicts with the revised plan.", worktreeDisposition: "reuse" });
    const callsBeforeIncompatiblePlan = revisionAuthorizationCalls;
    const incompatiblePlan = await startIssuePlanning(config, incompatible.workflowId, { expectedRevision: incompatibleRequested.revision, actorUserId: "issue-admin" });
    expect(incompatiblePlan).toMatchObject({ phase: "delivery_blocked", owner: "human", blockerCode: "preserved-worktree-incompatible", allowedCommands: ["revise_plan", "cancel_issue"] });
    expect(revisionAuthorizationCalls).toBe(callsBeforeIncompatiblePlan);
    preservedWorktreeCompatibility = null;
    revisionDisposition = "new";

    const ciPass = await startCiFixture("ci-pass");
    expect(await waitForPhase(ciPass.workflowId, "accepted")).toMatchObject({ phase: "accepted", ciOutcome: "passed", finalReviewId: "final_review_ci-pass", leadSessionRef: "session_ci_lead" });
    expect(ciCalls.get("ci-pass")).toBe(1);

    const ciRate = await startCiFixture("ci-rate");
    expect(await waitForPhase(ciRate.workflowId, "accepted")).toMatchObject({ phase: "accepted", ciOutcome: "passed", ciAttempt: 2 });
    expect(ciCalls.get("ci-rate")).toBe(2);

    const ciRepair = await startCiFixture("ci-repair");
    expect(await waitForPhase(ciRepair.workflowId, "delivery_ready")).toMatchObject({ phase: "delivery_ready", developerExecutionId: "developer_ci_repair", developerSessionRef: "session_ci_developer", resultCommit: "d".repeat(40), releaseId: null, ciRunId: null, finalReviewId: null });
    expect(ciPlanInputs).toEqual([{ leadSessionRef: "session_ci_lead", ciAttemptId: "ci_attempt_ci-repair_1" }]);
    expect(ciRepairInputs).toEqual([{ priorDeveloperSessionRef: "session_ci_developer", ciAttemptId: "ci_attempt_ci-repair_1" }]);

    const ciCancel = await startCiFixture("ci-cancel", { ciNextPollAt: new Date(Date.now() + 300).toISOString() });
    const waitingToCancel = await waitForPhase(ciCancel.workflowId, "ci_waiting");
    const cancelledIssue = await cancelIssue(config, ciCancel.workflowId, { expectedRevision: waitingToCancel.revision, actorUserId: "issue-admin" });
    expect(cancelledIssue).toMatchObject({ phase: "cancelled", allowedCommands: ["continue_work"] });
    const continuedIssue = await continueIssueWork(config, ciCancel.workflowId, { expectedRevision: cancelledIssue.revision, actorUserId: "issue-admin", reason: "Continue the bounded work after cancellation." });
    expect(continuedIssue).toMatchObject({ phase: "cancelled", revision: cancelledIssue.revision + 1, allowedCommands: [], successorReference: { predecessorTaskId: "ci-cancel" }, successorTaskId: "ci-cancel-successor-" + cancelledIssue.revision });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(ciCalls.get("ci-cancel") ?? 0).toBe(0);
    const ciReplayClient = await connectTemporal(config);
    try {
      for (const [name, fixtureWorkflowId] of [["pass", ciPass.workflowId], ["rate-limit", ciRate.workflowId], ["repair", ciRepair.workflowId], ["cancel", ciCancel.workflowId]] as const) {
        const history = await ciReplayClient.client.workflow.getHandle(fixtureWorkflowId).fetchHistory();
        await replayIssueHistory(history as ReplayHistory, `ci-${name}-replay`);
      }
    } finally { ciReplayClient.connection.close(); }

    const recoveryWorkflowId = `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-start-failure`;
    await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-start-failure", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false, continuationState: { phase: "development", revision: 4, owner: "lead", allowedCommands: ["cancel_development", "reject_plan", "cancel_issue"], pendingAction: "Developer execution", lastEventId: `${recoveryWorkflowId}:4`, continuationCount: 0, lastSummaryHash: null, leadSessionRef: "session_integration", leadOutputArtifactId: "artifact_integration_output", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], supplementalReviewUsed: false, repairCycle: 0 } });
    const recoveredStart = await cancelIssueDevelopment(config, recoveryWorkflowId, { expectedRevision: 4, actorUserId: "issue-admin" });
    expect(recoveredStart).toMatchObject({ phase: "ready_for_development", revision: 5, owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development" });
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-start-failure'").get())).toEqual({ revision: 5, phase: "ready_for_development" });

    const developerFailureWorkflowId = `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-developer-failure`;
    await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-developer-failure", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false, continuationState: { phase: "ready_for_development", revision: 3, owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development", lastEventId: `${developerFailureWorkflowId}:3`, continuationCount: 0, lastSummaryHash: null, leadSessionRef: "session_integration", leadOutputArtifactId: "artifact_integration_output", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], supplementalReviewUsed: false, repairCycle: 0 } });
    developerFailure = true;
    const recoveredDeveloperFailure = await startIssueDevelopment(config, developerFailureWorkflowId, { expectedRevision: 3, actorUserId: "issue-admin" });
    expect(recoveredDeveloperFailure).toMatchObject({ phase: "delivery_blocked", revision: 5, owner: "human", allowedCommands: ["retry_development", "cancel_issue", "revise_plan"], pendingAction: "The agent invocation did not complete.", developerRecoveryStatus: "failed", developerRecoveryReasonCode: "process-exited" });
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase, pending_action FROM forge_issue_projections WHERE task_id = 'issue-developer-failure'").get())).toEqual({ revision: 5, phase: "delivery_blocked", pending_action: "The agent invocation did not complete." });
    developerFailure = false;

    permanentPlanningFailure = true;
    const startedPermanentFailure = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-permanent-failure", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false });
    const failedIssue = await startIssuePlanning(config, startedPermanentFailure.workflowId, { expectedRevision: 0, actorUserId: "issue-admin" });
    expect(failedIssue).toMatchObject({ phase: "failed", revision: 2, owner: "human", allowedCommands: ["start_planning", "continue_work", "cancel_issue"], pendingAction: "The configured model is unavailable for the active provider account. Select a supported model, then retry." });
    expect(permanentPlanningCalls).toBe(1);
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase, pending_action FROM forge_issue_projections WHERE task_id = 'issue-permanent-failure'").get())).toEqual({ revision: 2, phase: "failed", pending_action: "The configured model is unavailable for the active provider account. Select a supported model, then retry." });
    permanentPlanningFailure = false;
    const recoveredIssue = await startIssuePlanning(config, startedPermanentFailure.workflowId, { expectedRevision: 2, actorUserId: "issue-admin" });
    expect(recoveredIssue).toMatchObject({ phase: "approval", revision: 4, planRevision: 3 });

    const startedContinuation = await startIssueWorkflow(config, { companyId: "issue-company", projectId: "issue-project", issueId: "issue-continuation", projectRevisionId: "issue-revision", briefArtifactId: "issue-brief", briefSha256: "0".repeat(64), imageArtifactIds: [], roleProfiles: {}, supplementalReview: false, continueAsNewAfter: 2 });
    let continuationState = await queryIssueWorkflow(config, startedContinuation.workflowId);
    for (let attempt = 0; attempt < 20 && continuationState.phase !== "backlog"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continuationState = await queryIssueWorkflow(config, startedContinuation.workflowId);
    }
    expect(continuationState).toMatchObject({ phase: "backlog", revision: 0, continuationCount: 0 });
    await expect.poll(() => database!.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_issue_timeline WHERE task_id = 'issue-continuation' AND revision = 0").get())).toEqual({ count: 1 });
    await startIssuePlanning(config, startedContinuation.workflowId, { expectedRevision: 0, actorUserId: "issue-admin" });
    const progressState = await approveIssuePlan(config, startedContinuation.workflowId, { expectedRevision: 2, actorUserId: "issue-admin", note: "Approved for development" });
    expect(progressState).toMatchObject({ phase: "ready_for_development", revision: 3, continuationCount: 0 });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      continuationState = await queryIssueWorkflow(config, startedContinuation.workflowId);
      if (continuationState.continuationCount === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(continuationState).toMatchObject({ workflowId: startedContinuation.workflowId, companyId: "issue-company", projectId: "issue-project", issueId: "issue-continuation", projectRevisionId: "issue-revision", phase: "ready_for_development", revision: 3, owner: "lead", allowedCommands: ["start_development", "cancel_issue", "revise_plan"], pendingAction: "Start development", lastEventId: `${startedContinuation.workflowId}:3`, continuationCount: 1, lastSummaryHash: null, leadSessionRef: "session_integration", leadExecutionId: "agent_integration", leadEvidenceArtifactId: "artifact_integration_evidence", leadOutputArtifactId: "artifact_integration_output", leadOutputKind: "plan", leadSummary: "Integration plan", planRevision: 1, planMaterial: true, materialCategories: ["security_permissions"], supplementalReviewUsed: false });
    expect(continuationState.decisionId).toMatch(/^decision_/);
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-continuation'").get())).toEqual({ revision: 3, phase: "ready_for_development" });
    expect(database.authQuery((db) => db.prepare("SELECT revision FROM forge_issue_timeline WHERE task_id = 'issue-continuation' ORDER BY revision").all())).toEqual([{ revision: 0 }, { revision: 1 }, { revision: 2 }, { revision: 3 }]);
    expect(await new ProjectionRebuildService(database, config).rebuild({ companyId: "issue-company", taskId: "issue-continuation" })).toEqual({ rebuilt: 1, findings: [] });
    expect(database.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = 'issue-continuation'").get())).toEqual({ revision: 3, phase: "ready_for_development" });
    const scenarioClient = await connectTemporal(config);
    try {
      const executions = await runReplayScenarioCorpus({ client: scenarioClient.client.workflow, connection: workerConnection, namespace: config.temporalNamespace, taskQueue: `${config.taskQueue}-replay-scenarios` });
      expect(executions.map(({ scenario }) => scenario)).toEqual(["normal_success", "implementation_repair", "active_cancellation", "blocked_authentication_resume", "continue_as_new", "release_base_drift_merged", "release_base_drift_conflict", "ci_wait_retry", "acceptance_ready_timeout", "acceptance_requested_changes", "acceptance_provider_outage", "manual_merge_open", "manual_merge_closed", "manual_merge_changed", "final_review_failure", "plan_revision", "successor_creation", "developer_active_worker_loss", "developer_cancellation", "developer_linked_retry", "developer_ownership_ambiguous", "developer_result_claim"]);
      expect(executions.find(({ scenario }) => scenario === "normal_success")?.currentPhase).toBe("done");
      expect(executions.find(({ scenario }) => scenario === "continue_as_new")?.finalState.continuationCount).toBe(2);
      for (const execution of executions) {
        const revisions = execution.projections.map(({ revision }) => revision);
        expect(new Set(revisions).size).toBe(revisions.length);
      }
      if (process.env.FORGE_REPLAY_CAPTURE_PATH) {
        const replacementIds: Partial<Record<(typeof executions)[number]["scenario"], string>> = { normal_success: "normal-success-v1", implementation_repair: "implementation-repair-v1", active_cancellation: "active-cancellation-v1", blocked_authentication_resume: "blocked-authentication-resume-v1", continue_as_new: "continue-as-new-run-0-v1", release_base_drift_merged: "release-base-drift-merged-v1", release_base_drift_conflict: "release-base-drift-conflict-v1", ci_wait_retry: "ci-wait-retry-v1", acceptance_ready_timeout: "acceptance-ready-timeout-v1", acceptance_requested_changes: "acceptance-requested-changes-v1", acceptance_provider_outage: "acceptance-provider-outage-v1", manual_merge_open: "manual-merge-open-v1", manual_merge_closed: "manual-merge-closed-v1", manual_merge_changed: "manual-merge-changed-v1", final_review_failure: "final-review-failure-v1", plan_revision: "plan-revision-v1", successor_creation: "successor-creation-v1", developer_active_worker_loss: "developer-active-worker-loss-v1", developer_cancellation: "developer-cancellation-v1", developer_linked_retry: "developer-linked-retry-v1", developer_ownership_ambiguous: "developer-ownership-ambiguous-v1", developer_result_claim: "developer-result-claim-v1" };
        const requested = new Set((process.env.FORGE_REPLAY_CAPTURE_SCENARIOS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
        for (const execution of executions.filter(({ scenario }) => requested.size === 0 || requested.has(scenario))) await captureWorkflowHistory({ address: config.temporalAddress, namespace: config.temporalNamespace, workflowId: execution.workflowId, firstRunId: execution.firstRunId, scenario: execution.scenario, currentPhase: execution.currentPhase, outputDir: process.env.FORGE_REPLAY_CAPTURE_PATH, ...(replacementIds[execution.scenario] ? { replace: replacementIds[execution.scenario] } : {}) });
      }
    } finally {
      scenarioClient.connection.close();
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
      workflowBundle,
      dataConverter: temporalDataConverter,
      interceptors: { activity: activityPayloadInterceptors },
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
}, 120_000);
