import { setTimeout as sleep } from "node:timers/promises";
import type { NativeConnection } from "@temporalio/worker";
import proto from "@temporalio/proto";

import type { ForgeConfig } from "./config.js";
import { runtimeIdentifiers } from "./runtime-identifiers.js";

export async function activateLocalWorkerDeployment(connection: NativeConnection, config: ForgeConfig, buildId: string, identity: string, retryDelayMs = 500, timeoutMs = 30_000): Promise<void> {
  if (config.temporalTarget !== "local") return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await connection.withDeadline(Date.now() + 10_000, () => connection.workflowService.setWorkerDeploymentCurrentVersion({ namespace: config.temporalNamespace, deploymentName: runtimeIdentifiers(config.installationId).ownerLabel, buildId, identity }));
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(retryDelayMs);
    }
  }
}

export async function routeWorkflowToCurrentDeployment(connection: NativeConnection, config: ForgeConfig, workflowId: string, identity: string): Promise<void> {
  await connection.withDeadline(Date.now() + 10_000, () => connection.workflowService.updateWorkflowExecutionOptions({
    namespace: config.temporalNamespace,
    workflowExecution: { workflowId },
    workflowExecutionOptions: { versioningOverride: { autoUpgrade: true, behavior: proto.temporal.api.enums.v1.VersioningBehavior.VERSIONING_BEHAVIOR_AUTO_UPGRADE } },
    updateMask: { paths: ["versioning_override"] },
    identity,
  }));
}
