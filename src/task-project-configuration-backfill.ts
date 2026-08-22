import { createHash } from "node:crypto";

import { ArtifactStore } from "./artifacts.js";
import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { TaskProjectConfigurationSchema } from "./task-project-configuration.js";
import { jsonRequired } from "./task-utils.js";

type BackfillRow = {
  taskId: string;
  companyId: string;
  projectId: string;
  projectName: string;
  roleAgentsJson: string;
  capturedAt: string;
  normalizedJson: string | null;
  repositoryPath: string;
  worktreeRoot: string;
  repository: string | null;
  baseBranch: string;
  targetBranch: string;
  setupCommand: string;
  verificationCommand: string;
  requiredChecksJson: string;
};

/** Materializes task-owned snapshots before revision storage is retired. */
export async function backfillTaskProjectConfigurations(database: ForgeDatabase, config: ForgeConfig): Promise<{ materialized: number; recoveredFromProject: number }> {
  const rows = database.authQuery((db) => db.prepare(`SELECT t.id AS taskId, t.company_id AS companyId, t.project_id AS projectId,
    p.name AS projectName, t.role_agents_json AS roleAgentsJson, COALESCE(t.project_configuration_captured_at, t.created_at) AS capturedAt,
    r.normalized_json AS normalizedJson, p.repository_path AS repositoryPath, p.worktree_root AS worktreeRoot,
    p.repository_identity AS repository, p.base_branch AS baseBranch, p.target_branch AS targetBranch,
    p.setup_command AS setupCommand, p.verification_command AS verificationCommand, p.required_checks_json AS requiredChecksJson
    FROM forge_tasks t JOIN forge_projects p ON p.id = t.project_id
    LEFT JOIN forge_project_revisions r ON r.id = t.project_revision_id AND r.project_id = t.project_id AND r.state = 'accepted'
    WHERE t.project_configuration_artifact_id IS NULL
    ORDER BY t.created_at, t.id`).all() as BackfillRow[]);
  const artifacts = new ArtifactStore(config.artifactRoot, database);
  let materialized = 0;
  let recoveredFromProject = 0;
  for (const row of rows) {
    const source = row.normalizedJson ? jsonRequired(row.normalizedJson) as Record<string, unknown> : {
      repositoryPath: row.repositoryPath, worktreeRoot: row.worktreeRoot, repository: row.repository,
      baseBranch: row.baseBranch, targetBranch: row.targetBranch, setupCommand: row.setupCommand,
      verificationCommand: row.verificationCommand, requiredChecks: jsonRequired(row.requiredChecksJson),
    };
    if (!row.normalizedJson) recoveredFromProject += 1;
    const roleAgents = jsonRequired(row.roleAgentsJson) as Record<string, string>;
    const configuration = TaskProjectConfigurationSchema.parse({
      ...source,
      projectId: row.projectId,
      projectName: row.projectName,
      roleAgents,
      roleProfiles: roleAgents,
      capturedAt: row.capturedAt,
    });
    const bytes = Buffer.from(JSON.stringify(configuration), "utf8");
    const artifact = await artifacts.putArtifact(row.companyId, "task-project-configuration", {
      filename: `project-configuration-${row.taskId}.json`, mimeType: "application/json", bytes, taskId: row.taskId,
    });
    database.authTransaction((db) => {
      db.prepare("UPDATE forge_tasks SET project_configuration_artifact_id = ?, project_configuration_sha256 = ?, project_configuration_captured_at = ? WHERE id = ? AND company_id = ? AND project_configuration_artifact_id IS NULL")
        .run(artifact.id, createHash("sha256").update(bytes).digest("hex"), configuration.capturedAt, row.taskId, row.companyId);
      db.prepare("DELETE FROM forge_task_configuration_backfill WHERE task_id = ?").run(row.taskId);
    });
    materialized += 1;
  }
  return { materialized, recoveredFromProject };
}
