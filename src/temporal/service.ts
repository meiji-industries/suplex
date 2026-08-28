import { Client, Connection, WorkflowIdConflictPolicy, WorkflowIdReusePolicy, WorkflowNotFoundError, WorkflowUpdateStage, defaultPayloadConverter, type WorkflowHandle } from "@temporalio/client";
import { createHash, randomUUID } from "node:crypto";

import { temporalConnectionOptions, type ForgeConfig } from "../config.js";
import type { HealthCheck } from "../health.js";
import { runtimeIdentifiers } from "../runtime-identifiers.js";
import { issueCommands, type IssueCommand } from "../commands/registry.js";
import { issueStateQuery, issueWorkflow, probeStateQuery, probeWorkflow } from "./workflows.js";
import { issueUpdates, syncGithubPullRequestSignal } from "./issue-updates.js";
import { ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import { ContinueWorkCommandSchema, IssueProjectionEventSchema, IssueWorkflowInputSchema, IssueWorkflowStateSchema, PlanCommandInputSchema, PlanRevisionCommandSchema, RecordProgressInputSchema, ResolveDecisionBlockerInputSchema, SendPlannerNoteInputSchema, StartPlanningInputSchema, type ContinueWorkCommand, type IssueWorkflowInput, type IssueWorkflowState, type PlanCommandInput, type PlanRevisionCommand, type RecordProgressInput, type ResolveDecisionBlockerInput, type SendPlannerNoteInput, type StartPlanningInput } from "./issue-contracts.js";
import { assertPayloadWithinLimit } from "./policy.js";
import { clientPayloadInterceptor } from "./payload-boundary-interceptors.js";
import { temporalDataConverter } from "./workflow-bundle.js";

export const REQUIRED_SEARCH_ATTRIBUTES = ["CompanyId", "ProjectId", "IssueId"] as const;
const UPDATE_ACCEPTANCE_TIMEOUT_MS = 10_000;

export interface TemporalClientConnection {
  connection: Connection;
  client: Client;
}

export function durableCommand<T extends { expectedRevision: number; actorUserId: string; commandId?: string | undefined }>(workflowId: string, kind: string, input: T): T & { commandId: string } {
  if (input.commandId) return { ...input, commandId: input.commandId };
  const digest = createHash("sha256").update(JSON.stringify([workflowId, kind, input])).digest("hex");
  return { ...input, commandId: `command_${digest}` };
}

export class IssueWorkflowStartFailure extends Error {
  readonly code: "workflow_not_started" | "workflow_start_ambiguous" | "workflow_identity_conflict";
  readonly provenAbsent: boolean;

  constructor(code: IssueWorkflowStartFailure["code"], provenAbsent: boolean) {
    super(code);
    this.name = "IssueWorkflowStartFailure";
    this.code = code;
    this.provenAbsent = provenAbsent;
  }
}

export async function connectTemporal(config: ForgeConfig): Promise<TemporalClientConnection> {
  const connection = await Connection.connect({ ...temporalConnectionOptions(config), connectTimeout: "3 seconds" });
  return { connection, client: new Client({ connection, namespace: config.temporalNamespace, dataConverter: temporalDataConverter, interceptors: { workflow: [clientPayloadInterceptor] } }) };
}

export async function ensureTemporalFoundation(connection: Connection, config: ForgeConfig): Promise<void> {
  const namespace = await connection.workflowService.describeNamespace({ namespace: config.temporalNamespace });
  const searchAttributes = await connection.workflowService.getSearchAttributes({ namespace: config.temporalNamespace });
  const aliases = Object.values(namespace.config?.customSearchAttributeAliases ?? {});
  const missing = REQUIRED_SEARCH_ATTRIBUTES.filter((attribute) => searchAttributes.keys[attribute] === undefined && !aliases.includes(attribute));
  if (missing.length > 0) {
    throw new Error(`Temporal namespace ${config.temporalNamespace} is missing custom Search Attributes: ${missing.join(", ")}`);
  }
}

export class TemporalHealthProbe {
  constructor(private readonly config: ForgeConfig) {}

  async check(): Promise<HealthCheck> {
    let connection: Connection | undefined;
    try {
      connection = await Connection.connect({ ...temporalConnectionOptions(this.config), connectTimeout: "3 seconds" });
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
      await connection?.close();
    }
  }
}

export async function startProbeWorkflow(config: ForgeConfig, input: Omit<ProbeWorkflowInput, "workflowId"> & { workflowId?: string }): Promise<{ workflowId: string; runId: string }> {
  const identifiers = runtimeIdentifiers(config.installationId);
  const workflowId = input.workflowId ?? `${identifiers.workflowPrefix}-${randomUUID()}`;
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-`)) {
    throw new Error(`Refusing workflow ID outside this installation scope: ${workflowId}`);
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
    await temporalClient.connection.close();
  }
}

export async function queryProbeWorkflow(config: ForgeConfig, workflowId: string, runId?: string): Promise<ProbeWorkflowState> {
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof probeWorkflow> = temporalClient.client.workflow.getHandle(workflowId, runId);
    return ProbeWorkflowStateSchema.parse(await handle.query(probeStateQuery));
  } finally {
    await temporalClient.connection.close();
  }
}

function expectedCreationIdentity(input: IssueWorkflowInput): Record<string, string | undefined> {
  return { companyId: input.companyId, projectId: input.projectId, issueId: input.issueId, projectRevisionId: input.projectRevisionId, requestHash: input.requestHash, predecessorTaskId: input.predecessorTaskId };
}

function identityMatches(state: IssueWorkflowState, input: IssueWorkflowInput): boolean {
  const expected = expectedCreationIdentity(input);
  return state.workflowId === input.workflowId && state.companyId === expected.companyId && state.projectId === expected.projectId && state.issueId === expected.issueId && state.projectRevisionId === expected.projectRevisionId && state.requestHash === expected.requestHash && state.predecessorTaskId === expected.predecessorTaskId;
}

function memoMatches(memo: Record<string, unknown> | undefined, input: IssueWorkflowInput): boolean {
  const identity = memo?.creationIdentity;
  return JSON.stringify(identity) === JSON.stringify(expectedCreationIdentity(input));
}

function searchAttributesMatch(attributes: Record<string, unknown> | undefined, input: IssueWorkflowInput): boolean {
  if (!attributes) return false;
  const expected = { CompanyId: input.companyId, ProjectId: input.projectId, IssueId: input.issueId };
  return Object.entries(expected).every(([key, value]) => {
    const candidate = attributes[key];
    return Array.isArray(candidate) ? candidate[0] === value : candidate === value;
  });
}

async function recoverClosedProjection(handle: WorkflowHandle<typeof issueWorkflow>, input: IssueWorkflowInput): Promise<IssueWorkflowState> {
  const description = await handle.describe();
  const seen = new Set<string>();
  let runId: string | undefined = description.rootExecution?.runId ?? description.runId;
  const states: IssueWorkflowState[] = [];
  while (runId && !seen.has(runId)) {
    seen.add(runId);
    const history = await handle.client.getHandle<typeof issueWorkflow>(handle.workflowId, runId).fetchHistory();
    const events = (history as unknown as { events?: Array<Record<string, unknown>> }).events ?? [];
    for (const event of events) {
      const attributes = event.activityTaskScheduledEventAttributes as { activityType?: { name?: string }; input?: { payloads?: Array<unknown> } } | undefined;
      if (attributes?.activityType?.name !== "projectIssueState" || !attributes.input?.payloads?.[0]) continue;
      const decoded = defaultPayloadConverter.fromPayload(attributes.input.payloads[0] as never) as unknown;
      const projection = IssueProjectionEventSchema.safeParse(decoded);
      if (projection.success) states.push(projection.data.state);
      else {
        const legacy = IssueWorkflowStateSchema.safeParse(decoded);
        if (legacy.success) states.push(legacy.data);
      }
    }
    const continued = [...events].reverse().find((event) => event.workflowExecutionContinuedAsNewEventAttributes) as { workflowExecutionContinuedAsNewEventAttributes?: { newExecutionRunId?: string } } | undefined;
    runId = continued?.workflowExecutionContinuedAsNewEventAttributes?.newExecutionRunId;
  }
  if (runId && seen.has(runId)) throw new IssueWorkflowStartFailure("workflow_identity_conflict", false);
  const current = states.filter((state) => identityMatches(state, input)).sort((left, right) => right.revision - left.revision)[0];
  if (current) return current;
  throw new IssueWorkflowStartFailure("workflow_identity_conflict", false);
}

export async function startIssueWorkflow(config: ForgeConfig, input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }): Promise<{ workflowId: string; runId: string; existing?: boolean }> {
  const identifiers = runtimeIdentifiers(config.installationId);
  const workflowId = input.workflowId ?? `${identifiers.workflowPrefix}-issue-${input.issueId}`;
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) {
    throw new Error(`Refusing issue workflow ID outside this installation scope: ${workflowId}`);
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
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
        memo: { creationIdentity: expectedCreationIdentity(validatedInput) },
        searchAttributes,
      });
      return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
    } catch {
      // A client timeout can happen after Temporal accepted StartWorkflowExecution.
      // Describe first, then query the compact identity marker. Deletion is only
      // safe after Temporal proves that this workflow ID does not exist.
      const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
      try {
        const description = await handle.describe();
        if (!memoMatches(description.memo, validatedInput) || !searchAttributesMatch(description.searchAttributes as Record<string, unknown>, validatedInput)) throw new IssueWorkflowStartFailure("workflow_identity_conflict", false);
        const state = await handle.query(issueStateQuery).then((value) => IssueWorkflowStateSchema.parse(value)).catch(async () => recoverClosedProjection(handle, validatedInput));
        if (!identityMatches(state, validatedInput)) throw new IssueWorkflowStartFailure("workflow_identity_conflict", false);
        return { workflowId, runId: description.runId, existing: true };
      } catch (reconciliationError) {
        if (reconciliationError instanceof IssueWorkflowStartFailure) throw reconciliationError;
        if (reconciliationError instanceof WorkflowNotFoundError) throw new IssueWorkflowStartFailure("workflow_not_started", true);
        // Preserve the fact that the original start may have been accepted.
        // The caller must retain its durable task and retry this exact ID.
        throw new IssueWorkflowStartFailure("workflow_start_ambiguous", false);
      }
    }
  } finally {
    await temporalClient.connection.close();
  }
}

export function issueCommandId(workflowId: string, command: IssueCommand, input: StartPlanningInput | PlanCommandInput | SendPlannerNoteInput): string {
  const descriptor = issueCommands[command];
  if (descriptor.family === "bespoke" || descriptor.durableCommandKind === null) throw new Error(`Command ${command} requires its dedicated client function`);
  return durableCommand(workflowId, descriptor.durableCommandKind, input).commandId;
}

export async function executeIssueCommand(config: ForgeConfig, workflowId: string, command: IssueCommand, input: StartPlanningInput | PlanCommandInput | SendPlannerNoteInput): Promise<IssueWorkflowState> {
  const descriptor = issueCommands[command];
  if (descriptor.family === "bespoke") throw new Error(`Command ${command} requires its dedicated client function`);
  const identifiers = runtimeIdentifiers(config.installationId);
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
  const schema = command === "send_planner_note" ? SendPlannerNoteInputSchema : descriptor.family === "start" ? StartPlanningInputSchema : PlanCommandInputSchema;
  const durable = descriptor.durableCommandKind === null ? input : durableCommand(workflowId, descriptor.durableCommandKind, input);
  const validatedInput = schema.parse(durable);
  assertPayloadWithinLimit(descriptor.payloadLabel, validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(issueUpdates[command] as never, { args: [validatedInput as never], updateId: (validatedInput as { commandId: string }).commandId }));
  } finally {
    await temporalClient.connection.close();
  }
}

export async function acceptIssuePlanning(config: ForgeConfig, workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
  const validatedInput = StartPlanningInputSchema.parse(durableCommand(workflowId, issueCommands.start_planning.durableCommandKind!, input));
  assertPayloadWithinLimit("startPlanning command", validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    await temporalClient.client.workflow.withDeadline(Date.now() + UPDATE_ACCEPTANCE_TIMEOUT_MS, () => handle.startUpdate(issueUpdates.start_planning, { args: [validatedInput], waitForStage: WorkflowUpdateStage.ACCEPTED }));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = IssueWorkflowStateSchema.parse(await handle.query(issueStateQuery));
      if (state.revision > validatedInput.expectedRevision) return state;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Planning update was accepted but did not advance Workflow state");
  } finally {
    await temporalClient.connection.close();
  }
}

export async function acceptIssueDevelopment(config: ForgeConfig, workflowId: string, input: StartPlanningInput, command: "start_development" | "retry_development" = "start_development"): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
  const validatedInput = StartPlanningInputSchema.parse(durableCommand(workflowId, issueCommands[command].durableCommandKind!, input));
  assertPayloadWithinLimit(issueCommands[command].payloadLabel, validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    await temporalClient.client.workflow.withDeadline(Date.now() + UPDATE_ACCEPTANCE_TIMEOUT_MS, () => handle.startUpdate(issueUpdates[command], { args: [validatedInput], waitForStage: WorkflowUpdateStage.ACCEPTED }));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = IssueWorkflowStateSchema.parse(await handle.query(issueStateQuery));
      if (state.revision > validatedInput.expectedRevision) return state;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${issueCommands[command].label} update was accepted but did not advance Workflow state`);
  } finally {
    await temporalClient.connection.close();
  }
}

export async function reconcileIssueDeveloperDelivery(config: ForgeConfig, workflowId: string, input: StartPlanningInput & { reconcileOnly: true }): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
  const validatedInput = StartPlanningInputSchema.parse(input);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(issueUpdates.retry_development, { args: [validatedInput], updateId: validatedInput.commandId }));
  } finally { await temporalClient.connection.close(); }
}

export async function resolveIssueDecisionBlocker(config: ForgeConfig, workflowId: string, input: ResolveDecisionBlockerInput): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
  const validatedInput = ResolveDecisionBlockerInputSchema.parse(input);
  assertPayloadWithinLimit("decision blocker resolution command", validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(issueUpdates.resolve_decision_blocker, { args: [validatedInput] }));
  } finally { await temporalClient.connection.close(); }
}

export async function resyncIssueProjection(config: ForgeConfig, workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
  const validatedInput = StartPlanningInputSchema.parse(input);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(issueUpdates.resync_projection, { args: [validatedInput] }));
  } finally { await temporalClient.connection.close(); }
}

export async function rejectIssuePlan(config: ForgeConfig, workflowId: string, input: PlanCommandInput): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
  const validatedInput = PlanCommandInputSchema.parse(durableCommand(workflowId, "rejectPlan", input));
  assertPayloadWithinLimit("plan command", validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(issueUpdates.reject_plan, { args: [validatedInput], updateId: validatedInput.commandId }));
  } finally { await temporalClient.connection.close(); }
}

export async function reviseIssuePlan(config: ForgeConfig, workflowId: string, input: PlanRevisionCommand): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
  const validatedInput = PlanRevisionCommandSchema.parse(input);
  assertPayloadWithinLimit("plan revision command", validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(issueUpdates.revise_plan, { args: [validatedInput] }));
  } finally { await temporalClient.connection.close(); }
}

export async function continueIssueWork(config: ForgeConfig, workflowId: string, input: ContinueWorkCommand): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
  const validatedInput = ContinueWorkCommandSchema.parse(input);
  assertPayloadWithinLimit("continue work command", validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(issueUpdates.continue_work, { args: [validatedInput] }));
  } finally { await temporalClient.connection.close(); }
}

export async function queryIssueWorkflow(config: ForgeConfig, workflowId: string): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.query(issueStateQuery));
  } finally {
    await temporalClient.connection.close();
  }
}

export async function signalIssueGithubPullRequestSync(config: ForgeConfig, workflowId: string): Promise<void> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
  const temporalClient = await connectTemporal(config);
  try { await temporalClient.client.workflow.getHandle(workflowId).signal(syncGithubPullRequestSignal); }
  finally { await temporalClient.connection.close(); }
}

export async function recordIssueProgress(config: ForgeConfig, workflowId: string, input: RecordProgressInput): Promise<IssueWorkflowState> {
  const identifiers = runtimeIdentifiers(config.installationId);
  if (!workflowId.startsWith(`${identifiers.workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
  const validatedInput = RecordProgressInputSchema.parse(durableCommand(workflowId, "record-progress", input));
  assertPayloadWithinLimit("recordProgress command", validatedInput);
  const temporalClient = await connectTemporal(config);
  try {
    const handle: WorkflowHandle<typeof issueWorkflow> = temporalClient.client.workflow.getHandle(workflowId);
    return IssueWorkflowStateSchema.parse(await handle.executeUpdate(issueUpdates.record_progress, { args: [validatedInput], updateId: validatedInput.commandId }));
  } finally {
    await temporalClient.connection.close();
  }
}
