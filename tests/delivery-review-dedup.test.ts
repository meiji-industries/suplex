import { expect, test } from "vitest";

import { AgentService } from "../src/codex-lead.js";

test("adopts an existing delivery review before starting another Lead turn", async () => {
  const subjectCommit = "b".repeat(40);
  const review = {
    id: "delivery_review_existing",
    leadExecutionId: "agent_existing",
    sessionRef: "session_lead",
    opinionArtifactId: "artifact_opinion",
    evidenceArtifactId: "artifact_evidence",
    outcome: "approved" as const,
    summary: "The existing review approved this commit.",
    supersedesReviewId: null,
  };
  let turnCalls = 0;
  let reviewRows = 0;
  const database = {
    authQuery<T>(query: (db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] } }) => T): T {
      return query({
        prepare: (sql) => ({
          get: () => sql.includes("FROM forge_delivery_reviews") ? (reviewRows += 1, review) : undefined,
          all: () => [],
        }),
      });
    },
  };
  const service = Object.create(AgentService.prototype) as AgentService;
  Object.assign(service as object, {
    database,
    turnRunner: { run: async () => { turnCalls += 1; throw new Error("A duplicate review turn must not start"); } },
  });
  const input = {
    taskId: "task_1", companyId: "company_1", workflowId: "workflow_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: "artifact_brief", leadOutputArtifactId: "artifact_plan", planRevision: 1,
    roleProfiles: { planner: "profile_1" }, worktreePath: "/worktree", branchName: "forge/issue/task_1", supersedesReviewId: null,
    subject: { planRevision: 1, targetBaseSha: "a".repeat(40), subjectCommit, subjectTree: "c".repeat(40), developerExecutionId: "developer_1", deliveryArtifactId: "artifact_delivery", developerEvidenceArtifactId: "artifact_evidence", leadSessionRef: "session_lead", developerSessionRef: "session_developer" },
  };

  const first = await service.reviewDelivery(input);
  const second = await service.reviewDelivery(input);

  expect(first).toEqual(second);
  expect(first).toMatchObject({ outcome: "completed", review: { reviewId: review.id, summary: review.summary } });
  expect(reviewRows).toBe(2);
  expect(turnCalls).toBe(0);
});

test("starts a fresh delivery review when the same commit carries project verification failure context", async () => {
  const subjectCommit = "b".repeat(40);
  const review = {
    id: "delivery_review_existing",
    leadExecutionId: "agent_existing",
    sessionRef: "session_lead",
    opinionArtifactId: "artifact_opinion",
    evidenceArtifactId: "artifact_evidence",
    outcome: "approved" as const,
    summary: "The existing review approved this commit.",
    supersedesReviewId: null,
  };
  let preflightCalls = 0;
  const freshPathSentinel = new Error("fresh delivery review preflight reached");
  const database = {
    authQuery<T>(query: (db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] } }) => T): T {
      return query({
        prepare: (sql) => ({
          get: () => sql.includes("FROM forge_delivery_reviews") ? review : undefined,
          all: () => [],
        }),
      });
    },
  };
  const service = Object.create(AgentService.prototype) as AgentService;
  Object.assign(service as object, {
    database,
    blockedDeliveryReviewPreflight: async () => {
      preflightCalls += 1;
      throw freshPathSentinel;
    },
  });
  const input = {
    taskId: "task_1", companyId: "company_1", workflowId: "workflow_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: "artifact_brief", leadOutputArtifactId: "artifact_plan", planRevision: 1,
    roleProfiles: { planner: "profile_1" }, worktreePath: "/worktree", branchName: "forge/issue/task_1", supersedesReviewId: null,
    deliverySummary: "Project verification failed: pnpm test reported a regression",
    subject: { planRevision: 1, targetBaseSha: "a".repeat(40), subjectCommit, subjectTree: "c".repeat(40), developerExecutionId: "developer_1", deliveryArtifactId: "artifact_delivery", developerEvidenceArtifactId: "artifact_evidence", leadSessionRef: "session_lead", developerSessionRef: "session_developer" },
  };

  await expect(service.reviewDelivery(input)).rejects.toBe(freshPathSentinel);

  expect(preflightCalls).toBe(1);
});
