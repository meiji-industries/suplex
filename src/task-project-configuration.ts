import { z } from "zod";
import type Database from "better-sqlite3";
import type { ArtifactStore } from "./artifacts.js";

const RoleAssignmentsSchema = z.object({
  planner: z.string().min(1).optional(),
  builder: z.string().min(1),
  reviewer: z.string().min(1).optional(),
  integrator: z.string().min(1).optional(),
}).strict();

export const TaskProjectConfigurationSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  repositoryPath: z.string().min(1),
  worktreeRoot: z.string().min(1),
  repository: z.string().min(1),
  baseBranch: z.string().min(1),
  targetBranch: z.string().min(1),
  baseSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  targetSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  setupCommand: z.string().min(1),
  verificationCommand: z.string().min(1),
  requiredChecks: z.array(z.string().min(1)).max(32),
  roleAgents: RoleAssignmentsSchema,
  roleProfiles: RoleAssignmentsSchema,
  capturedAt: z.string().datetime(),
}).strict();

export type TaskProjectConfiguration = z.infer<typeof TaskProjectConfigurationSchema>;

export function parseTaskProjectConfiguration(value: string | unknown): TaskProjectConfiguration {
  try {
    return TaskProjectConfigurationSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    throw new Error("Task project configuration is unavailable");
  }
}

/**
 * Reads the immutable configuration belonging to a task.  The revision read is
 * deliberately isolated here as a temporary compatibility path for records
 * created before configuration artifacts existed; all runtime callers use this
 * reader rather than consulting a live project.
 */
export function readTaskProjectConfiguration(
  db: Database.Database,
  artifacts: ArtifactStore,
  input: { taskId: string; companyId: string },
): TaskProjectConfiguration {
  const task = db.prepare(`SELECT t.id, t.project_id, t.project_configuration_artifact_id,
      t.project_configuration_captured_at, t.project_revision_id, t.role_agents_json,
      t.created_at, p.name AS project_name
    FROM forge_tasks t JOIN forge_projects p ON p.id = t.project_id
    WHERE t.id = ? AND t.company_id = ?`).get(input.taskId, input.companyId) as {
      id: string; project_id: string; project_configuration_artifact_id: string | null;
      project_configuration_captured_at: string | null; project_revision_id: string | null;
      role_agents_json: string; created_at: string; project_name: string;
    } | undefined;
  if (!task) throw new Error("Task project configuration is unavailable");
  if (task.project_configuration_artifact_id) {
    const artifact = db.prepare("SELECT storage_path, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-project-configuration'").get(task.project_configuration_artifact_id, input.companyId) as { storage_path: string; sha256: string } | undefined;
    if (!artifact) throw new Error("Task project configuration is unavailable");
    return parseTaskProjectConfiguration(artifacts.getArtifactSync({ companyId: input.companyId, storagePath: artifact.storage_path, sha256: artifact.sha256 }).toString("utf8"));
  }
  // Compatibility only. Backfill associates this task with an artifact before
  // the revision store is retired.
  const legacy = task.project_revision_id
    ? db.prepare("SELECT normalized_json FROM forge_project_revisions WHERE id = ? AND project_id = ? AND state = 'accepted'").get(task.project_revision_id, task.project_id) as { normalized_json: string } | undefined
    : undefined;
  if (!legacy) throw new Error("Task project configuration is unavailable");
  const value = JSON.parse(legacy.normalized_json) as Record<string, unknown>;
  const roleAgents = JSON.parse(task.role_agents_json) as Record<string, string>;
  return TaskProjectConfigurationSchema.parse({
    ...value,
    projectId: task.project_id,
    projectName: task.project_name,
    roleAgents,
    roleProfiles: roleAgents,
    capturedAt: task.project_configuration_captured_at ?? task.created_at,
  });
}
