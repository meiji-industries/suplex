import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterEach, expect, test } from "vitest";

import type { PlanSubject } from "../src/plan-governance.js";
import type { IssueActivities, IssueWorkflowInput, IssueWorkflowState } from "../src/temporal/issue-contracts.js";
import { issueStateQuery, issueWorkflow, startPlanningUpdate, syncGithubPullRequestSignal } from "../src/temporal/workflows.js";
import { createIssueActivitiesFake } from "./fakes/issue-activities.js";
import { createImmediateCapacityActivities } from "./immediate-capacity-activities.js";

const workflowsPath = fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url));
let environment: TestWorkflowEnvironment | undefined;

afterEach(async () => {
  await environment?.teardown();
  environment = undefined;
});

function input(workflowId: string, withSource = true): IssueWorkflowInput {
  return {
    workflowId,
    companyId: "source-company",
    projectId: "source-project",
    issueId: `source-${workflowId}`,
    projectRevisionId: "source-revision",
    briefArtifactId: "source-brief",
    briefSha256: "0".repeat(64),
    imageArtifactIds: [],
    roleProfiles: { planner: "source-profile", builder: "source-profile" },
    supplementalReview: false,
    ...(withSource ? { repository: "acme/forge", source: { kind: "pull_request" as const, number: 1517, url: "https://github.com/acme/forge/pull/1517", headBranch: "feat/vessel-format-page", baseBranch: "main", headSha: "a".repeat(40), baseSha: "b".repeat(40) } } : {}),
    continuationState: { phase: "delivery_blocked", revision: 5, owner: "human", allowedCommands: ["cancel_issue"], pendingAction: "Blocked delivery", lastEventId: `${workflowId}:5`, continuationCount: 0, lastSummaryHash: null },
  };
}

test("source pull requests seed workflow state and complete only after an observed merge", { timeout: 60_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const projections: IssueWorkflowState[] = [];
  let merged = false;
  const activities: Partial<IssueActivities> = {
    projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; },
    observeGithubPullRequest: async () => ({ exists: true, number: 1517, url: "https://github.com/acme/forge/pull/1517", state: merged ? "merged" as const : "open" as const, isDraft: false, headSha: "a".repeat(40), baseSha: "b".repeat(40), mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null }),
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue: "source-pull-request", workflowsPath, activities: createIssueActivitiesFake(activities) as unknown as Record<string, (...args: never[]) => unknown> });
  const workerRun = worker.run();
  try {
    const open = await environment.client.workflow.start(issueWorkflow, { workflowId: "source-open", taskQueue: "source-pull-request", args: [input("source-open")] });
    expect(await open.query(issueStateQuery)).toMatchObject({ phase: "delivery_blocked", releaseRepository: "acme/forge", branchName: "feat/vessel-format-page", pullRequestNumber: 1517, pullRequestUrl: "https://github.com/acme/forge/pull/1517", githubPullRequestExists: true });
    await open.signal(syncGithubPullRequestSignal);
    await expect.poll(() => projections.at(-1)).toMatchObject({ phase: "delivery_blocked", githubPullRequestState: "open" });

    merged = true;
    const completed = await environment.client.workflow.start(issueWorkflow, { workflowId: "source-merged", taskQueue: "source-pull-request", args: [input("source-merged")] });
    await completed.signal(syncGithubPullRequestSignal);
    await expect(completed.result()).resolves.toMatchObject({ phase: "done", githubPullRequestState: "merged" });
  } finally {
    worker.shutdown();
    await workerRun;
  }
});

test("pre-existing workflows adopt source pull requests from their task configuration", { timeout: 60_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const projections: IssueWorkflowState[] = [];
  let merged = false;
  const activities: Partial<IssueActivities> = {
    projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; },
    loadTaskSourcePullRequest: async () => ({ repository: "acme/forge", source: { number: 1517, url: "https://github.com/acme/forge/pull/1517", headBranch: "feat/vessel-format-page", baseBranch: "main" } }),
    observeGithubPullRequest: async () => ({ exists: true, number: 1517, url: "https://github.com/acme/forge/pull/1517", state: merged ? "merged" as const : "open" as const, isDraft: false, headSha: "a".repeat(40), baseSha: "b".repeat(40), mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null }),
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue: "source-pull-request-adoption", workflowsPath, activities: createIssueActivitiesFake(activities) as unknown as Record<string, (...args: never[]) => unknown> });
  const workerRun = worker.run();
  try {
    const open = await environment.client.workflow.start(issueWorkflow, { workflowId: "source-adopt-open", taskQueue: "source-pull-request-adoption", args: [input("source-adopt-open", false)] });
    await open.signal(syncGithubPullRequestSignal);
    await expect.poll(() => projections.at(-1)).toMatchObject({ phase: "delivery_blocked", releaseRepository: "acme/forge", branchName: "feat/vessel-format-page", pullRequestNumber: 1517, githubPullRequestState: "open" });

    merged = true;
    const completed = await environment.client.workflow.start(issueWorkflow, { workflowId: "source-adopt-merged", taskQueue: "source-pull-request-adoption", args: [input("source-adopt-merged", false)] });
    await completed.signal(syncGithubPullRequestSignal);
    await expect(completed.result()).resolves.toMatchObject({ phase: "done", githubPullRequestState: "merged" });
  } finally {
    worker.shutdown();
    await workerRun;
  }
});

test("source pull requests push an approved reviewed head before GitHub synchronization", { timeout: 60_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const projections: IssueWorkflowState[] = [];
  const oldHead = "a".repeat(40);
  const resultCommit = "c".repeat(40);
  const resultTree = "d".repeat(40);
  const pushCalls: Array<{ branchName: string; commitSha: string }> = [];
  let head = oldHead;
  let releasePush!: () => void;
  const pushed = new Promise<void>((resolve) => { releasePush = resolve; });
  const planSubject: PlanSubject = {
    companyId: "source-company",
    issueId: "source-reviewed-head",
    workflowId: "source-reviewed-head",
    originalPlanRevision: 1,
    outputId: "source-plan",
    outputRevision: 1,
    finalVersion: 1,
    artifactId: "source-plan-artifact",
    artifactSha256: "0".repeat(64),
    leadSessionRef: "source-lead-session",
    leadExecutionId: "source-lead-execution",
    evidenceManifestArtifactId: "source-plan-evidence",
    evidenceManifestSha256: "0".repeat(64),
  };
  const activities: Partial<IssueActivities> = {
    ...createImmediateCapacityActivities().activities,
    projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; },
    runLeadPlanning: async () => ({ leadSessionRef: "source-lead-session", leadExecutionId: "source-lead-execution", leadEvidenceArtifactId: "source-plan-evidence", leadOutputArtifactId: "source-plan-artifact", leadOutputArtifactSha256: "0".repeat(64), leadOutputKind: "plan" as const, leadSummary: "Source pull request plan", materialCategories: [], material: false, planSubject, materialityEvidence: { categories: [], artifactId: "source-materiality", artifactSha256: "0".repeat(64) } }),
    recordPlanDecision: async () => ({ decisionId: "source-plan-decision", subjectHash: "0".repeat(64) }),
    runDeveloperExecutionSupervised: async () => ({ status: "completed" as const, resultHash: "0".repeat(64), result: { developerExecutionId: "source-developer-execution", developerSessionRef: "source-developer-session", branchName: "feat/vessel-format-page", targetBaseSha: "b".repeat(40), currentStep: null, resultCommit, resultTree, dirtyState: "clean" as const, deliveryArtifactId: "source-delivery", evidenceArtifactId: "source-developer-evidence", deliverySummary: "Implemented the source pull request change", outcome: "completed" as const } }),
    reviewDelivery: async (input) => ({ outcome: "completed" as const, attemptId: "source-review-attempt", correctionAttempts: 0, subject: input.subject, review: { reviewId: "source-review", leadExecutionId: "source-review-execution", leadSessionRef: "source-review-session", opinionArtifactId: "source-review-opinion", evidenceArtifactId: "source-review-evidence", opinion: "approved" as const, summary: "Approved", repairPlan: null, findings: [], supersedesReviewId: null, reviewArtifact: { artifactId: "source-review-opinion", companyId: "source-company", kind: "delivery-review" as const, sha256: "0".repeat(64), byteSize: 1, mimeType: "application/json" } } }),
    pushDeliveryBranch: async (input) => { pushCalls.push({ branchName: input.branchName, commitSha: input.commitSha }); head = input.commitSha; releasePush(); await pushed; return { repository: "acme/forge", branchName: input.branchName, commitSha: input.commitSha }; },
    observeGithubPullRequest: async () => ({ exists: true, number: 1517, url: "https://github.com/acme/forge/pull/1517", state: "open" as const, isDraft: false, headSha: head, baseSha: "b".repeat(40), mergeable: "MERGEABLE", checks: { total: 1, pending: 0, failing: 0, successful: 1 }, autoMergeEnabled: false, reviewDecision: null }),
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue: "source-reviewed-head", workflowsPath, activities: createIssueActivitiesFake(activities) as unknown as Record<string, (...args: never[]) => unknown> });
  const workerRun = worker.run();
  try {
    const handle = await environment.client.workflow.start(issueWorkflow, {
      workflowId: "source-reviewed-head",
      taskQueue: "source-reviewed-head",
      args: [{
        ...input("source-reviewed-head"),
        autoApprovePlan: true,
        autoApprovePlanActorUserId: "source-user",
        deliveryTarget: "pull_request_draft",
        continuationState: { phase: "backlog", revision: 0, owner: "human", allowedCommands: ["start_planning", "cancel_issue"], pendingAction: "Ready to plan", lastEventId: "source-reviewed-head:0", continuationCount: 0, lastSummaryHash: null },
      }],
    });
    const backlog = await handle.query(issueStateQuery);
    await handle.executeUpdate(startPlanningUpdate, { args: [{ expectedRevision: backlog.revision, actorUserId: "source-user", commandId: "source-start-planning" }], updateId: "source-start-planning" });
    await pushed;
    await handle.signal(syncGithubPullRequestSignal);
    releasePush();
    const done = await handle.result();

    expect(pushCalls).toEqual([{ branchName: "feat/vessel-format-page", commitSha: resultCommit }]);
    expect(done).toMatchObject({ phase: "done", expectedHeadSha: resultCommit });
    expect(projections.at(-1)).toMatchObject({ phase: "done", expectedHeadSha: resultCommit });
  } finally {
    worker.shutdown();
    await workerRun;
  }
});
