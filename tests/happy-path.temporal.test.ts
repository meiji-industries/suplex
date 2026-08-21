import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterEach, expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import type { PlanBlockerSubject, PlanSubject } from "../src/plan-governance.js";
import type { IssueActivities, IssueWorkflowInput, IssueWorkflowState } from "../src/temporal/issue-contracts.js";
import { issueStateQuery, issueWorkflow, respondPlanBlockerUpdate, startPlanningUpdate } from "../src/temporal/workflows.js";
import { createIssueActivitiesFake } from "./fakes/issue-activities.js";
import { createImmediateCapacityActivities } from "./immediate-capacity-activities.js";

const workflowsPath = fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url));

const sha256 = "a".repeat(64);
const commit = "b".repeat(40);
const tree = "c".repeat(40);
const baseSha = "d".repeat(40);
const companyId = "company-happy";
const projectId = "project-happy";
const issueId = "task-happy";
const workflowId = "workflow-happy";
const projectRevisionId = "revision-happy";
const briefArtifactId = "artifact-happy-brief";
const finalReviewArtifactId = "artifact-happy-final-review";
const decisionNoteArtifactId = "artifact-happy-decision-note";
const actorUserId = "member-happy";
const taskQueue = "happy-path";

const blockerSubject: PlanBlockerSubject = {
  companyId,
  issueId,
  workflowId,
  artifactId: "artifact-happy-blocker",
  artifactSha256: sha256,
  leadSessionRef: "lead-session-happy",
  leadExecutionId: "lead-execution-blocker",
  evidenceManifestArtifactId: "artifact-happy-blocker-manifest",
  evidenceManifestSha256: sha256,
  category: "human_decision",
  resumePhase: "planning",
};

const planSubject: PlanSubject = {
  companyId,
  issueId,
  workflowId,
  originalPlanRevision: 3,
  outputId: "plan-output-happy",
  outputRevision: 3,
  finalVersion: 1,
  artifactId: "artifact-happy-plan",
  artifactSha256: sha256,
  leadSessionRef: "lead-session-happy",
  leadExecutionId: "lead-execution-plan",
  evidenceManifestArtifactId: "artifact-happy-plan-manifest",
  evidenceManifestSha256: sha256,
};

/** The rows applyIssueProjection reads: the task identity and the evidence the attention policy pins. */
function fixture(database: ForgeDatabase): void {
  const now = "2026-08-20T00:00:00.000Z";
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES (?, ?, 'active', ?)").run(companyId, "Happy Company", now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)").run(projectId, companyId, "Happy Project", "/tmp/happy-repo", "/tmp/happy-worktrees", "main", "main", "true", "true", "[]", "{}", projectRevisionId, now, now);
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES (?, ?, ?, 'admin', 'active', ?, ?)").run(actorUserId, "Happy Member", "happy@forge.local", now, now);
    for (const [id, kind] of [[briefArtifactId, "task-brief"], [finalReviewArtifactId, "delivery-review"], [decisionNoteArtifactId, "decision-note"]] as const) {
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, 'application/json', 1, ?, ?, ?)").run(id, companyId, kind, `${id}.json`, sha256, `${companyId}/objects/aa/${id}.bin`, now);
    }
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', '{}', 0, ?, ?, ?, ?, ?)").run(issueId, companyId, projectId, "Happy task", briefArtifactId, workflowId, projectRevisionId, "happy-key", now, now);
  });
}

let environment: TestWorkflowEnvironment | undefined;
let root = "";
let database: ForgeDatabase | undefined;

afterEach(async () => {
  await environment?.teardown();
  environment = undefined;
  database?.close();
  database = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

test("a task created with auto-approve and auto-merge runs from Backlog to Done without a second human click", { timeout: 180_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  root = await mkdtemp(join(tmpdir(), "forge-happy-path-"));
  database = new ForgeDatabase(join(root, "forge.sqlite"));
  fixture(database);
  const projectedDatabase = database;

  const projections: IssueWorkflowState[] = [];
  const calls = new Map<string, number>();
  const counted = <Input, Output>(name: string, fn: (input: Input) => Promise<Output>) => async (input: Input): Promise<Output> => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
    return fn(input);
  };
  const capacity = createImmediateCapacityActivities();
  let planningTurn = 0;

  const activities: Partial<IssueActivities> = {
    ...capacity.activities,
    // The projection the UI reads: the real sqlite writer, integrity guards and unique constraints included.
    projectIssueState: async (event) => {
      calls.set(`projectIssueState:${event.eventId}`, (calls.get(`projectIssueState:${event.eventId}`) ?? 0) + 1);
      projectedDatabase.projectIssueEvent(event);
      projectedDatabase.observeIssueProjection(event);
      projections.push(structuredClone(event.state));
      return event.state;
    },
    runLeadPlanning: counted("runLeadPlanning", async () => {
      planningTurn += 1;
      const common = { leadSessionRef: "lead-session-happy", leadEvidenceArtifactId: "artifact-happy-lead-evidence", leadOutputArtifactSha256: sha256 };
      if (planningTurn === 1) {
        return { ...common, leadExecutionId: "lead-execution-blocker", leadOutputArtifactId: "artifact-happy-blocker", leadOutputKind: "decision_blocker" as const, leadSummary: "Which retention window applies?", materialCategories: [], material: false, blockedCategory: "human_decision" as const, unblockOwner: "human" as const, resumePhase: "planning" as const, blockerSubject };
      }
      return { ...common, leadExecutionId: "lead-execution-plan", leadOutputArtifactId: "artifact-happy-plan", leadOutputKind: "plan" as const, leadSummary: "Material plan after the blocker answer", materialCategories: ["security_permissions" as const], material: true, planSubject, materialityEvidence: { categories: ["security_permissions" as const], artifactId: "artifact-happy-materiality", artifactSha256: sha256 } };
    }),
    recordPlanBlockerResponse: counted("recordPlanBlockerResponse", async () => ({ responseId: "blocker-response-happy", subjectHash: sha256, answerArtifactId: "artifact-happy-answer", answerArtifactSha256: sha256 })),
    // The real activity writes a durable decision row; forge_issue_governance.decision_id points at it.
    recordPlanDecision: counted("recordPlanDecision", async (input) => {
      projectedDatabase.authQuery((db) => db.prepare("INSERT OR IGNORE INTO forge_plan_decisions (id, task_id, company_id, workflow_id, plan_revision, decision, actor_user_id, note_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("decision-happy", issueId, companyId, workflowId, input.planRevision, input.decision, input.actorUserId, decisionNoteArtifactId, "2026-08-20T00:00:00.000Z"));
      return { decisionId: "decision-happy", subjectHash: sha256 };
    }),
    authorizeFinalPlan: counted("authorizeFinalPlan", async () => ({ authorizationId: "authorization-happy", planRevision: planSubject.outputRevision, planArtifactId: planSubject.artifactId, planArtifactSha256: sha256, authorizationKind: "human_approval" as const, approvalDecisionId: "decision-happy", authorizedAt: "2026-08-20T00:00:00.000Z" })),
    runDeveloperExecutionSupervised: counted("runDeveloperExecutionSupervised", async () => ({
      status: "completed" as const,
      resultHash: sha256,
      result: { developerExecutionId: "developer-execution-happy", developerSessionRef: "developer-session-happy", branchName: "forge/issue/task-happy", targetBaseSha: baseSha, currentStep: null, resultCommit: commit, resultTree: tree, dirtyState: "clean" as const, deliveryArtifactId: "artifact-happy-delivery", evidenceArtifactId: "artifact-happy-developer-evidence", deliverySummary: "Implemented the auto-approved plan", outcome: "completed" as const },
    })),
    reviewDelivery: counted("reviewDelivery", async (input) => ({
      outcome: "completed" as const,
      attemptId: "delivery-review-attempt-happy",
      correctionAttempts: 0,
      subject: input.subject,
      review: { reviewId: "delivery-review-happy", leadExecutionId: "lead-execution-review", leadSessionRef: "lead-session-happy", opinionArtifactId: "artifact-happy-review-opinion", evidenceArtifactId: "artifact-happy-review-evidence", opinion: "approved" as const, summary: "The exact delivery matches the approved plan.", repairPlan: null, findings: [], supersedesReviewId: null, reviewArtifact: { artifactId: finalReviewArtifactId, companyId, kind: "delivery-review" as const, sha256, byteSize: 1, mimeType: "application/json" } },
    })),
    reconcileTargetBase: counted("reconcileTargetBase", async (input) => ({ outcome: "no_drift" as const, checkId: `target-base-${input.checkpoint}`, checkpoint: input.checkpoint, expectedBaseSha: input.expectedBaseSha, observedBaseSha: input.expectedBaseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree })),
    publishRelease: counted("publishRelease", async () => ({ outcome: "completed" as const, repository: "acme/forge", branchName: "forge/issue/task-happy", headSha: commit, headTree: tree, reused: false, attempt: 0, releaseId: "release-happy", baseBranch: "main", pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", isDraft: false, targetBaseSha: baseSha })),
    reconcileCi: counted("reconcileCi", async (input) => ({ runId: "ci-run-happy", attemptId: "ci-attempt-happy", attemptNumber: input.attemptNumber, expectedHeadSha: input.expectedHeadSha, observedHeadSha: input.expectedHeadSha, evidenceArtifactId: "artifact-happy-ci-evidence", outcome: "passed" as const, reason: "checks_passed", owner: null, repairable: false, summary: "All required checks passed", retryAt: null, nextPollAt: null, policyHash: "f".repeat(64), propagationDeadline: null, overallDeadline: null })),
    finalReview: counted("finalReview", async (input) => ({ finalReviewId: "final-review-happy", leadExecutionId: "lead-execution-final", leadSessionRef: input.leadSessionRef, opinionArtifactId: finalReviewArtifactId, evidenceArtifactId: finalReviewArtifactId, evidenceArtifactSha256: sha256, reviewArtifact: { artifactId: finalReviewArtifactId, companyId, kind: "delivery-review" as const, sha256, byteSize: 1, mimeType: "application/json" }, outcome: "approved" as const, summary: "Exact release approved", findings: [], repairPlan: null, repairPlanArtifactId: null, repairPlanSha256: null })),
    acceptDelivery: counted("acceptDelivery", async () => ({ acceptanceId: "acceptance-happy", status: "accepted" as const, outcome: "ready" as const, retryAt: null, readyAt: "2026-08-20T00:00:00.000Z", acceptedAt: "2026-08-20T00:00:00.000Z", evidenceArtifactId: null, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", reasonArtifactId: null })),
    reconcileMerge: counted("reconcileMerge", async () => ({ outcome: "merged" as const, pullRequestNumber: 42, pullRequestUrl: "https://github.com/acme/forge/pull/42", mergeObservationId: "merge-observation-happy", completionReceiptId: "completion-receipt-happy", observedAt: "2026-08-20T00:00:00.000Z", mergedAt: "2026-08-20T00:00:00.000Z", retryAt: null })),
  };

  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue, workflowsPath, activities: createIssueActivitiesFake(activities) as unknown as Record<string, (...args: never[]) => unknown> });
  const workerRun = worker.run();
  try {
    const input: IssueWorkflowInput = {
      workflowId,
      companyId,
      projectId,
      issueId,
      projectRevisionId,
      briefArtifactId,
      briefSha256: sha256,
      imageArtifactIds: [],
      roleProfiles: { planner: "profile-planner", builder: "profile-builder" },
      supplementalReview: false,
      autoApprovePlan: true,
      autoApprovePlanActorUserId: actorUserId,
      pullRequestMode: "auto_merge",
      autoMergeActorUserId: actorUserId,
    };
    const handle = await environment.client.workflow.start(issueWorkflow, { workflowId, taskQueue, args: [input] });

    // The invariant that broke in production: the Workflow never holds a revision the
    // projection never saw. Polled because the Workflow keeps running between checks.
    const projectionAgreesWithWorkflow = async (): Promise<string> => {
      const queried = await handle.query(issueStateQuery);
      const projected = projections.find((state) => state.revision === queried.revision);
      if (!projected) return `workflow is at revision ${queried.revision} (${queried.phase}) with no projection`;
      if (projected.phase !== queried.phase) return `projection ${projected.revision} says ${projected.phase}; workflow says ${queried.phase}`;
      const row = projectedDatabase.authQuery((db) => db.prepare("SELECT revision, phase FROM forge_issue_projections WHERE task_id = ?").get(issueId)) as { revision: number; phase: string } | undefined;
      if (!row) return "the UI projection row is missing";
      if (row.revision > queried.revision) return `the UI shows revision ${row.revision}; the workflow only reached ${queried.revision}`;
      return "agrees";
    };
    const settled = async (): Promise<IssueWorkflowState> => {
      await expect.poll(projectionAgreesWithWorkflow, { timeout: 30_000 }).toBe("agrees");
      return handle.query(issueStateQuery);
    };

    const blocked = await handle.executeUpdate(startPlanningUpdate, { args: [{ expectedRevision: 0, actorUserId, commandId: "happy-start-planning" }], updateId: "happy-start-planning" });
    expect(blocked).toMatchObject({ phase: "blocked", owner: "human", planBlockerSubject: blockerSubject });
    expect(blocked.allowedCommands).toContain("respond_plan_blocker");
    await settled();

    // One answer is the only other thing a member does. Auto-approve carries it to a delivery.
    const delivered = await handle.executeUpdate(respondPlanBlockerUpdate, {
      args: [{ expectedRevision: blocked.revision, expectedWorkflowRevision: blocked.revision, actorUserId, answerStagingRef: "staging-happy-answer", answerSha256: sha256, idempotencyKey: "happy-blocker-answer" }],
      updateId: "happy-blocker-response",
    });
    expect(delivered).toMatchObject({ phase: "delivery_ready", developerOutcome: "completed", developerExecutionId: "developer-execution-happy", planMaterial: true, decisionId: "decision-happy" });
    await settled();

    // The auto-chain takes it the rest of the way: review, publish, CI, final review, auto-merge acceptance, merge.
    const done = await handle.result();
    expect(done).toMatchObject({ phase: "done", pendingAction: "Merged pull request confirmed", allowedCommands: [], mergeOutcome: "merged", acceptanceId: "acceptance-happy", completionReceiptId: "completion-receipt-happy", finalReviewOutcome: "approved", ciOutcome: "passed" });
    const finalState = await settled();
    expect(finalState.phase).toBe("done");

    // The user outcome, as the board renders it.
    expect(projectedDatabase.authQuery((db) => db.prepare("SELECT revision, phase, pending_action FROM forge_issue_projections WHERE task_id = ?").get(issueId))).toEqual({ revision: done.revision, phase: "done", pending_action: "Merged pull request confirmed" });
    expect(projectedDatabase.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_attention_items WHERE task_id = ? AND active = 1").get(issueId))).toEqual({ count: 0 });

    const phaseSequence = projections.map((state) => state.phase).filter((phase, index, all) => phase !== all[index - 1]);
    expect(phaseSequence).toEqual([
      "backlog", "planning", "blocked", "planning", "ready_for_development", "development", "delivery_ready",
      "reviewing_delivery", "delivery_reviewed", "releasing", "ci_waiting",
      "final_review", "accepted", "manual_merge", "done",
    ]);

    // A silent retry loop (the constraint-failure kind) shows up as one activity, or one
    // projection event, attempted over and over. Nothing on the happy path may exceed three.
    expect(Object.fromEntries([...calls].filter(([, count]) => count > 3))).toEqual({});

    const history = await handle.fetchHistory();
    await Worker.runReplayHistory({ workflowsPath }, history, workflowId);
  } finally {
    worker.shutdown();
    await workerRun;
  }
});
