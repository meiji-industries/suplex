import { NativeConnection, Worker } from "@temporalio/worker";

import { createTestConfig, type ForgeConfig } from "../../src/config.js";
import { ForgeDatabase } from "../../src/database.js";
import { CapacityManager } from "../../src/capacity.js";
import { DeveloperExecutionLeaseRepository } from "../../src/developer-execution-leases.js";
import { runDeveloperTurn } from "../../src/developer-turn-runner.js";
import { activityPayloadInterceptors } from "../../src/temporal/payload-boundary-interceptors.js";
import { buildProductionWorkflowBundle, temporalDataConverter } from "../../src/temporal/workflow-bundle.js";
import type { DeveloperExecutionActivityInput, IssueProjectionEvent, IssueWorkflowState, LeadPlanningActivityInput, SupervisedDeveloperExecutionActivityInput } from "../../src/temporal/issue-contracts.js";

interface WorkerOptions {
  dataRoot: string;
  temporalAddress: string;
  temporalNamespace: string;
  taskQueue: string;
  installationId: string;
  externalTurnCapacity: number;
  fixturePath: string;
  outputPath: string;
  launchCountPath: string;
  canonicalWorktreePath: string;
  worktreeIdentityHash: string;
}

function configFor(options: WorkerOptions): ForgeConfig {
  return createTestConfig(options.dataRoot, {
    temporalAddress: options.temporalAddress,
    temporalNamespace: options.temporalNamespace,
    taskQueue: options.taskQueue,
    installationId: options.installationId,
    externalTurnCapacity: options.externalTurnCapacity,
  });
}

async function main(): Promise<void> {
  const options = JSON.parse(process.argv[2] ?? "") as WorkerOptions;
  const config = configFor(options);
  const database = new ForgeDatabase(config.databasePath);
  const capacity = new CapacityManager(database, config);
  capacity.reconcileFromLedgers();

  const projectIssueState = async (event: IssueProjectionEvent): Promise<IssueWorkflowState> => {
    database.projectIssueEvent(event);
    database.observeIssueProjection(event);
    return event.state;
  };

  const runLeadPlanning = async (input: LeadPlanningActivityInput) => ({
    leadSessionRef: "proof-lead-session",
    leadExecutionId: "proof-lead-execution",
    leadEvidenceArtifactId: "proof-evidence",
    leadOutputArtifactId: "proof-delivery",
    leadOutputKind: "plan" as const,
    leadSummary: `Production worker-loss proof for ${input.taskId}`,
    materialCategories: ["production_operation" as const],
    material: true,
  });

  const recordPlanDecision = async (input: { taskId: string; companyId: string; workflowId: string; planRevision: number; actorUserId: string; decision: "approve" | "reject" }) => {
    database.authTransaction((db) => db.prepare(`INSERT OR IGNORE INTO forge_plan_decisions
      (id, task_id, company_id, workflow_id, plan_revision, decision, actor_user_id, note_artifact_id, created_at)
      VALUES ('proof-plan-decision', ?, ?, ?, ?, ?, ?, 'proof-delivery', ?)`)
      .run(input.taskId, input.companyId, input.workflowId, input.planRevision, input.decision, input.actorUserId, new Date().toISOString()));
    return { decisionId: "proof-plan-decision" };
  };

  const runDeveloperExecution = async (input: DeveloperExecutionActivityInput) => {
    if (!input.developerExecutionId || input.developerAttempt === undefined || !input.turnKind) throw new Error("Proof Developer input lacks supervisor coordinates");
    database.authTransaction((db) => {
      db.prepare(`INSERT OR IGNORE INTO forge_developer_executions
        (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
        .run(input.developerExecutionId, input.taskId, input.companyId, input.workflowId, input.planRevision, input.developerAttempt, `forge/issue/${input.taskId}`, options.canonicalWorktreePath, "a".repeat(40), new Date().toISOString(), new Date().toISOString());
    });
    const request = capacity.request({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, turnKind: "developer" });
    const admitted = capacity.tryAcquire(request.id);
    if (!admitted.acquired) throw new Error("proof capacity was not acquired");
    try {
      const result = await runDeveloperTurn({
        database,
        config,
        executionId: input.developerExecutionId,
        developerAttempt: input.developerAttempt,
        planRevision: input.planRevision,
        turnKind: input.turnKind,
        companyId: input.companyId,
        taskId: input.taskId,
        workflowId: input.workflowId,
        canonicalWorktreePath: options.canonicalWorktreePath,
        worktreeIdentityHash: options.worktreeIdentityHash,
        command: process.execPath,
        args: [options.fixturePath, "--duration", "7000", "--heartbeat-interval", "50", "--output", options.outputPath, "--launch-count", options.launchCountPath],
        cwd: config.dataRoot,
        env: { PATH: process.env.PATH ?? "" },
      });
      if (result.terminal !== "result") throw new Error(`proof Developer turn ended ${result.terminal}`);
      const delivery = {
        developerExecutionId: input.developerExecutionId,
        developerSessionRef: "proof-developer-session",
        worktreePath: options.canonicalWorktreePath,
        branchName: `forge/issue/${input.taskId}`,
        targetBaseSha: "a".repeat(40),
        currentStep: 1,
        resultCommit: "b".repeat(40),
        resultTree: "c".repeat(40),
        dirtyState: "clean" as const,
        deliveryArtifactId: "proof-delivery",
        evidenceArtifactId: "proof-evidence",
        deliverySummary: "Production issueWorkflow worker-loss proof delivery",
        outcome: "completed" as const,
      };
      const repository = new DeveloperExecutionLeaseRepository(database, config.runtimeRoot);
      const claim = repository.claim({ executionId: input.developerExecutionId, resultHash: result.resultHash, activityResultJson: JSON.stringify(delivery), deliveryArtifactId: delivery.deliveryArtifactId, evidenceArtifactId: delivery.evidenceArtifactId });
      if (claim.conflict) throw new Error("proof result claim conflict");
      database.authQuery((db) => db.prepare(`UPDATE forge_developer_executions SET status = 'completed', finished_at = ?, session_ref = ?, current_step = ?, result_commit = ?, result_tree = ?, dirty_state = ?, delivery_artifact_id = ?, evidence_artifact_id = ? WHERE id = ?`).run(new Date().toISOString(), delivery.developerSessionRef, delivery.currentStep, delivery.resultCommit, delivery.resultTree, delivery.dirtyState, delivery.deliveryArtifactId, delivery.evidenceArtifactId, input.developerExecutionId));
      return delivery;
    } finally {
      const active = database.authQuery((db) => Boolean((db.prepare("SELECT 1 FROM forge_developer_execution_leases WHERE execution_id = ? AND status IN ('reserved', 'supervisor_starting', 'running', 'result_ready', 'cancel_requested', 'cancelling')").get(input.developerExecutionId) as { 1: number } | undefined)));
      if (!active) capacity.release(request.id, "developer-result-claimed");
    }
  };

  const runDeveloperExecutionSupervised = async (input: SupervisedDeveloperExecutionActivityInput) => {
    const result = await runDeveloperExecution({ ...input, developerExecutionId: input.developerTurnExecutionId, developerAttempt: input.developerAttempt, turnKind: input.turnKind });
    const claim = new DeveloperExecutionLeaseRepository(database, config.runtimeRoot).readClaim(input.developerTurnExecutionId);
    if (!claim) throw new Error("Proof Developer result claim is unavailable");
    return { status: "completed" as const, result, resultHash: claim.resultHash };
  };

  const connection = await NativeConnection.connect({ address: config.temporalAddress });
  const worker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.taskQueue,
    workflowBundle: await buildProductionWorkflowBundle(),
    dataConverter: temporalDataConverter,
    interceptors: { activity: activityPayloadInterceptors },
    activities: { projectIssueState, runLeadPlanning, recordPlanDecision, runDeveloperExecution, runDeveloperExecutionSupervised },
  });
  process.stdout.write("WORKER_READY\n");
  await worker.run();
  database.close();
  await connection.close();
}

await main();
