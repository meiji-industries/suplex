import { Client, Connection, type WorkflowHandle } from "@temporalio/client";
import proto from "@temporalio/proto";
import Long from "long";
import { randomUUID } from "node:crypto";

import type { ForgeConfig } from "../config.js";
import type { HealthCheck } from "../health.js";
import { probeStateQuery, probeWorkflow } from "./workflows.js";
import type { ProbeWorkflowInput, ProbeWorkflowState } from "./contracts.js";

export const REQUIRED_SEARCH_ATTRIBUTES = ["ForgeCompanyId", "ForgeProjectId", "ForgeIssueId"] as const;

export interface TemporalClientConnection {
  connection: Connection;
  client: Client;
}

function isAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already.?exists|already registered/i.test(message);
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not.?found|namespace.*does not exist/i.test(message);
}

export async function connectTemporal(config: ForgeConfig): Promise<TemporalClientConnection> {
  const connection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "3 seconds" });
  return { connection, client: new Client({ connection, namespace: config.temporalNamespace }) };
}

export async function ensureTemporalFoundation(connection: Connection, config: ForgeConfig): Promise<void> {
  try {
    await connection.workflowService.describeNamespace({ namespace: config.temporalNamespace });
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
    try {
      await connection.workflowService.registerNamespace({
        namespace: config.temporalNamespace,
        description: "Forge local-first workflow namespace",
        workflowExecutionRetentionPeriod: { seconds: Long.fromNumber(7 * 24 * 60 * 60) },
      });
    } catch (registerError) {
      if (!isAlreadyExists(registerError)) {
        throw registerError;
      }
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await connection.workflowService.describeNamespace({ namespace: config.temporalNamespace });
        break;
      } catch (describeError) {
        if (attempt === 9) {
          throw describeError;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }

  for (const attribute of REQUIRED_SEARCH_ATTRIBUTES) {
    try {
      await connection.operatorService.addSearchAttributes({
        namespace: config.temporalNamespace,
        searchAttributes: {
          [attribute]: proto.temporal.api.enums.v1.IndexedValueType.INDEXED_VALUE_TYPE_KEYWORD,
        },
      });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
  }
}

export class TemporalHealthProbe {
  constructor(private readonly config: ForgeConfig) {}

  async check(): Promise<HealthCheck> {
    let connection: Connection | undefined;
    try {
      connection = await Connection.connect({ address: this.config.temporalAddress, connectTimeout: "3 seconds" });
      const namespace = await connection.workflowService.describeNamespace({ namespace: this.config.temporalNamespace });
      const searchAttributes = await connection.workflowService.getSearchAttributes({ namespace: this.config.temporalNamespace });
      const aliases = Object.values(namespace.config?.customSearchAttributeAliases ?? {});
      const missing = REQUIRED_SEARCH_ATTRIBUTES.filter((attribute) => searchAttributes.keys[attribute] === undefined && !aliases.includes(attribute));
      if (missing.length > 0) {
        return {
          id: "temporal",
          label: "Temporal",
          status: "unhealthy",
          summary: "Namespace is reachable but visibility metadata is incomplete",
          details: { namespace: this.config.temporalNamespace, missingAttributes: missing.join(", ") },
        };
      }
      return {
        id: "temporal",
        label: "Temporal",
        status: "healthy",
        summary: "Namespace and visibility metadata are reachable",
        details: { namespace: this.config.temporalNamespace, address: this.config.temporalAddress },
      };
    } catch {
      return {
        id: "temporal",
        label: "Temporal",
        status: "unhealthy",
        summary: "Temporal is unavailable or the namespace cannot be reached",
        details: { namespace: this.config.temporalNamespace, address: this.config.temporalAddress },
      };
    } finally {
      connection?.close();
    }
  }
}

export async function startProbeWorkflow(config: ForgeConfig, input: Omit<ProbeWorkflowInput, "workflowId"> & { workflowId?: string }): Promise<{ workflowId: string; runId: string }> {
  const workflowId = input.workflowId ?? `forge-probe-${randomUUID()}`;
  const temporalClient = await connectTemporal(config);
  try {
    const handle = await temporalClient.client.workflow.start(probeWorkflow, {
      args: [{ ...input, workflowId }],
      taskQueue: config.taskQueue,
      workflowId,
      searchAttributes: { ForgeCompanyId: [input.companyId] },
    });
    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
  } finally {
    temporalClient.connection.close();
  }
}

export async function queryProbeWorkflow(config: ForgeConfig, workflowId: string, runId?: string): Promise<ProbeWorkflowState> {
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof probeWorkflow> = temporalClient.client.workflow.getHandle(workflowId, runId);
    return await handle.query(probeStateQuery);
  } finally {
    temporalClient.connection.close();
  }
}
