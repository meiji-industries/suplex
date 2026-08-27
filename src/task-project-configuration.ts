import { z } from "zod";
import type Database from "better-sqlite3";
import type { ArtifactStore } from "./artifacts.js";
import { jsonRequired } from "./task-utils.js";

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
  prompts: z.object({
    artifactId: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    overrides: z.array(z.string().min(1)),
  }).strict().optional(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pull_request"), number: z.number().int().positive(), url: z.string().url(), headBranch: z.string().min(1), baseBranch: z.string().min(1), headSha: z.string().regex(/^[a-f0-9]{40,64}$/i), baseSha: z.string().regex(/^[a-f0-9]{40,64}$/i) }).strict(),
    z.object({ kind: z.literal("branch"), branch: z.string().min(1), headSha: z.string().regex(/^[a-f0-9]{40,64}$/i) }).strict(),
  ]).optional(),
}).strict();

export type TaskProjectConfiguration = z.infer<typeof TaskProjectConfigurationSchema>;

export type LoadedTaskProjectConfiguration = TaskProjectConfiguration & {
  artifactId: string;
  artifactSha256: string;
};

export function parseTaskProjectConfiguration(value: string | unknown): TaskProjectConfiguration {
  try {
    return TaskProjectConfigurationSchema.parse(typeof value === "string" ? jsonRequired(value) : value);
  } catch {
    throw new Error("Task project configuration is unavailable");
  }
}

/**
 * Loads the immutable configuration captured for a task.  Runtime code must
 * use this rather than consulting the mutable project row or its revisions.
 */
export function loadTaskConfiguration(
  db: Database.Database,
  artifacts: ArtifactStore,
  input: { taskId: string; companyId: string },
): LoadedTaskProjectConfiguration {
  const task = db.prepare(`SELECT t.id, t.project_configuration_artifact_id
    FROM forge_tasks t
    WHERE t.id = ? AND t.company_id = ?`).get(input.taskId, input.companyId) as {
      id: string; project_configuration_artifact_id: string | null;
    } | undefined;
  if (!task) throw new Error("Task project configuration is unavailable");
  if (!task.project_configuration_artifact_id) throw new Error("Task project configuration is unavailable");
  const artifact = db.prepare("SELECT id, storage_path, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-project-configuration'").get(task.project_configuration_artifact_id, input.companyId) as { id: string; storage_path: string; sha256: string } | undefined;
  if (!artifact) throw new Error("Task project configuration is unavailable");
  return { ...parseTaskProjectConfiguration(artifacts.getArtifactSync({ companyId: input.companyId, storagePath: artifact.storage_path, sha256: artifact.sha256 }).toString("utf8")), artifactId: artifact.id, artifactSha256: artifact.sha256 };
}
