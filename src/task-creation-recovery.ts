import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { resolveAgentProfiles } from "./projects.js";
import { IssueWorkflowStartFailure, startIssueWorkflow } from "./engine/service.js";
import { jsonRequired } from "./task-utils.js";

interface CreationIntentRow {
  id: string;
  task_id: string;
  workflow_id: string;
  company_id: string;
  project_id: string;
  project_revision_id: string;
  request_hash: string;
  brief_artifact_id: string;
  brief_sha256: string;
  image_artifact_ids_json: string;
  role_agents_json: string;
  supplemental_review: number;
}

export interface TaskCreationReconciliationResult {
  inspected: number;
  started: number;
  failed: number;
}

/** Start committed task workflows that were interrupted before Engine confirmation. */
export async function reconcileTaskCreationIntents(database: ForgeDatabase, config: ForgeConfig, startWorkflow: typeof startIssueWorkflow = startIssueWorkflow): Promise<TaskCreationReconciliationResult> {
  const intents = database.authQuery((db) => db.prepare(`SELECT i.id, i.task_id, i.workflow_id, i.company_id, i.project_id, i.project_revision_id,
      t.request_hash, t.brief_artifact_id, b.sha256 AS brief_sha256, t.image_artifact_ids_json, t.role_agents_json, t.supplemental_review
    FROM forge_task_creation_intents i
    JOIN forge_tasks t ON t.id = i.task_id AND t.company_id = i.company_id AND t.project_id = i.project_id AND t.workflow_id = i.workflow_id AND t.project_revision_id = i.project_revision_id
    JOIN forge_artifacts b ON b.id = t.brief_artifact_id AND b.company_id = i.company_id
    WHERE i.state = 'workflow_starting'
    ORDER BY i.created_at, i.id`).all() as CreationIntentRow[]);
  let started = 0;
  let failed = 0;
  for (const intent of intents) {
    try {
      await startWorkflow(config, {
        workflowId: intent.workflow_id,
        companyId: intent.company_id,
        projectId: intent.project_id,
        issueId: intent.task_id,
        projectRevisionId: intent.project_revision_id,
        briefArtifactId: intent.brief_artifact_id,
        briefSha256: intent.brief_sha256,
        imageArtifactIds: jsonRequired(intent.image_artifact_ids_json) as string[],
        requestHash: intent.request_hash,
        roleProfiles: database.authQuery((db) => resolveAgentProfiles(db, jsonRequired(intent.role_agents_json) as { planner?: string; builder?: string; reviewer?: string })),
        supplementalReview: intent.supplemental_review === 1,
        repairCycleLimit: config.deliveryRepairCycleLimit,
      });
    } catch (error) {
      const errorCode = error instanceof IssueWorkflowStartFailure ? error.code : "workflow_start_ambiguous";
      database.authQuery((db) => db.prepare("UPDATE forge_task_creation_intents SET error_code = ?, updated_at = ? WHERE id = ? AND state = 'workflow_starting'").run(errorCode, new Date().toISOString(), intent.id));
      failed += 1;
      continue;
    }
    database.authQuery((db) => db.prepare("UPDATE forge_task_creation_intents SET state = 'started', error_code = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND state = 'workflow_starting'").run(new Date().toISOString(), intent.id));
    started += 1;
  }
  return { inspected: intents.length, started, failed };
}
