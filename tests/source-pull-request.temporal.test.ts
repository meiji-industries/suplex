import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterEach, expect, test } from "vitest";

import type { IssueActivities, IssueWorkflowInput, IssueWorkflowState } from "../src/temporal/issue-contracts.js";
import { issueStateQuery, issueWorkflow, syncGithubPullRequestSignal } from "../src/temporal/workflows.js";
import { createIssueActivitiesFake } from "./fakes/issue-activities.js";

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
