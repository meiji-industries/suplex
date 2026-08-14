import { expect, test } from "vitest";
import type { NativeConnection } from "@temporalio/worker";

import type { ForgeConfig } from "../src/config.js";
import type { ForgeDatabase } from "../src/database.js";
import { activateLocalWorkerDeployment, reconcileBlockedDeveloperDeliveries, routeWorkflowToCurrentDeployment } from "../src/developer-reconciliation-recovery.js";
import type { IssueWorkflowState } from "../src/temporal/issue-contracts.js";

test("blocked delivery recovery submits a reconcile-only idempotent workflow update", async () => {
  const rows = [{ workflowId: "workflow-test-issue-1", revision: 9, executionId: "developer_1" }];
  const database = { authQuery: (query: (db: { prepare: () => { all: () => typeof rows } }) => unknown) => query({ prepare: () => ({ all: () => rows }) }) } as unknown as ForgeDatabase;
  const calls: unknown[] = [];
  const recovered = await reconcileBlockedDeveloperDeliveries(database, {} as never, async (_config, workflowId, input) => {
    calls.push({ workflowId, input });
    return { phase: "delivery_ready" } as IssueWorkflowState;
  }, async (workflowId) => { calls.push({ route: workflowId }); });

  expect(recovered).toBe(1);
  expect(calls).toEqual([
    { route: "workflow-test-issue-1" },
    { workflowId: "workflow-test-issue-1", input: { expectedRevision: 9, actorUserId: "system-reconciliation", commandId: "delivery-reconcile-v3-developer_1-9", reconcileOnly: true } },
  ]);
});

test("local deployment activation and legacy workflow routing use Worker Deployment APIs", async () => {
  const calls: unknown[] = [];
  const connection = {
    withDeadline: async (_deadline: number, operation: () => Promise<unknown>) => operation(),
    workflowService: {
      setWorkerDeploymentCurrentVersion: async (request: unknown) => { calls.push({ current: request }); },
      updateWorkflowExecutionOptions: async (request: unknown) => { calls.push({ route: request }); },
    },
  } as unknown as NativeConnection;
  const config = { temporalTarget: "local", temporalNamespace: "forge-dev", installationId: "test-installation" } as ForgeConfig;

  await activateLocalWorkerDeployment(connection, config, "build-1", "worker-1");
  await routeWorkflowToCurrentDeployment(connection, config, "workflow-1", "worker-1");

  expect(calls).toEqual([
    { current: { namespace: "forge-dev", deploymentName: "runtime-test-installation", buildId: "build-1", identity: "worker-1" } },
    { route: {
      namespace: "forge-dev",
      workflowExecution: { workflowId: "workflow-1" },
      workflowExecutionOptions: { versioningOverride: { autoUpgrade: true, behavior: 2 } },
      updateMask: { paths: ["versioning_override"] },
      identity: "worker-1",
    } },
  ]);
});

test("local deployment activation retries until the server registers the version", async () => {
  let attempts = 0;
  const connection = {
    withDeadline: async (_deadline: number, operation: () => Promise<unknown>) => operation(),
    workflowService: {
      setWorkerDeploymentCurrentVersion: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("deployment version not found");
      },
    },
  } as unknown as NativeConnection;
  const config = { temporalTarget: "local", temporalNamespace: "forge-dev", installationId: "test-installation" } as ForgeConfig;

  await activateLocalWorkerDeployment(connection, config, "build-1", "worker-1", 1);

  expect(attempts).toBe(3);
});
