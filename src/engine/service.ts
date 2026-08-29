import { createHash } from "node:crypto";
import type { ForgeConfig } from "../config.js";
import { issueCommands, type IssueCommand } from "../commands/registry.js";
import { runtimeIdentifiers } from "../runtime-identifiers.js";
import { getIssueEngine } from "./index.js";
import { issueUpdates, syncGithubPullRequestSignal } from "./issue-updates.js";
import { ContinueWorkCommandSchema, IssueWorkflowInputSchema, IssueWorkflowStateSchema, PlanCommandInputSchema, PlanRevisionCommandSchema, RecordProgressInputSchema, ResolveDecisionBlockerInputSchema, SendPlannerNoteInputSchema, StartPlanningInputSchema, type ContinueWorkCommand, type IssueWorkflowInput, type IssueWorkflowState, type PlanCommandInput, type PlanRevisionCommand, type RecordProgressInput, type ResolveDecisionBlockerInput, type SendPlannerNoteInput, type StartPlanningInput } from "./issue-contracts.js";

export function durableCommand<T extends { expectedRevision: number; actorUserId: string; commandId?: string | undefined }>(workflowId: string, kind: string, input: T): T & { commandId: string } {
  if (input.commandId) return { ...input, commandId: input.commandId };
  return { ...input, commandId: `command_${createHash("sha256").update(JSON.stringify([workflowId, kind, input])).digest("hex")}` };
}
export class IssueWorkflowStartFailure extends Error {
  constructor(readonly code: "workflow_not_started" | "workflow_start_ambiguous" | "workflow_identity_conflict", readonly provenAbsent: boolean) { super(code); this.name = "IssueWorkflowStartFailure"; }
}
function assertScoped(config: ForgeConfig, workflowId: string): void {
  if (!workflowId.startsWith(`${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-`)) throw new Error("Refusing issue workflow outside this installation scope");
}
export async function startIssueWorkflow(config: ForgeConfig, input: Omit<IssueWorkflowInput, "workflowId"> & { workflowId?: string }): Promise<{ workflowId: string; runId: string; existing?: boolean }> {
  const workflowId = input.workflowId ?? `${runtimeIdentifiers(config.installationId).workflowPrefix}-issue-${input.issueId}`;
  assertScoped(config, workflowId);
  const validated = IssueWorkflowInputSchema.parse({ ...input, workflowId });
  const engine = getIssueEngine(config);
  const snapshot = engine.database.authQuery((db) => db.prepare("SELECT state_json, run_id FROM forge_workflow_snapshots WHERE workflow_id = ? ORDER BY revision DESC LIMIT 1").get(workflowId) as { state_json: string; run_id: string } | undefined);
  if (snapshot || engine.runs.has(workflowId)) {
    const state = snapshot ? IssueWorkflowStateSchema.parse(JSON.parse(snapshot.state_json)) : engine.run(workflowId).state;
    if (state.issueId !== validated.issueId || state.companyId !== validated.companyId || state.projectId !== validated.projectId || state.projectRevisionId !== validated.projectRevisionId) throw new IssueWorkflowStartFailure("workflow_identity_conflict", false);
    return { workflowId, runId: snapshot?.run_id ?? engine.run(workflowId).runId, existing: true };
  }
  const run = await engine.create(validated); return { workflowId, runId: run.runId };
}
export function issueCommandId(workflowId: string, command: IssueCommand, input: StartPlanningInput | PlanCommandInput | SendPlannerNoteInput): string {
  const descriptor = issueCommands[command];
  if (descriptor.family === "bespoke" || descriptor.durableCommandKind === null) throw new Error(`Command ${command} requires its dedicated client function`);
  return durableCommand(workflowId, descriptor.durableCommandKind, input).commandId;
}
export async function executeIssueCommand(config: ForgeConfig, workflowId: string, command: IssueCommand, input: StartPlanningInput | PlanCommandInput | SendPlannerNoteInput): Promise<IssueWorkflowState> {
  assertScoped(config, workflowId); const descriptor = issueCommands[command];
  if (descriptor.family === "bespoke") throw new Error(`Command ${command} requires its dedicated client function`);
  const schema = command === "send_planner_note" ? SendPlannerNoteInputSchema : descriptor.family === "start" ? StartPlanningInputSchema : PlanCommandInputSchema;
  const durable = descriptor.durableCommandKind === null ? input : durableCommand(workflowId, descriptor.durableCommandKind, input);
  const validated = schema.parse(durable) as typeof durable;
  return getIssueEngine(config).run(workflowId).execute(issueUpdates[command], validated, "commandId" in validated ? String(validated.commandId) : "legacy-command");
}
export async function acceptIssuePlanning(config: ForgeConfig, workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> { return executeIssueCommand(config, workflowId, "start_planning", input); }
export async function acceptIssueDevelopment(config: ForgeConfig, workflowId: string, input: StartPlanningInput, command: "start_development" | "retry_development" = "start_development"): Promise<IssueWorkflowState> { return executeIssueCommand(config, workflowId, command, input); }
export async function reconcileIssueDeveloperDelivery(config: ForgeConfig, workflowId: string, input: StartPlanningInput & { reconcileOnly: true }): Promise<IssueWorkflowState> {
  const validated = StartPlanningInputSchema.parse(durableCommand(workflowId, issueCommands.verify_developer_ownership.durableCommandKind!, input));
  return getIssueEngine(config).run(workflowId).execute(issueUpdates.verify_developer_ownership, { ...validated, reconcileOnly: true }, validated.commandId);
}
export async function resolveIssueDecisionBlocker(config: ForgeConfig, workflowId: string, input: ResolveDecisionBlockerInput): Promise<IssueWorkflowState> { return dedicated(config, workflowId, "resolve_decision_blocker", input, ResolveDecisionBlockerInputSchema); }
export async function resyncIssueProjection(config: ForgeConfig, workflowId: string, input: StartPlanningInput): Promise<IssueWorkflowState> { return dedicated(config, workflowId, "resync_projection", input, StartPlanningInputSchema); }
export async function rejectIssuePlan(config: ForgeConfig, workflowId: string, input: PlanCommandInput): Promise<IssueWorkflowState> { return dedicated(config, workflowId, "reject_plan", input, PlanCommandInputSchema); }
export async function reviseIssuePlan(config: ForgeConfig, workflowId: string, input: PlanRevisionCommand): Promise<IssueWorkflowState> { return dedicated(config, workflowId, "revise_plan", input, PlanRevisionCommandSchema); }
export async function continueIssueWork(config: ForgeConfig, workflowId: string, input: ContinueWorkCommand): Promise<IssueWorkflowState> { return dedicated(config, workflowId, "continue_work", input, ContinueWorkCommandSchema); }
export async function recordIssueProgress(config: ForgeConfig, workflowId: string, input: RecordProgressInput): Promise<IssueWorkflowState> { return dedicated(config, workflowId, "record_progress", input, RecordProgressInputSchema); }
async function dedicated(config: ForgeConfig, workflowId: string, command: IssueCommand, input: object, schema: { parse(value: unknown): any }): Promise<IssueWorkflowState> {
  assertScoped(config, workflowId); const kind = issueCommands[command].durableCommandKind; const validated = schema.parse(kind ? durableCommand(workflowId, kind, input as never) : input);
  return getIssueEngine(config).run(workflowId).execute(issueUpdates[command], validated, validated.commandId ?? "legacy-command");
}
export async function queryIssueWorkflow(config: ForgeConfig, workflowId: string): Promise<IssueWorkflowState> { assertScoped(config, workflowId); return getIssueEngine(config).run(workflowId).state; }
export async function signalIssueGithubPullRequestSync(config: ForgeConfig, workflowId: string): Promise<void> { assertScoped(config, workflowId); await getIssueEngine(config).run(workflowId).signal(syncGithubPullRequestSignal); }
export async function recoverClosedProjection(config: ForgeConfig, workflowId: string): Promise<IssueWorkflowState> {
  const engine = getIssueEngine(config); const row = engine.database.authQuery((db) => db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE workflow_id = ? ORDER BY revision DESC LIMIT 1").get(workflowId) as { state_json: string } | undefined);
  if (!row) throw new IssueWorkflowStartFailure("workflow_not_started", true); return IssueWorkflowStateSchema.parse(JSON.parse(row.state_json));
}

export async function connectEngine(config: ForgeConfig) {
  const engine = getIssueEngine(config);
  const getHandle = (workflowId: string, _runId?: string) => ({
    workflowId,
    query: async (_name: string) => engine.run(workflowId).state,
    executeUpdate: async (name: string, options: { args?: unknown[]; updateId?: string }) => engine.run(workflowId).execute(name, options.args?.[0], options.updateId ?? ((options.args?.[0] as { commandId?: string } | undefined)?.commandId ?? "legacy-command")),
    signal: async (name: string, ...args: unknown[]) => engine.run(workflowId).signal(name, ...args),
    describe: async () => ({ runId: engine.run(workflowId).runId, rootExecution: { runId: engine.run(workflowId).runId }, status: { name: "RUNNING" } }),
    fetchHistory: async () => ({ events: [] }),
  });
  return { connection: { close: async () => undefined, workflowService: { describeWorkflowExecution: async ({ execution }: { execution: { workflowId: string }; namespace?: string }) => ({ workflowExecutionInfo: { status: "RUNNING", execution: { workflowId: execution.workflowId, runId: engine.run(execution.workflowId).runId } }, pendingWorkflowTask: undefined }) } }, client: { workflow: { getHandle } } };
}
export async function ensureEngineFoundation(..._args: unknown[]): Promise<void> {}
export class EngineHealthProbe {
  constructor(private readonly config: ForgeConfig) {}
  async check() { const engine = getIssueEngine(this.config); const activities = engine.database.authQuery((db) => (db.prepare("SELECT count(*) count FROM forge_engine_activities").get() as { count: number }).count); return { id: "engine" as const, label: "Engine", status: "healthy" as const, summary: "In-process engine is ready", details: { runs: engine.runs.size, activities } }; }
}
