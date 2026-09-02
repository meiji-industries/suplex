import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect, test } from "vitest";

import { AuthService } from "../src/auth.js";
import { buildInitialIssueWorkflowState, IssueWorkflowStateSchema, type IssueWorkflowInput, type IssueWorkflowState } from "../src/engine/issue-contracts.js";
import { CancelledFailure } from "../src/engine/failures.js";
import { continueIssueWork, executeIssueCommand, reviseIssuePlan, startIssueWorkflow } from "../src/engine/service.js";
import { TaskService, type IssueWorkflowPort } from "../src/tasks.js";
import { at } from "../src/issue-phases.js";
import { createEngineHarness, engineFixture, ImmediateClock, type EngineHarness } from "./helpers/engine-harness.js";

function seedContinuation(harness: EngineHarness, issueId: string, fields: Partial<IssueWorkflowState>): IssueWorkflowState {
  harness.seedTask(issueId);
  const workflowId = harness.workflowId(issueId);
  const initial = IssueWorkflowStateSchema.parse(buildInitialIssueWorkflowState({ workflowId, companyId: engineFixture.companyId, projectId: engineFixture.projectId, issueId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: "b".repeat(64), roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }));
  harness.database.projectIssueEvent({ schemaVersion: 1, runId: `seed-${issueId}`, eventId: initial.lastEventId, state: initial });
  const continuation = IssueWorkflowStateSchema.parse({ ...initial, revision: 1, lastEventId: `${workflowId}:1`, ...fields });
  harness.database.projectIssueEvent({ schemaVersion: 1, runId: `seed-${issueId}`, eventId: continuation.lastEventId, state: continuation });
  return continuation;
}

function workflowInput(state: IssueWorkflowState): Omit<IssueWorkflowInput, "workflowId"> & { workflowId: string } {
  return { workflowId: state.workflowId, companyId: state.companyId, projectId: state.projectId, issueId: state.issueId, projectRevisionId: state.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], roleProfiles: engineFixture.roleProfiles, supplementalReview: false, continuationState: state };
}

test("TaskService consumes atomic engine projections for decision, revise-plan, and continue-work commands", async () => {
  let harness!: EngineHarness;
  harness = await createEngineHarness({
    projectIssueState: async (event) => { harness.database.projectIssueEvent(event); return event.state; },
    recordPlanDecision: async () => ({ decisionId: "decision-task-service" }),
    runLeadPlanning: async () => ({ leadExecutionId: "lead-revised", leadSessionRef: "lead-session", leadOutputArtifactId: "plan-revised", leadEvidenceArtifactId: "evidence-revised", leadOutputArtifactSha256: "d".repeat(64), leadOutputKind: "plan", leadSummary: "Revised plan", materialCategories: ["security_permissions"], material: true }),
    preparePlanRevision: async () => ({ status: "blocked", revisionRequestId: "revision-request-task-service", blockerCode: "test-blocker" }),
    createSuccessor: async (input) => {
      const now = "2026-08-30T12:00:00.000Z";
      harness.database.authQuery((db) => db.prepare(`INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, predecessor_task_id, created_at, updated_at)
        SELECT ?, company_id, project_id, ?, brief_artifact_id, image_artifact_ids_json, role_agents_json, 0, ?, project_revision_id, ?, ?, id, ?, ? FROM forge_tasks WHERE id = ?`).run(input.successorTaskId, `Continue: ${input.predecessorTaskId}`, input.successorWorkflowId, `continue-${input.intentId}`, "c".repeat(64), now, now, input.predecessorTaskId));
      const successor = IssueWorkflowStateSchema.parse(buildInitialIssueWorkflowState({ workflowId: input.successorWorkflowId, companyId: input.companyId, projectId: input.projectId, issueId: input.successorTaskId, predecessorTaskId: input.predecessorTaskId, projectRevisionId: engineFixture.projectRevisionId, briefArtifactId: engineFixture.briefArtifactId, briefSha256: engineFixture.sha256, imageArtifactIds: [], requestHash: "c".repeat(64), roleProfiles: engineFixture.roleProfiles, supplementalReview: false, repairCycleLimit: 2 }));
      harness.database.projectIssueEvent({ schemaVersion: 1, runId: `${input.successorWorkflowId}:creation`, eventId: successor.lastEventId, state: successor });
      return { successorTaskId: input.successorTaskId, successorWorkflowId: input.successorWorkflowId, predecessorTaskId: input.predecessorTaskId, projectRevisionId: engineFixture.projectRevisionId, creationRevision: input.acceptedRevision };
    },
  }, new class extends ImmediateClock {
    override wait(_milliseconds: number, signal: AbortSignal): Promise<void> {
      return new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(new CancelledFailure());
        else signal.addEventListener("abort", () => reject(new CancelledFailure()), { once: true });
      });
    }
  }());
  const brief = Buffer.from("TaskService engine integration brief"), storagePath = `${engineFixture.companyId}/objects/task-service/brief.md`, briefSha256 = createHash("sha256").update(brief).digest("hex");
  await mkdir(dirname(join(harness.config.artifactRoot, storagePath)), { recursive: true });
  await writeFile(join(harness.config.artifactRoot, storagePath), brief);
  harness.database.authQuery((db) => db.prepare("UPDATE forge_artifacts SET byte_size = ?, sha256 = ?, storage_path = ? WHERE id = ?").run(brief.byteLength, briefSha256, storagePath, engineFixture.briefArtifactId));
  try {
    const decisionIssueId = "task-service-decision", decisionWorkflowId = harness.workflowId(decisionIssueId);
    const finalPlanSubject = { companyId: engineFixture.companyId, issueId: decisionIssueId, workflowId: decisionWorkflowId, originalPlanRevision: 1, outputId: "plan-output", outputRevision: 1, finalVersion: 1 as const, artifactId: "plan-artifact", artifactSha256: "d".repeat(64), leadSessionRef: "lead-session", leadExecutionId: "lead-original", evidenceManifestArtifactId: "plan-evidence", evidenceManifestSha256: "e".repeat(64) };
    const approval = seedContinuation(harness, decisionIssueId, { ...at("approval"), owner: "human", allowedCommands: ["approve_plan", "request_plan_revision", "cancel_issue"], pendingAction: "Approve final plan", planRevision: 1, planMaterial: true, leadSessionRef: "lead-session", leadOutputArtifactId: "plan-artifact", finalPlanSubject });
    const revision = seedContinuation(harness, "task-service-revision", { ...at("approval"), owner: "human", allowedCommands: ["approve_plan", "request_plan_revision", "revise_plan", "cancel_issue"], pendingAction: "Approve final plan", planRevision: 1, planMaterial: true, leadSessionRef: "lead-session", leadOutputArtifactId: "plan-artifact" });
    const done = seedContinuation(harness, "task-service-continue", { ...at("done"), owner: "human", allowedCommands: ["continue_work"], pendingAction: "Done" });
    await Promise.all([startIssueWorkflow(harness.config, workflowInput(approval)), startIssueWorkflow(harness.config, workflowInput(revision)), startIssueWorkflow(harness.config, workflowInput(done))]);
    for (const workflowId of [approval.workflowId, revision.workflowId, done.workflowId]) harness.engine.run(workflowId);
    const auth = new AuthService(harness.database, harness.config);
    const workflow: Pick<IssueWorkflowPort, "execute" | "revisePlan" | "continueWork" | "acceptDevelopment"> = {
      execute: (command, workflowId, input) => executeIssueCommand(harness.config, workflowId, command, input),
      revisePlan: (workflowId, input) => reviseIssuePlan(harness.config, workflowId, input),
      continueWork: (workflowId, input) => continueIssueWork(harness.config, workflowId, input),
      acceptDevelopment: async () => { throw new Error("Developer admission unavailable in integration fixture"); },
    };
    const tasks = new TaskService(harness.database, auth, {} as never, harness.config, { workflow: workflow as IssueWorkflowPort });
    const decisionCurrent = tasks.getTask(engineFixture.actorUserId, approval.issueId);
    const decided = await tasks.executeCommand(engineFixture.actorUserId, approval.issueId, "request_plan_revision", { expectedRevision: decisionCurrent.revision, note: "Revise the plan", idempotencyKey: "task-service-decision-key" });
    expect(decided.phase).toBe("approval");
    expect(decided.revision).toBeGreaterThan(decisionCurrent.revision);

    const revisionCurrent = tasks.getTask(engineFixture.actorUserId, revision.issueId);
    const revised = await tasks.revisePlan(engineFixture.actorUserId, revision.issueId, { expectedRevision: revisionCurrent.revision, actorUserId: engineFixture.actorUserId, reason: "Rework the plan", worktreeDisposition: "reuse" });
    expect(revised).toMatchObject({ phase: "building", step: "development", blocked: true, pendingAction: "Plan revision is blocked" });
    expect(revised.revision).toBeGreaterThan(revisionCurrent.revision);

    const doneCurrent = tasks.getTask(engineFixture.actorUserId, done.issueId);
    const continued = await tasks.continueWork(engineFixture.actorUserId, done.issueId, doneCurrent.revision, "Continue with follow-up work");
    expect(continued.original.phase).toBe("done");
    expect(continued.original.revision).toBeGreaterThan(doneCurrent.revision);
    expect(continued.successor).toMatchObject({ id: `${done.issueId}-successor-${doneCurrent.revision}`, phase: "backlog", revision: 0 });
  } finally {
    await harness.stop();
  }
});
