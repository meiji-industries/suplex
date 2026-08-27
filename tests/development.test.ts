import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";
import { afterEach, expect, test } from "vitest";

import { SESSION_COOKIE_NAME } from "../src/auth-identifiers.js";
import { createTestConfig } from "../src/config.js";
import { createForgeServer } from "../src/server.js";
import type { IssueActivities, IssueWorkflowInput, IssueWorkflowState } from "../src/temporal/issue-contracts.js";
import { StartPlanningInputSchema, IssueWorkflowStateSchema, buildInitialIssueWorkflowState } from "../src/temporal/issue-contracts.js";
import { blockFailedDeveloperStart } from "../src/temporal/workflow/register-development.js";
import { issueStateQuery, issueWorkflow } from "../src/temporal/workflows.js";
import { createIssueActivitiesFake } from "./fakes/issue-activities.js";

const workflowsPath = fileURLToPath(new URL("../src/temporal/workflows.ts", import.meta.url));
let environment: TestWorkflowEnvironment | undefined;

afterEach(async () => {
  await environment?.teardown();
  environment = undefined;
});

test("blocks a supervised Developer retry that cannot start", async () => {
  const command = StartPlanningInputSchema.parse({ expectedRevision: 1, commandId: "retry-start-failure", actorUserId: "user-development" });
  const state = IssueWorkflowStateSchema.parse({ ...buildInitialIssueWorkflowState({ workflowId: "workflow-development", companyId: "company-development", projectId: "project-development", issueId: "issue-development", projectRevisionId: "revision-development", briefArtifactId: "brief-development", briefSha256: "a".repeat(64), imageArtifactIds: [], roleProfiles: { planner: "profile", builder: "profile" }, supplementalReview: false }), actorUserId: "user-development", revision: 1, phase: "development", owner: "lead", allowedCommands: ["cancel_development", "cancel_issue"], pendingAction: "Developer retry", lastEventId: "workflow-development:1", developerExecutionId: "developer_execution", activeOperation: { commandId: command.commandId, kind: "development", startedRevision: 1 } });
  let projected = false;
  const ctx = {
    state,
    supervisedDeveloperTurns: true,
    patched: () => true,
    withStateMutation: async (fn: () => boolean) => fn(),
    addRevisionCommand: <T extends string[]>(commands: T) => commands,
    recoveryFields: () => ({ developerRecoveryStatus: "failed" as const, developerRecoveryReasonCode: null, developerRecoverySummary: "Developer could not start: unavailable", developerLastHeartbeatAt: null }),
    shouldContinueAsNew: () => false,
    project: async () => { projected = true; },
  } as unknown as Parameters<typeof blockFailedDeveloperStart>[0];

  await expect(blockFailedDeveloperStart(ctx, command, "developer_execution", new Error("unavailable"))).resolves.toBe(true);
  expect(ctx.state).toMatchObject({ phase: "delivery_blocked", owner: "human", allowedCommands: ["retry_development", "cancel_issue"], pendingAction: "Developer could not start: unavailable", developerRecoveryStatus: "failed", activeOperation: null });
  expect(projected).toBe(true);
});

test("retries a supervised Developer start failure once before blocking", { timeout: 60_000 }, async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping();
  const workflowId = "workflow-development-start-retry";
  const initial = buildInitialIssueWorkflowState({ workflowId, companyId: "company-development", projectId: "project-development", issueId: "issue-development", projectRevisionId: "revision-development", briefArtifactId: "brief-development", briefSha256: "a".repeat(64), imageArtifactIds: [], roleProfiles: { planner: "profile", builder: "profile" }, supplementalReview: false });
  const attempts: string[] = [];
  const projections: IssueWorkflowState[] = [];
  const activities: Partial<IssueActivities> = {
    projectIssueState: async (event) => { projections.push(structuredClone(event.state)); return event.state; },
    runDeveloperExecutionSupervised: async (input) => {
      attempts.push(input.developerTurnExecutionId);
      throw ApplicationFailure.nonRetryable("controlled start failure");
    },
  };
  const worker = await Worker.create({ connection: environment.nativeConnection, namespace: environment.namespace ?? "default", taskQueue: "development-start-retry", workflowsPath, activities: createIssueActivitiesFake(activities) as unknown as Record<string, (...args: never[]) => unknown> });
  const workerRun = worker.run();
  try {
    const input: IssueWorkflowInput = {
      workflowId,
      companyId: "company-development",
      projectId: "project-development",
      issueId: "issue-development",
      projectRevisionId: "revision-development",
      briefArtifactId: "brief-development",
      briefSha256: "a".repeat(64),
      imageArtifactIds: [],
      roleProfiles: { planner: "profile", builder: "profile" },
      supplementalReview: false,
      continuationState: { ...initial, revision: 1, phase: "ready_for_development", owner: "lead", allowedCommands: ["start_development", "cancel_issue"], pendingAction: "Start development", lastEventId: `${workflowId}:1`, planRevision: 1, planMaterial: true, planApproved: true, leadSessionRef: "lead-session", leadOutputArtifactId: "lead-output" },
    };
    const handle = await environment.client.workflow.start(issueWorkflow, { workflowId, taskQueue: "development-start-retry", args: [input] });
    await expect.poll(() => handle.query(issueStateQuery), { timeout: 30_000 }).toMatchObject({ phase: "delivery_blocked", developerAttempt: 2 });
    const state = await handle.query(issueStateQuery);
    expect(state).toMatchObject({ phase: "delivery_blocked", owner: "human", developerAttempt: 2 });
    expect(state.pendingAction).toMatch(/^Developer could not start:/);
    expect(state.allowedCommands).toEqual(expect.arrayContaining(["retry_development", "cancel_issue"]));
    expect(projections).toContainEqual(expect.objectContaining({ phase: "ready_for_development", pendingAction: "Developer could not start; Forge is starting the one automatic retry." }));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).not.toBe(attempts[1]);
  } finally {
    worker.shutdown();
    await workerRun;
  }
});

test("development startup seeds identity without requiring a Git repository root", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-development-test-"));
  const config = createTestConfig(root, {
    bindAddress: "127.0.0.1",
    reachableAddress: "https://forge.tailnet.ts.net:55180",
    port: 55180,
    developmentAutoLogin: true,
  });
  const server = await createForgeServer(config);
  try {
    const remoteStatus = await server.app.inject({ method: "GET", url: "/api/auth/status", headers: { host: "forge.tailnet.ts.net:55180" } });
    expect(remoteStatus.json()).toEqual({ required: false, authenticated: false });

    const status = await server.app.inject({ method: "GET", url: "/api/auth/status", headers: { host: "localhost:55180" } });
    expect(status.json()).toEqual({ required: false, authenticated: true });
    const setCookies = Array.isArray(status.headers["set-cookie"]) ? status.headers["set-cookie"] : [status.headers["set-cookie"] ?? ""];
    const cookie = setCookies.find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`))?.split(";", 1)[0];
    expect(cookie).toBeDefined();
    expect(setCookies.find((value) => value.startsWith(`${SESSION_COOKIE_NAME}=`))).not.toContain("Secure");

    const companies = await server.app.inject({ method: "GET", url: "/api/companies", headers: { cookie: cookie! } });
    expect(companies.json()).toEqual({ companies: [expect.objectContaining({ name: "Development" })] });
    const profiles = await server.app.inject({ method: "GET", url: "/api/profiles", headers: { cookie: cookie! } });
    expect(profiles.json()).toEqual({ profiles: expect.arrayContaining([
      expect.objectContaining({ name: "Smart", model: "gpt-5.6-sol", reasoningLevel: "high", servicePriority: "standard" }),
      expect.objectContaining({ name: "Balanced", model: "gpt-5.6-terra", reasoningLevel: "medium", servicePriority: "standard" }),
      expect.objectContaining({ name: "Fast", model: "gpt-5.6-luna", reasoningLevel: "xhigh", servicePriority: "fast" }),
    ]) });
    const projects = await server.app.inject({ method: "GET", url: "/api/projects", headers: { cookie: cookie! } });
    expect(projects.json()).toEqual({ projects: [] });

    const created = await server.app.inject({ method: "POST", url: "/api/admin/companies", headers: { cookie: cookie!, origin: "http://localhost:55180" }, payload: { name: "Local mutation" } });
    expect(created.statusCode).toBe(201);
  } finally {
    await server.app.close();
    server.database.close();
    await rm(root, { recursive: true, force: true });
  }
});
