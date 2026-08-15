import type { NativeConnection } from "@temporalio/worker";
import proto from "@temporalio/proto";

import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { StructuredLogger } from "./logging.js";
import { runtimeIdentifiers } from "./runtime-identifiers.js";
import { reconcileIssueDeveloperDelivery } from "./temporal/service.js";

interface BlockedDeliveryRow {
  workflowId: string;
  revision: number;
  executionId: string;
}

/** Re-evaluate policy-only delivery blockers without starting another agent turn. */
function deploymentVersion(config: ForgeConfig, buildId: string) {
  return { deploymentName: runtimeIdentifiers(config.installationId).ownerLabel, buildId };
}

export async function activateLocalWorkerDeployment(connection: NativeConnection, config: ForgeConfig, buildId: string, identity: string, retryDelayMs = 500, timeoutMs = 30_000): Promise<void> {
  if (config.temporalTarget !== "local") return;
  const version = deploymentVersion(config, buildId);
  // The Temporal server registers a deployment version asynchronously after the
  // worker's first poll, so activation right after startup can race it; retry.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await connection.withDeadline(Date.now() + 10_000, () => connection.workflowService.setWorkerDeploymentCurrentVersion({
        namespace: config.temporalNamespace,
        deploymentName: version.deploymentName,
        buildId: version.buildId,
        identity,
      }));
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
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

export async function reconcileBlockedDeveloperDeliveries(database: ForgeDatabase, config: ForgeConfig, reconcile = reconcileIssueDeveloperDelivery, route?: (workflowId: string) => Promise<void>): Promise<number> {
  const rows = database.authQuery((db) => db.prepare(`SELECT p.workflow_id AS workflowId, p.revision, e.id AS executionId
    FROM forge_issue_projections p
    JOIN forge_workflow_snapshots s ON s.task_id = p.task_id AND s.company_id = p.company_id AND s.workflow_id = p.workflow_id AND s.revision = p.revision
    JOIN forge_developer_executions e ON e.id = json_extract(s.state_json, '$.developerExecutionId') AND e.task_id = p.task_id AND e.company_id = p.company_id AND e.workflow_id = p.workflow_id
    WHERE p.phase = 'delivery_blocked' AND e.status = 'blocked' AND e.failure_code = 'delivery-reconciliation-failed'
    ORDER BY p.task_id`).all() as BlockedDeliveryRow[]);
  let recovered = 0;
  for (const row of rows) {
    try {
      await route?.(row.workflowId);
      const state = await reconcile(config, row.workflowId, { expectedRevision: row.revision, actorUserId: "system-reconciliation", commandId: `delivery-reconcile-v4-${row.executionId}-${row.revision}`.slice(0, 256), reconcileOnly: true });
      if (state.phase === "delivery_ready") recovered += 1;
    } catch (error) {
      new StructuredLogger().error("Developer delivery reconciliation attempt failed", { workflowId: row.workflowId }, { executionId: row.executionId, error: error instanceof Error ? error.message : "unknown error" });
    }
  }
  return recovered;
}
