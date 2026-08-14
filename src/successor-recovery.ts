import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { resolveAgentProfiles } from "./projects.js";
import { startIssueWorkflow } from "./temporal/service.js";

interface SuccessorIntentRow {
  id: string;
  predecessor_task_id: string;
  predecessor_workflow_id: string;
  accepted_revision: number;
  successor_task_id: string;
  successor_workflow_id: string;
  company_id: string;
  project_id: string;
  project_revision_id: string;
  actor_user_id: string;
  state: "prepared" | "workflow_starting" | "started" | "linked";
}

/** Reconcile successors whose durable rows were committed before Temporal start completed. */
export async function reconcileSuccessorIntents(database: ForgeDatabase, config: ForgeConfig, startWorkflow: typeof startIssueWorkflow = startIssueWorkflow): Promise<void> {
  const intents = database.authQuery((db) => db.prepare("SELECT id, predecessor_task_id, predecessor_workflow_id, accepted_revision, successor_task_id, successor_workflow_id, company_id, project_id, project_revision_id, actor_user_id, state FROM forge_successor_intents WHERE state IN ('prepared', 'workflow_starting', 'started') ORDER BY created_at, id").all() as SuccessorIntentRow[]);
  for (const intent of intents) {
    const task = database.authQuery((db) => db.prepare(`SELECT t.brief_artifact_id AS briefArtifactId, b.sha256 AS briefSha256, t.image_artifact_ids_json AS imageIdsJson, t.role_agents_json AS roleAgentsJson, t.supplemental_review AS supplementalReview, t.request_hash AS requestHash
      FROM forge_tasks t JOIN forge_artifacts b ON b.id = t.brief_artifact_id
      WHERE t.id = ? AND t.company_id = ? AND t.workflow_id = ? AND t.predecessor_task_id = ? AND t.project_revision_id = ?`).get(intent.successor_task_id, intent.company_id, intent.successor_workflow_id, intent.predecessor_task_id, intent.project_revision_id) as { briefArtifactId: string; briefSha256: string; imageIdsJson: string; roleAgentsJson: string; supplementalReview: number; requestHash: string | null } | undefined);
    if (!task) continue;
    try {
      await startWorkflow(config, {
        workflowId: intent.successor_workflow_id,
        companyId: intent.company_id,
        projectId: intent.project_id,
        issueId: intent.successor_task_id,
        predecessorTaskId: intent.predecessor_task_id,
        projectRevisionId: intent.project_revision_id,
        briefArtifactId: task.briefArtifactId,
        briefSha256: task.briefSha256,
        imageArtifactIds: JSON.parse(task.imageIdsJson) as string[],
        requestHash: task.requestHash ?? undefined,
        roleProfiles: database.authQuery((db) => resolveAgentProfiles(db, JSON.parse(task.roleAgentsJson) as { analyst?: string; implementer?: string; reviewer?: string })),
        supplementalReview: task.supplementalReview === 1,
        repairCycleLimit: config.deliveryRepairCycleLimit,
      });
    } catch {
      continue;
    }
    const now = new Date().toISOString();
    database.authTransaction((db) => {
      db.prepare("UPDATE forge_successor_intents SET state = 'linked', updated_at = ? WHERE id = ? AND state IN ('prepared', 'workflow_starting', 'started')").run(now, intent.id);
      db.prepare("UPDATE forge_tasks SET successor_task_id = ?, updated_at = ? WHERE id = ? AND company_id = ?").run(intent.successor_task_id, now, intent.predecessor_task_id, intent.company_id);
      db.prepare("UPDATE forge_task_creation_intents SET state = 'started', updated_at = ? WHERE id = ? AND state = 'workflow_starting'").run(now, `creation_${intent.id}`);
      db.prepare("INSERT OR IGNORE INTO forge_audit_events (id, actor_user_id, action, company_id, metadata_json, created_at) VALUES (?, ?, 'successor_linked', ?, ?, ?)").run(`audit_successor_link_${intent.id}`, intent.actor_user_id, intent.company_id, JSON.stringify({ intentId: intent.id, predecessorTaskId: intent.predecessor_task_id, successorTaskId: intent.successor_task_id, successorWorkflowId: intent.successor_workflow_id }), now);
    });
  }
}
