import { mkdtemp, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";

import { createTestConfig, type ForgeConfig } from "../../src/config.js";
import { createForgeServer, type ForgeServer } from "../../src/server.js";
import { ForgeDatabase } from "../../src/database.js";
import { ArtifactStore } from "../../src/artifacts.js";
import { AgentFailure } from "../../src/codex-lead.js";
import { runtimeIdentifiers } from "../../src/runtime-identifiers.js";
import { createActivities } from "../../src/temporal/activities.js";
import { activityPayloadInterceptors } from "../../src/temporal/payload-boundary-interceptors.js";
import { ensureTemporalFoundation } from "../../src/temporal/service.js";
import { buildProductionWorkflowBundle, temporalDataConverter } from "../../src/temporal/workflow-bundle.js";
import type { DeliveryReviewServiceInput, DeveloperRepairActivityInput } from "../../src/temporal/issue-contracts.js";

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

export type TemporalHarnessState = {
  planningFailure: boolean;
  permanentPlanningFailure: boolean;
  permanentPlanningCalls: number;
  developerFailure: boolean;
  deadBuilderOnce: boolean;
  planningMaterial: boolean;
  preservedWorktreeCompatibility: boolean | null;
  revisionDisposition: "reuse" | "new";
  revisionAuthorizationCalls: number;
  holdPlanning: boolean;
  releasePlanning: () => void;
  planningGate: Promise<void>;
  holdDeveloper: boolean;
  releaseDeveloper: () => void;
  developerGate: Promise<void>;
};

export type TemporalHarnessArtifacts = {
  ciProviderEvidence: Awaited<ReturnType<ArtifactStore["put"]>>;
  integrationLeadOutputArtifactId: string;
  integrationLeadEvidenceArtifactId: string;
  integrationFinalReviewArtifactId: string;
  integrationFinalReviewArtifactSha256: string;
};

export type TemporalHarness = {
  start(): Promise<void>;
  stop(): Promise<void>;
  restartWorker(): Promise<void>;
  readonly root: string;
  readonly config: ForgeConfig;
  readonly database: ForgeDatabase;
  readonly workerConnection: NativeConnection;
  readonly state: TemporalHarnessState;
  readonly artifacts: TemporalHarnessArtifacts;
  readonly issueRoleProfiles: { planner: string; builder: string };
  readonly ciCalls: Map<string, number>;
  readonly ciPlanInputs: Array<{ leadSessionRef: string; ciAttemptId: string }>;
  readonly ciRepairInputs: Array<{ priorDeveloperSessionRef: string; ciAttemptId: string }>;
};

export function createTemporalHarness(): TemporalHarness {
  let root = "";
  let config!: ForgeConfig;
  let temporalProcess: ChildProcess | undefined;
  let temporalError = "";
  let worker: Worker | undefined;
  let workerRun: Promise<void> | undefined;
  let workerConnection: NativeConnection | undefined;
  let database: ForgeDatabase | undefined;
  let api: ForgeServer | undefined;
  let workflowBundle: Awaited<ReturnType<typeof buildProductionWorkflowBundle>> | undefined;
  let restartActivitiesFactory: ((database: ForgeDatabase) => ReturnType<typeof createActivities>) | undefined;
  let started = false;
  const issueRoleProfiles = { planner: "profile", builder: "profile" };
  const state: TemporalHarnessState = { planningFailure: false, permanentPlanningFailure: false, permanentPlanningCalls: 0, developerFailure: false, deadBuilderOnce: false, planningMaterial: true, preservedWorktreeCompatibility: null, revisionDisposition: "new", revisionAuthorizationCalls: 0, holdPlanning: false, releasePlanning: () => {}, planningGate: Promise.resolve(), holdDeveloper: false, releaseDeveloper: () => {}, developerGate: Promise.resolve() };
  const ciCalls = new Map<string, number>();
  const ciPlanInputs: Array<{ leadSessionRef: string; ciAttemptId: string }> = [];
  const ciRepairInputs: Array<{ priorDeveloperSessionRef: string; ciAttemptId: string }> = [];
  const artifacts = {} as TemporalHarnessArtifacts;

  async function stop(): Promise<void> {
    if (worker) { worker.shutdown(); await workerRun?.catch(() => undefined); worker = undefined; workerRun = undefined; }
    await workerConnection?.close(); workerConnection = undefined;
    database?.close(); database = undefined;
    if (api) { await api.app.close().catch(() => undefined); api.database.close(); api = undefined; }
    temporalProcess?.kill("SIGTERM");
    if (temporalProcess && temporalProcess.exitCode === null) await new Promise((resolve) => temporalProcess!.once("exit", resolve));
    temporalProcess = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    started = false;
  }

  async function start(): Promise<void> {
    if (started) return;
    root = await mkdtemp(join(tmpdir(), "forge-temporal-test-"));
    const temporalPort = await availablePort();
    config = createTestConfig(root, { taskQueue: `tasks-test-${process.pid}-${randomUUID().slice(0, 8)}` });
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
    if (!temporalConnection) {
      throw new Error(`Temporal connection was not established: ${temporalError}`);
    }
    await ensureTemporalFoundation(temporalConnection, config);
    await temporalConnection.close();
    workflowBundle = await buildProductionWorkflowBundle();

    database = new ForgeDatabase(config.databasePath);
    const integrationAgent = {
      runLeadPlanning: async () => {
        if (state.holdPlanning) await state.planningGate;
        if (state.planningFailure) throw new Error("Injected retryable planning failure");
        if (state.permanentPlanningFailure) {
          state.permanentPlanningCalls += 1;
          throw new AgentFailure("model-unavailable", "The configured model is unavailable for the active provider account. Select a supported model, then retry.", { nonRetryable: true });
        }
        return { leadSessionRef: "session_integration", leadExecutionId: "agent_integration", leadEvidenceArtifactId: artifacts.integrationLeadEvidenceArtifactId, leadOutputArtifactId: artifacts.integrationLeadOutputArtifactId, leadOutputKind: "plan" as const, leadSummary: "Integration plan", materialCategories: state.planningMaterial ? ["security_permissions" as const] : [], material: state.planningMaterial, preservedWorktreeCompatibility: state.preservedWorktreeCompatibility };
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
        if (state.holdDeveloper) await state.developerGate;
        if (state.developerFailure) throw new AgentFailure("process-exited", "The agent invocation did not complete.");
        return { developerExecutionId: input.executionId ?? "developer_integration", developerSessionRef: "session_developer_integration", worktreePath: join(root, "worktrees", "issue-restart"), branchName: "forge/issue/issue-restart", targetBaseSha: "a".repeat(40), currentStep: 1, resultCommit: "b".repeat(40), resultTree: "c".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "artifact_delivery", evidenceArtifactId: "artifact_developer_evidence", deliverySummary: "Developer delivery", outcome: "completed" as const };
      },
      runRepair: async (input: DeveloperRepairActivityInput) => ({ outcome: "completed" as const, repairAttemptId: "delivery_repair_attempt_integration", cycle: input.cycle, reviewId: input.reviewId, subject: { planRevision: input.planRevision, targetBaseSha: input.targetBaseSha, subjectCommit: input.subjectCommit, subjectTree: input.subjectTree, developerExecutionId: input.developerExecutionId, deliveryArtifactId: "artifact_delivery", developerEvidenceArtifactId: "artifact_developer_evidence", leadSessionRef: input.leadSessionRef, developerSessionRef: input.developerSessionRef }, developerExecutionId: "developer_repair_integration", developerSessionRef: "session_developer_integration", worktreePath: join(root, "worktrees", "issue-restart"), branchName: "forge/issue/issue-restart", resultCommit: "d".repeat(40), resultTree: "e".repeat(40), dirtyState: "clean" as const, deliveryArtifactId: "artifact_repaired_delivery", evidenceArtifactId: "artifact_repaired_evidence", summary: "Developer repair" }),
    };
    const baseActivities = createActivities(database, config, { agent: integrationAgent, developer: integrationDeveloper });
    const integrationActivities = {
      ...baseActivities,
      async projectIssueState(event: Parameters<typeof baseActivities.projectIssueState>[0]) {
        return event.state.issueId.startsWith("ci-") && event.state.issueId !== "ci-provider-failure" ? event.state : baseActivities.projectIssueState(event);
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
        if (state.deadBuilderOnce) {
          state.deadBuilderOnce = false;
          return { status: "interrupted" as const, developerExecutionId: input.developerTurnExecutionId, reasonCode: "developer-child-missing", summary: "The recorded Builder PID is no longer running." };
        }
        const { worktreePath: _worktreePath, ...result } = await integrationDeveloper.run({ executionId: input.developerTurnExecutionId });
        void _worktreePath;
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
        if (input.taskId === "ci-provider-failure") return { ...common, evidenceArtifactId: artifacts.ciProviderEvidence.id, evidenceArtifactSha256: artifacts.ciProviderEvidence.sha256, outcome: "provider_unavailable" as const, reason: "provider_failure_budget_exhausted", owner: "human" as const, repairable: false, summary: "The CI provider did not return an authoritative result.", retryAt: null, nextPollAt: null };
        if (input.taskId === "ci-rate" && calls === 1) return { ...common, outcome: "rate_limited" as const, reason: "provider_rate_limited", owner: "system" as const, repairable: false, summary: "GitHub rate limit is active", retryAt, nextPollAt: retryAt };
        if (input.taskId === "ci-repair") return { ...common, outcome: "failed" as const, reason: "required_check_failed", owner: "lead" as const, repairable: true, summary: "Required check failed", retryAt: null, nextPollAt: null };
        return { ...common, outcome: "passed" as const, reason: "checks_passed", owner: null, repairable: false, summary: "All required checks passed", retryAt: null, nextPollAt: null };
      },
      async updateCiFromBase(input: Parameters<typeof baseActivities.updateCiFromBase>[0]) {
        if (!input.taskId.startsWith("ci-")) return baseActivities.updateCiFromBase(input);
        return { outcome: "no_drift" as const, summary: "The pull request base has not advanced" };
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
        return { finalReviewId: `final_review_${input.taskId}`, leadExecutionId: `agent_final_${input.taskId}`, leadSessionRef: input.leadSessionRef, opinionArtifactId: artifacts.integrationFinalReviewArtifactId, evidenceArtifactId: artifacts.integrationFinalReviewArtifactId, evidenceArtifactSha256: artifacts.integrationFinalReviewArtifactSha256, reviewArtifact: { artifactId: artifacts.integrationFinalReviewArtifactId, companyId: "issue-company", kind: "delivery-review" as const, sha256: artifacts.integrationFinalReviewArtifactSha256, byteSize: 1, mimeType: "application/json" }, outcome: "approved" as const, summary: "Exact release approved", findings: [] };
      },
      async findActiveDeveloperExecution() { return null; },
      async preparePlanRevision(input: Parameters<typeof baseActivities.preparePlanRevision>[0]) {
        const revisionRequestId = `revision_${input.workflowId}_${input.requestRevision}`;
        return state.revisionDisposition === "reuse"
          ? { status: "accepted" as const, revisionRequestId, coordinates: { disposition: "reuse" as const, revisionRequestId, developerExecutionId: "developer-preserved", branchName: "forge/issue/preserved", baseSha: "a".repeat(40), headSha: "b".repeat(40), treeSha: "c".repeat(40), dirtyState: "clean" as const } }
          : { status: "accepted" as const, revisionRequestId, coordinates: { disposition: "new" as const, revisionRequestId, exactBaseSha: input.exactBaseSha ?? "a".repeat(40) } };
      },
      async authorizePlanRevision() { state.revisionAuthorizationCalls += 1; },
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
    if ((await api.app.inject({ method: "GET", url: "/api/auth/status" })).statusCode !== 200) throw new Error("Forge server health check failed");


      restartActivitiesFactory = (reopenedDatabase) => createActivities(reopenedDatabase, config, { agent: integrationAgent, developer: integrationDeveloper });
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('issue-admin', 'Issue Admin', 'issue-admin@forge.local', 'admin', 'active', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('issue-company', 'Issue Company', 'active', ?)").run(new Date().toISOString());
      db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile', 'Integration profile', 'codex', 'gpt-5.6-sol', 'medium', 'standard', 2, ?, ?)").run(new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('issue-project', 'issue-company', 'Issue Project', ?, ?, 'acme/forge', 'main', 'main', 'pnpm install', 'pnpm test', '[\"Tests / unit\"]', '{}', 'active', 'issue-revision', ?, ?)").run(join(root, "repo"), join(root, "worktrees"), new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, base_sha, target_sha, actor_user_id, created_at) VALUES ('issue-revision', 'issue-project', 1, 'issue-identity', ?, ?, ?, 'issue-admin', ?)").run(JSON.stringify({ repository: "acme/forge", repositoryPath: join(root, "repo"), worktreeRoot: join(root, "worktrees"), baseBranch: "main", targetBranch: "main", baseSha: "a".repeat(40), targetSha: "b".repeat(40), setupCommand: "pnpm install", verificationCommand: "pnpm test", requiredChecks: ["Tests / unit"] }), "a".repeat(40), "b".repeat(40), new Date().toISOString());
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('issue-brief', 'issue-company', 'task-brief', 'task.md', 'text/markdown', 4, ?, 'issue-company/issue-brief.bin', ?)").run("0".repeat(64), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-restart', 'issue-company', 'issue-project', 'Restart issue', 'issue-brief', '[]', ?, 0, ?, 'issue-revision', 'issue-restart-key', ?, ?)").run(JSON.stringify(issueRoleProfiles), `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-restart`, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-continuation', 'issue-company', 'issue-project', 'Continue issue', 'issue-brief', '[]', ?, 0, ?, 'issue-revision', 'issue-continuation-key', ?, ?)").run(JSON.stringify(issueRoleProfiles), `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-continuation`, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-permanent-failure', 'issue-company', 'issue-project', 'Permanent failure issue', 'issue-brief', '[]', ?, 0, ?, 'issue-revision', 'issue-permanent-failure-key', ?, ?)").run(JSON.stringify(issueRoleProfiles), `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-permanent-failure`, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-start-failure', 'issue-company', 'issue-project', 'Developer start failure', 'issue-brief', '[]', ?, 0, ?, 'issue-revision', 'issue-start-failure-key', ?, ?)").run(JSON.stringify(issueRoleProfiles), `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-start-failure`, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-developer-failure', 'issue-company', 'issue-project', 'Developer activity failure', 'issue-brief', '[]', ?, 0, ?, 'issue-revision', 'issue-developer-failure-key', ?, ?)").run(JSON.stringify(issueRoleProfiles), `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-developer-failure`, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('issue-failed-retry', 'issue-company', 'issue-project', 'Failed retry issue', 'issue-brief', '[]', ?, 0, ?, 'issue-revision', 'issue-failed-retry-key', ?, ?)").run(JSON.stringify(issueRoleProfiles), `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-issue-failed-retry`, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('ci-provider-failure', 'issue-company', 'issue-project', 'CI provider failure issue', 'issue-brief', '[]', ?, 0, ?, 'issue-revision', 'ci-provider-failure-key', ?, ?)").run(JSON.stringify(issueRoleProfiles), `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-ci-provider-failure`, new Date().toISOString(), new Date().toISOString());
    });
    artifacts.ciProviderEvidence = await new ArtifactStore(config.artifactRoot).put("issue-company", "ci-evidence", { filename: "ci-provider-failure.json", mimeType: "application/json", bytes: Buffer.from('{"code":"provider_failure","summary":"The CI provider did not return an authoritative result."}', "utf8") });
    const leadOutput = await new ArtifactStore(config.artifactRoot).put("issue-company", "lead-plan", { filename: "integration-plan.json", mimeType: "application/json", bytes: Buffer.from('{"kind":"plan","summary":"Integration plan"}', "utf8") });
    const leadEvidence = await new ArtifactStore(config.artifactRoot).put("issue-company", "agent-evidence", { filename: "integration-evidence.json", mimeType: "application/json", bytes: Buffer.from('{"summary":"Integration evidence"}', "utf8") });
    const finalReviewEvidence = await new ArtifactStore(config.artifactRoot).put("issue-company", "delivery-review", { filename: "final-review.json", mimeType: "application/json", bytes: Buffer.from('{"kind":"delivery_review","summary":"Exact release approved","outcome":"approved","findings":[],"repairPlan":null}', "utf8") });
    artifacts.integrationLeadOutputArtifactId = leadOutput.id;
    artifacts.integrationLeadEvidenceArtifactId = leadEvidence.id;
    artifacts.integrationFinalReviewArtifactId = finalReviewEvidence.id;
    artifacts.integrationFinalReviewArtifactSha256 = finalReviewEvidence.sha256;
    database.authQuery((db) => {
      for (const artifact of [artifacts.ciProviderEvidence, leadOutput, leadEvidence, finalReviewEvidence]) db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
    });

      started = true;
    } catch (error) {
      await stop();
      throw error;
    }
  }

  async function restartWorker(): Promise<void> {
    if (!config || !worker || !workerRun || !workerConnection || !database || !api || !workflowBundle || !restartActivitiesFactory) throw new Error("Temporal harness is not started");
    worker.shutdown();
    await workerRun;
    worker = undefined;
    workerRun = undefined;
    await workerConnection.close();
    workerConnection = undefined;
    database.close();
    database = undefined;
    await api.app.close();
    api.database.close();
    api = undefined;
    database = new ForgeDatabase(config.databasePath);
    workerConnection = await NativeConnection.connect({ address: config.temporalAddress });
    worker = await Worker.create({ connection: workerConnection, namespace: config.temporalNamespace, taskQueue: config.taskQueue, workflowBundle, dataConverter: temporalDataConverter, interceptors: { activity: activityPayloadInterceptors }, activities: restartActivitiesFactory(database) });
    workerRun = worker.run();
    api = await createForgeServer(config);
  }

  return {
    start, stop, restartWorker,
    get root() { if (!root) throw new Error("Temporal harness is not started"); return root; },
    get config() { if (!config) throw new Error("Temporal harness is not started"); return config; },
    get database() { if (!database) throw new Error("Temporal harness is not started"); return database; },
    get workerConnection() { if (!workerConnection) throw new Error("Temporal harness is not started"); return workerConnection; },
    state, artifacts, issueRoleProfiles, ciCalls, ciPlanInputs, ciRepairInputs,
  };
}
