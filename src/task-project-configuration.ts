import { z } from "zod";
import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import type { ArtifactStore } from "./artifacts.js";
import { resolveAgentProfiles } from "./projects.js";
import { jsonRequired, parseRoleAgents } from "./task-utils.js";

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

const WorkflowTargetBaseSchema = z.object({ targetBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional() }).passthrough();

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
  const task = db.prepare(`SELECT t.id, t.project_id, t.role_agents_json, t.project_configuration_artifact_id
    FROM forge_tasks t
    WHERE t.id = ? AND t.company_id = ?`).get(input.taskId, input.companyId) as {
      id: string; project_id: string; role_agents_json: string; project_configuration_artifact_id: string | null;
    } | undefined;
  if (!task) throw new Error("Task project configuration is unavailable");
  if (!task.project_configuration_artifact_id) {
    const project = db.prepare("SELECT name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json FROM forge_projects WHERE id = ? AND company_id = ?").get(task.project_id, input.companyId) as { name: string; repository_path: string; worktree_root: string; repository_identity: string | null; base_branch: string; target_branch: string; setup_command: string; verification_command: string; required_checks_json: string } | undefined;
    if (!project) throw new Error("Task project configuration is unavailable");
    const snapshot = db.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND company_id = ? ORDER BY revision DESC LIMIT 1").get(task.id, input.companyId) as { state_json: string } | undefined;
    let targetBaseSha: string | undefined;
    try { targetBaseSha = snapshot ? WorkflowTargetBaseSchema.parse(jsonRequired(snapshot.state_json)).targetBaseSha ?? undefined : undefined; } catch {}
    const baseSha = targetBaseSha ?? execFileSync("git", ["rev-parse", project.base_branch], { cwd: project.repository_path, encoding: "utf8" }).trim();
    const targetSha = targetBaseSha ?? execFileSync("git", ["rev-parse", project.target_branch], { cwd: project.repository_path, encoding: "utf8" }).trim();
    const capturedAt = new Date().toISOString();
    const roleAgents = parseRoleAgents(task.role_agents_json);
    const configuration = parseTaskProjectConfiguration({
      projectId: task.project_id,
      projectName: project.name,
      repositoryPath: project.repository_path,
      worktreeRoot: project.worktree_root,
      repository: project.repository_identity,
      baseBranch: project.base_branch,
      targetBranch: project.target_branch,
      baseSha,
      targetSha,
      setupCommand: project.setup_command,
      verificationCommand: project.verification_command,
      requiredChecks: jsonRequired(project.required_checks_json),
      roleAgents,
      roleProfiles: resolveAgentProfiles(db, roleAgents),
      capturedAt,
    });
    const artifact = artifacts.putArtifactSync(db, input.companyId, "task-project-configuration", { taskId: task.id, filename: `project-configuration-${task.id}.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify(configuration), "utf8") });
    db.prepare("UPDATE forge_tasks SET project_configuration_artifact_id = ?, project_configuration_captured_at = ? WHERE id = ? AND company_id = ?").run(artifact.id, capturedAt, task.id, input.companyId);
    db.prepare("DELETE FROM forge_task_configuration_backfill WHERE task_id = ?").run(task.id);
    return { ...configuration, artifactId: artifact.id, artifactSha256: artifact.sha256 };
  }
  const artifact = db.prepare("SELECT id, storage_path, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = 'task-project-configuration'").get(task.project_configuration_artifact_id, input.companyId) as { id: string; storage_path: string; sha256: string } | undefined;
  if (!artifact) throw new Error("Task project configuration is unavailable");
  return { ...parseTaskProjectConfiguration(artifacts.getArtifactSync({ companyId: input.companyId, storagePath: artifact.storage_path, sha256: artifact.sha256 }).toString("utf8")), artifactId: artifact.id, artifactSha256: artifact.sha256 };
}
