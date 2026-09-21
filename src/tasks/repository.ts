import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactStore, StoredArtifact } from "../platform/artifacts.js";
import type { ForgeDatabase } from "../platform/database.js";
import { TaskControlStore } from "../coordination/root-session-store.js";
import { TaskConfigurationSchema, TaskImageSchema, TaskSchema, type DeliveryTarget, type Task, type TaskConfiguration, type TaskInput, type TaskRequest, type VisualEvidence } from "./contracts.js";
import type { TaskProfile } from "./control.js";
import { advisorKeysSorted, publicWorkflowState, type AdvisorRole, type WorkflowId } from "../coordination/workflows.js";
import { taskDependencySummaries } from "./dependencies.js";
import { taskQueue } from "./queue.js";
import { IssueAssociationSchema } from "./issue-association.js";

export type TaskCreator = { kind: "user"; id: string } | { kind: "agent"; id: string };
const RowSchema = z.object({
  issue_json: z.string().nullable(),
  id: z.string(), company_id: z.string(), project_id: z.string(), issue_number: z.number().nullable(), issue_code: z.string().nullable(),
  title: z.string(), description: z.string(), configuration_json: z.string(), idempotency_key: z.string(), request_hash: z.string(), start_queued: z.number(),
  creator_user_id: z.string().nullable(), creator_agent_id: z.string().nullable(), copied_from_task_id: z.string().nullable(), command_revision: z.number(), created_at: z.string(), updated_at: z.string(), activity_updated_at: z.string(), status_changed_at: z.string(), archived_at: z.string().nullable(),
});
export type TaskRow = z.infer<typeof RowSchema>;
const ArtifactRowSchema = z.object({
  id: z.string(), companyId: z.string(), kind: z.string(), filename: z.string(), mimeType: z.string(), byteSize: z.number(),
  sha256: z.string(), storagePath: z.string(), createdAt: z.string(),
});
const select = "SELECT t.*, CASE WHEN julianday(t.updated_at) >= julianday(COALESCE(control.updated_at, t.updated_at)) THEN t.updated_at ELSE control.updated_at END AS activity_updated_at, control.status_changed_at, c.issue_code FROM forge_tasks t JOIN forge_companies c ON c.id = t.company_id LEFT JOIN forge_task_controls control ON control.task_id = t.id";

export class TaskConflict extends Error {}

export function taskRequestHash(input: TaskInput, creator: TaskCreator): string {
  // A Standard request with no Advisor selections and no dependencies hashes exactly like a pre-workflow request.
  const { workflow, advisorProfileIds, dependsOn, ...legacy } = input;
  const advisors = advisorKeysSorted(advisorProfileIds ?? {});
  const dependencies = [...new Set(dependsOn ?? [])].sort();
  const base = dependencies.length ? { ...legacy, dependsOn: dependencies } : legacy;
  const hashed = (workflow ?? "standard") === "standard" && Object.keys(advisors).length === 0 ? base : { ...base, workflow, advisorProfileIds: advisors };
  return createHash("sha256").update(JSON.stringify({ input: hashed, creator })).digest("hex");
}

export class TaskRepository {
  readonly controls: TaskControlStore;
  constructor(private readonly database: ForgeDatabase, private readonly artifacts: ArtifactStore) {
    this.controls = new TaskControlStore(database);
  }

  row(taskId: string): TaskRow | null {
    const row = this.database.authQuery(db => db.prepare(`${select} WHERE t.id = ?`).get(taskId));
    return row ? RowSchema.parse(row) : null;
  }

  rows(): TaskRow[] {
    return this.database.authQuery(db => z.array(RowSchema).parse(db.prepare(`${select} ORDER BY julianday(activity_updated_at) DESC, t.id`).all()));
  }

  agentApiRows(input: { agentId: string; companyId: string; creatorAgentId?: string; projectId?: string; status?: string; archived?: boolean; attention?: boolean; blocker?: boolean; updatedSince?: string; cursor?: { updatedAt: string; id: string }; limit?: number }): TaskRow[] {
    const conditions = ["t.company_id = ?", "a.status = 'paired'", "a.revoked_at IS NULL"];
    const params: Array<string | number> = [input.companyId];
    if (input.creatorAgentId) { conditions.push("t.creator_agent_id = ?"); params.push(input.creatorAgentId); }
    if (input.projectId) { conditions.push("t.project_id = ?"); params.push(input.projectId); }
    if (input.status) { conditions.push("control.status = ?"); params.push(input.status); }
    if (input.archived !== undefined) conditions.push(input.archived ? "t.archived_at IS NOT NULL" : "t.archived_at IS NULL");
    if (input.attention !== undefined) conditions.push(input.attention ? "control.human_question IS NOT NULL AND control.human_question_id IS NOT NULL" : "(control.human_question IS NULL OR control.human_question_id IS NULL)");
    if (input.blocker !== undefined) conditions.push(input.blocker ? "((control.human_question IS NOT NULL AND control.human_question_id IS NOT NULL) OR json_extract(control.workflow_state_json, '$.deliveryWait') IS NOT NULL)" : "((control.human_question IS NULL OR control.human_question_id IS NULL) AND json_extract(control.workflow_state_json, '$.deliveryWait') IS NULL)");
    if (input.updatedSince) { conditions.push("julianday(activity_updated_at) >= julianday(?)"); params.push(input.updatedSince); }
    if (input.cursor) { conditions.push("(julianday(activity_updated_at) < julianday(?) OR (julianday(activity_updated_at) = julianday(?) AND t.id > ?))"); params.push(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.id); }
    if (input.limit !== undefined) params.push(input.limit);
    const limit = input.limit === undefined ? "" : " LIMIT ?";
    return this.database.authQuery(db => z.array(RowSchema).parse(db.prepare(`${select} JOIN forge_external_agents a ON a.id = ? AND a.company_id = t.company_id JOIN forge_external_agent_project_grants g ON g.agent_id = a.id AND g.company_id = t.company_id AND g.project_id = t.project_id WHERE ${conditions.join(" AND ")} ORDER BY julianday(activity_updated_at) DESC, t.id${limit}`).all(input.agentId, ...params)));
  }

  existing(companyId: string, key: string, requestHash: string, creator: TaskCreator): TaskRow | null {
    const value = this.database.authQuery(db => db.prepare(`${select} WHERE t.company_id = ? AND t.idempotency_key = ?`).get(companyId, key));
    if (!value) return null;
    const row = RowSchema.parse(value);
    if (row.request_hash !== requestHash || (creator.kind === "user" ? row.creator_user_id : row.creator_agent_id) !== creator.id) {
      throw new TaskConflict("This idempotency key belongs to a different request");
    }
    return row;
  }

  create(input: {
    taskId: string; companyId: string; creator: TaskCreator; request: TaskRequest;
    requestHash: string; configuration: TaskConfiguration; rootProfile: TaskProfile; workerProfile: TaskProfile; advisorProfiles: Partial<Record<AdvisorRole, TaskProfile>>;
    images: Array<{ filename: string; mimeType: string; bytes: Buffer }>;
    /** The persisted start intent. Creation never starts the task; the caller admits it after its prerequisites are written. */
    startQueued: boolean;
    /** Provenance written with the row itself, so a copy is identifiable without a second write. */
    copiedFromTaskId?: string;
  }): { task: Task; created: boolean } {
    const written: StoredArtifact[] = [];
    try {
      return this.database.authTransaction(db => {
        const existing = this.existing(input.companyId, input.request.idempotencyKey, input.requestHash, input.creator);
        if (existing) return { task: this.task(existing), created: false };
        const time = new Date().toISOString();
        const configuration = TaskConfigurationSchema.parse(input.configuration);
        db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, description, configuration_json, idempotency_key, request_hash, start_queued, creator_user_id, creator_agent_id, copied_from_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(input.taskId, input.companyId, input.request.projectId, input.request.title, input.request.description, JSON.stringify(configuration), input.request.idempotencyKey, input.requestHash, input.startQueued ? 1 : 0, input.creator.kind === "user" ? input.creator.id : null, input.creator.kind === "agent" ? input.creator.id : null, input.copiedFromTaskId ?? null, time, time);
        for (const image of input.images) written.push(this.artifacts.putArtifactSync(db, input.companyId, "task-image", { ...image, taskId: input.taskId }));
        if (input.request.issue) db.prepare("UPDATE forge_tasks SET issue_json = ? WHERE id = ?").run(JSON.stringify(input.request.issue), input.taskId);
        this.controls.create({
          taskId: input.taskId, startImmediately: false, objective: input.request.description ? `${input.request.title}\n\n${input.request.description}` : input.request.title, deliveryTarget: input.request.deliveryTarget,
          deliveryIntent: { repository: configuration.repository, headBranch: configuration.branch, baseBranch: configuration.baseBranch, baselineSha: configuration.baselineSha, pullRequestNumber: configuration.source?.kind === "pull_request" ? configuration.source.number : null },
          rootProfile: input.rootProfile, workerProfile: input.workerProfile, workflow: input.request.workflow, advisorProfiles: input.advisorProfiles,
        });
        const row = this.row(input.taskId);
        if (!row) throw new Error("Task insert did not persist");
        return { task: this.task(row), created: true };
      });
    } catch (error) {
      // The transaction owns these newly created opaque files, never a worktree.
      for (const artifact of written) void this.artifacts.removeArtifact(artifact).catch(() => undefined);
      throw error;
    }
  }

  task(row: TaskRow): Task {
    const blockedBy = taskDependencySummaries(this.database, row.id);
    const control = this.controls.get(row.id);
    const limitState = this.controls.taskLimitState(row.id);
    const images = this.database.authQuery(db => z.array(TaskImageSchema).parse(db.prepare("SELECT id AS artifactId, filename, mime_type AS mimeType, byte_size AS byteSize FROM forge_artifacts WHERE task_id = ? AND company_id = ? AND kind = 'task-image' ORDER BY created_at, id").all(row.id, row.company_id)));
    const artifacts = this.database.authQuery(db => z.array(TaskImageSchema).parse(db.prepare("SELECT id AS artifactId, filename, mime_type AS mimeType, byte_size AS byteSize FROM forge_artifacts WHERE task_id = ? AND company_id = ? AND kind LIKE 'delivery-%' ORDER BY created_at, id").all(row.id, row.company_id)));
    return TaskSchema.parse({
      id: row.id, companyId: row.company_id, projectId: row.project_id,
      issueKey: row.issue_code && row.issue_number ? `${row.issue_code}-${row.issue_number}` : null,
      issue: row.issue_json ? IssueAssociationSchema.parse(JSON.parse(row.issue_json)) : null,
      title: row.title, description: row.description, status: control.status, deliveryTarget: control.deliveryTarget,
      rootProfile: control.rootProfile, workerProfile: control.workerProfile, workflow: control.workflow, advisorProfiles: control.advisorProfiles, workflowState: publicWorkflowState(control.workflowState), dependsOn: blockedBy.map(prerequisite => prerequisite.id), configuration: JSON.parse(row.configuration_json),
      worktree: control.worktree, pullRequest: control.pullRequest,
      humanQuestion: control.humanQuestion && control.humanQuestionId ? control.limitPause
        ? { kind: "task_limit", id: control.humanQuestionId, text: control.humanQuestion, options: [], requiresCommandCleanup: false, pause: control.limitPause }
        : { kind: "question", id: control.humanQuestionId, text: control.humanQuestion, options: control.humanQuestionOptions ?? [], requiresCommandCleanup: control.recoveryTurnId !== null }
        : null,
      blockedBy,
      queue: this.database.authQuery(db => taskQueue(db, row.id, control.status)),
      limits: { ...limitState.limits, admittedTurns: limitState.admittedTurns },
      wakeAt: control.wakeAt, images, artifacts, createdAt: row.created_at, updatedAt: row.activity_updated_at, statusChangedAt: row.status_changed_at, archivedAt: row.archived_at,
    });
  }

  artifact(row: TaskRow, artifactId: string): StoredArtifact | null {
    const artifact = this.database.authQuery(db => db.prepare("SELECT id, company_id AS companyId, kind, filename, mime_type AS mimeType, byte_size AS byteSize, sha256, storage_path AS storagePath, created_at AS createdAt FROM forge_artifacts WHERE id = ? AND task_id = ? AND company_id = ?").get(artifactId, row.id, row.company_id));
    return artifact ? ArtifactRowSchema.parse(artifact) : null;
  }

  setArchived(taskId: string, archived: boolean): void {
    // Archiving clears a queue intent, so opening the task again never starts it by itself.
    this.database.authTransaction(db => db.prepare("UPDATE forge_tasks SET archived_at = ?, start_queued = CASE WHEN ? THEN 0 ELSE start_queued END, updated_at = ? WHERE id = ?").run(archived ? new Date().toISOString() : null, archived ? 1 : 0, new Date().toISOString(), taskId));
  }

  /** The caller resolves every field against the current task, so an edit writes one consistent snapshot of the editable settings. */
  updateDetails(taskId: string, details: {
    title: string; description: string; deliveryTarget: DeliveryTarget; runProjectTests: boolean; visualEvidence: VisualEvidence;
    workflow: WorkflowId; rootProfile: TaskProfile; workerProfile: TaskProfile; advisorProfiles: Partial<Record<AdvisorRole, TaskProfile>>;
  }): boolean {
    return this.database.authTransaction(db => {
      const time = new Date().toISOString();
      const updated = db.prepare("UPDATE forge_tasks SET title = ?, description = ?, configuration_json = json_set(configuration_json, '$.runProjectTests', json(?), '$.visualEvidence', ?), updated_at = ? WHERE id = ? AND archived_at IS NULL AND EXISTS (SELECT 1 FROM forge_task_controls WHERE task_id = forge_tasks.id AND status = 'backlog')")
        .run(details.title, details.description, details.runProjectTests ? "true" : "false", details.visualEvidence, time, taskId);
      if (updated.changes !== 1) return false;
      db.prepare("UPDATE forge_task_controls SET objective = (SELECT CASE WHEN description = '' THEN title ELSE title || char(10) || char(10) || description END FROM forge_tasks WHERE id = ?), delivery_target = ?, workflow = ?, root_profile_json = ?, worker_profile_json = ?, advisor_profiles_json = ?, updated_at = ? WHERE task_id = ?")
        .run(taskId, details.deliveryTarget, details.workflow, JSON.stringify(details.rootProfile), JSON.stringify(details.workerProfile), JSON.stringify(details.advisorProfiles), time, taskId);
      return true;
    });
  }

  rename(taskId: string, title: string): boolean {
    return this.database.authTransaction(db => {
      const time = new Date().toISOString();
      const updated = db.prepare("UPDATE forge_tasks SET title = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
        .run(title, time, taskId);
      if (updated.changes !== 1) return false;
      db.prepare("UPDATE forge_task_controls SET objective = (SELECT CASE WHEN description = '' THEN title ELSE title || char(10) || char(10) || description END FROM forge_tasks WHERE id = ?), updated_at = ? WHERE task_id = ? AND status = 'backlog'").run(taskId, time, taskId);
      return true;
    });
  }
}

export function newTaskId(): string { return `task_${randomUUID().replaceAll("-", "")}`; }
