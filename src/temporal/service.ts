import { Client, Connection, type WorkflowHandle } from "@temporalio/client";
import proto from "@temporalio/proto";
import Long from "long";
import { randomUUID } from "node:crypto";

import type { ForgeConfig } from "../config.js";
import type { HealthCheck } from "../health.js";
import { isLegacyDurableIdentifier, runtimeIdentifiers } from "../runtime-identifiers.js";
import { approvePlanUpdate, cancelDevelopmentUpdate, issueStateQuery, issueWorkflow, probeStateQuery, probeWorkflow, recordProgressUpdate, rejectPlanUpdate, requestSupplementalReviewUpdate, retryDevelopmentUpdate, startDevelopmentUpdate, startPlanningUpdate } from "./workflows.js";
import { ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import { IssueWorkflowInputSchema, IssueWorkflowStateSchema, PlanCommandInputSchema, RecordProgressInputSchema, StartPlanningInputSchema, type IssueWorkflowInput, type IssueWorkflowState, type PlanCommandInput, type RecordProgressInput, type StartPlanningInput } from "./issue-contracts.js";
import { assertPayloadWithinLimit } from "./policy.js";

export const REQUIRED_SEARCH_ATTRIBUTES = ["CompanyId", "ProjectId", "IssueId"] as const;
export const LEGACY_SEARCH_ATTRIBUTES = ["ForgeCompanyId", "ForgeProjectId", "ForgeIssueId"] as const;

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

function isAlreadyStarted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already started|already exists/i.test(message);
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

export async function assertLegacyNamespaceProbeOnly(client: Client): Promise<void> {
  let inspected = 0;
  for await (const execution of client.workflow.list()) {
    inspected += 1;
    if (inspected > 1_000) {
      throw new Error("Refusing legacy Temporal migration with more than 1000 executions to inspect");
    }
    if (execution.type !== "probeWorkflow") {
      throw new Error(`Refusing legacy Temporal migration with non-probe workflow type ${execution.type}`);
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
  const identifiers = runtimeIdentifiers(config.installationId);
  const workflowId = input.workflowId ?? `${identifiers.workflowPrefix}-${randomUUID()}`;
  if (isLegacyDurableIdentifier(workflowId) || !workflowId.startsWith(`${identifiers.workflowPrefix}-`)) {
    throw new Error(`Refusing workflow ID outside this neutral installation scope: ${workflowId}`);
  }
  const validatedInput = ProbeWorkflowInputSchema.parse({ ...input, workflowId });
  const temporalClient = await connectTemporal(config);
  try {
    const handle = await temporalClient.client.workflow.start(probeWorkflow, {
      args: [validatedInput],
      taskQueue: config.taskQueue,
      workflowId,
      searchAttributes: { CompanyId: [validatedInput.companyId] },
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
    return ProbeWorkflowStateSchema.parse(await handle.query(probeStateQuery));
  } finally {
    temporalClient.connection.close();
  }
}

export async function startIssueWorkflow(config: ForgeConfig, input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }): Promise<{ workflowId: string; runId: string }> {
  const identifiers = runtimeIdentifiers(config.installationId);
  const workflowId = input.workflowId ?? `${identifiers.workflowPrefix}-issue-${input.issueId}`;
  if (isLegacyDurableIdentifier(workflowId) || !workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) {
    throw new Error(`Refusing issue workflow ID outside this neutral installation scope: ${workflowId}`);
  }
  const validatedInput = IssueWorkflowInputSchema.parse({ ...input, workflowId });
  assertPayloadWithinLimit("Issue Workflow input", validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    try {
      const searchAttributes = {
        CompanyId: [validatedInput.companyId],
        ProjectId: [validatedInput.projectId],
        IssueId: [validatedInput.issueId],
      };
      assertPayloadWithinLimit("Workflow search attributes", searchAttributes);
      const handle = await temporalClient.client.workflow.start(issueWorkflow, {
        args: [validatedInput],
        taskQueue: config.taskQueue,
        workflowId,
        searchAttributes,
      });
      return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
    } catch (error) {
      if (!isAlreadyStarted(error)) throw error;
      return { workflowId, runId: "" };
    }
  } finally {
    temporalClient.connection.close();
  }
}

export async function startIssuePlanning(config: ForgeConfig, workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (isLegacyDurableIdentifier(workflowId) || !workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this neutral installation scope");
  const validatedInput = StartPlanningInputSchema.parse(input);
  assertPayloadWithinLimit("startPlanning command", validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(startPlanningUpdate, { args: [validatedInput] }));
  } finally {
    temporalClient.connection.close();
  }
}

async function issuePlanUpdate(config: ForgeConfig, workflowId: string, input: PlanCommandInput, update: typeof requestSupplementalReviewUpdate | typeof approvePlanUpdate | typeof rejectPlanUpdate): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (isLegacyDurableIdentifier(workflowId) || !workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this neutral installation scope");
  const validatedInput = PlanCommandInputSchema.parse(input);
  assertPayloadWithinLimit("plan command", validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(update, { args: [validatedInput] }));
  } finally { temporalClient.connection.close(); }
}

export function requestIssueSupplementalReview(config: ForgeConfig, workflowId: string, input: PlanCommandInput): Promise<IssueWorkflowState> {
  return issuePlanUpdate(config, workflowId, input, requestSupplementalReviewUpdate);
}

export function approveIssuePlan(config: ForgeConfig, workflowId: string, input: PlanCommandInput): Promise<IssueWorkflowState> {
  return issuePlanUpdate(config, workflowId, { ...input, ...(input.note !== undefined ? { note: input.note } : {}) }, approvePlanUpdate);
}

export function rejectIssuePlan(config: ForgeConfig, workflowId: string, input: PlanCommandInput): Promise<IssueWorkflowState> {
  return issuePlanUpdate(config, workflowId, { ...input, ...(input.note !== undefined ? { note: input.note } : {}) }, rejectPlanUpdate);
}

export async function startIssueDevelopment(config: ForgeConfig, workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (isLegacyDurableIdentifier(workflowId) || !workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this neutral installation scope");
  const validatedInput = StartPlanningInputSchema.parse(input);
  assertPayloadWithinLimit("start development command", validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(startDevelopmentUpdate, { args: [validatedInput] }));
  } finally { temporalClient.connection.close(); }
}

export async function retryIssueDevelopment(config: ForgeConfig, workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (isLegacyDurableIdentifier(workflowId) || !workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this neutral installation scope");
  const validatedInput = StartPlanningInputSchema.parse(input);
  assertPayloadWithinLimit("retry development command", validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(retryDevelopmentUpdate, { args: [validatedInput] }));
  } finally { temporalClient.connection.close(); }
}

export async function cancelIssueDevelopment(config: ForgeConfig, workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (isLegacyDurableIdentifier(workflowId) || !workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this neutral installation scope");
  const validatedInput = StartPlanningInputSchema.parse(input);
  assertPayloadWithinLimit("cancel development command", validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(cancelDevelopmentUpdate, { args: [validatedInput] }));
  } finally { temporalClient.connection.close(); }
}

export async function queryIssueWorkflow(config: ForgeConfig, workflowId: string): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (isLegacyDurableIdentifier(workflowId) || !workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this neutral installation scope");
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.query(issueStateQuery));
  } finally {
    temporalClient.connection.close();
  }
}

export async function recordIssueProgress(config: ForgeConfig, workflowId: string, input: RecordProgressInput): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (isLegacyDurableIdentifier(workflowId) || !workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this neutral installation scope");
  const validatedInput = RecordProgressInputSchema.parse(input);
  assertPayloadWithinLimit("recordProgress command", validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(recordProgressUpdate, { args: [validatedInput] }));
  } finally {
    temporalClient.connection.close();
  }
}
