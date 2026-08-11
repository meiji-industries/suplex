import { randomBytes } from "node:crypto";

import type { ForgeDatabase } from "../database.js";
import type { ForgeConfig } from "../config.js";
import { ArtifactStore } from "../artifacts.js";
import { redact } from "../logging.js";
import { AgentService } from "../codex-lead.js";
import { ProbeWorkflowInputSchema, ProbeWorkflowStateSchema, type ProbeActivities, type ProbeWorkflowInput, type ProbeWorkflowState } from "./contracts.js";
import { IssueWorkflowStateSchema, type IssueActivities, type IssueWorkflowState } from "./issue-contracts.js";
import { StructuredLogger, activityLogContext } from "../logging.js";

export interface ActivityOptions {
  agent?: Partial<Pick<AgentService, "runLeadPlanning" | "runSupplementalReview" | "consolidateLeadPlan">>;
}

export function createActivities(database: ForgeDatabase, config: ForgeConfig, options: ActivityOptions = {}): ProbeActivities & IssueActivities {
  const logger = new StructuredLogger();
  const defaultAgent = new AgentService(database, config);
  const agent = options.agent;
  return {
    async recordProbeStarted(input: ProbeWorkflowInput): Promise<ProbeWorkflowState> {
      const validatedInput = ProbeWorkflowInputSchema.parse(input);
      logger.child(activityLogContext()).info("Probe activity started", {
        companyId: validatedInput.companyId,
      });
      database.recordProbe({
        workflowId: validatedInput.workflowId,
        probeId: validatedInput.probeId,
        companyId: validatedInput.companyId,
        status: "running",
      });
      return ProbeWorkflowStateSchema.parse({
        ...validatedInput,
        status: "running",
      });
    },
    async projectIssueState(input: IssueWorkflowState): Promise<IssueWorkflowState> {
      const state = IssueWorkflowStateSchema.parse(input);
      database.projectIssueState({
        taskId: state.issueId,
        companyId: state.companyId,
        projectId: state.projectId,
        workflowId: state.workflowId,
        revision: state.revision,
        phase: state.phase,
        owner: state.owner,
        allowedCommands: state.allowedCommands,
        pendingAction: state.pendingAction,
        lastEventId: state.lastEventId,
      });
      return state;
    },
    async runLeadPlanning(input) {
      return (agent?.runLeadPlanning ?? defaultAgent.runLeadPlanning.bind(defaultAgent))(input);
    },
    async runSupplementalReview(input) {
      return (agent?.runSupplementalReview ?? defaultAgent.runSupplementalReview.bind(defaultAgent))(input);
    },
    async consolidateLeadPlan(input) {
      return (agent?.consolidateLeadPlan ?? defaultAgent.consolidateLeadPlan.bind(defaultAgent))(input);
    },
    async recordPlanDecision(input) {
      const actor = database.authQuery((db) => db.prepare("SELECT id, role, status FROM forge_users WHERE id = ?").get(input.actorUserId) as { id: string; role: string; status: string } | undefined);
      if (!actor || actor.status !== "active") throw new Error("Plan decision actor is unavailable");
      const scoped = database.authQuery((db) => actor.role === "admin" ? db.prepare("SELECT id FROM forge_tasks WHERE id = ? AND company_id = ? AND workflow_id = ?").get(input.taskId, input.companyId, input.workflowId) : db.prepare("SELECT t.id FROM forge_tasks t JOIN forge_memberships m ON m.company_id = t.company_id WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND m.user_id = ?").get(input.taskId, input.companyId, input.workflowId, input.actorUserId)) as { id: string } | undefined;
      if (!scoped) throw new Error("Plan decision scope is unavailable");
      const note = (redact(input.note.trim()) as string) || `${input.decision} plan`;
      const artifact = await new ArtifactStore(config.artifactRoot).put(input.companyId, "plan-decision", { filename: `decision_${input.planRevision}.md`, mimeType: "text/markdown", bytes: Buffer.from(note, "utf8") });
      const decisionId = `decision_${randomBytes(12).toString("hex")}`;
      database.authTransaction((db) => {
        db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifact.id, artifact.companyId, artifact.kind, artifact.filename, artifact.mimeType, artifact.byteSize, artifact.sha256, artifact.storagePath, artifact.createdAt);
        db.prepare("INSERT INTO forge_plan_decisions (id, task_id, company_id, workflow_id, plan_revision, decision, actor_user_id, note_artifact_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(decisionId, input.taskId, input.companyId, input.workflowId, input.planRevision, input.decision, input.actorUserId, artifact.id, artifact.createdAt);
      });
      return { decisionId };
    },
  };
}
