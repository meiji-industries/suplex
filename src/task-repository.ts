import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactStore, StoredArtifact } from "./artifacts.js";
import type { ForgeDatabase } from "./database.js";
import { TaskControlStore } from "./root-session-store.js";
import { TaskConfigurationSchema, TaskImageSchema, TaskSchema, type Task, type TaskConfiguration, type TaskInput, type TaskRequest } from "./task-contracts.js";
import type { TaskProfile } from "./task-control.js";

export type TaskCreator = { kind: "user"; id: string } | { kind: "agent"; id: string };
const RowSchema = z.object({
  id: z.string(), company_id: z.string(), project_id: z.string(), issue_number: z.number().nullable(), issue_code: z.string().nullable(),
  title: z.string(), description: z.string(), configuration_json: z.string(), idempotency_key: z.string(), request_hash: z.string(),
  creator_user_id: z.string().nullable(), creator_agent_id: z.string().nullable(), created_at: z.string(), updated_at: z.string(), activity_updated_at: z.string(), archived_at: z.string().nullable(),
});
export type TaskRow = z.infer<typeof RowSchema>;
const ArtifactRowSchema = z.object({
  id: z.string(), companyId: z.string(), kind: z.string(), filename: z.string(), mimeType: z.string(), byteSize: z.number(),
  sha256: z.string(), storagePath: z.string(), createdAt: z.string(),
});
const select = "SELECT t.*, MAX(t.updated_at, COALESCE(control.updated_at, t.updated_at)) AS activity_updated_at, c.issue_code FROM forge_tasks t JOIN forge_companies c ON c.id = t.company_id LEFT JOIN forge_task_controls control ON control.task_id = t.id";

export class TaskConflict extends Error {}

export function taskRequestHash(input: TaskInput, creator: TaskCreator): string {
  return createHash("sha256").update(JSON.stringify({ input, creator })).digest("hex");
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
    return this.database.authQuery(db => z.array(RowSchema).parse(db.prepare(`${select} ORDER BY activity_updated_at DESC, t.id`).all()));
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
    requestHash: string; configuration: TaskConfiguration; rootProfile: TaskProfile; workerProfile: TaskProfile;
    images: Array<{ filename: string; mimeType: string; bytes: Buffer }>;
  }): { task: Task; created: boolean } {
    const written: StoredArtifact[] = [];
    try {
      return this.database.authTransaction(db => {
        const existing = this.existing(input.companyId, input.request.idempotencyKey, input.requestHash, input.creator);
        if (existing) return { task: this.task(existing), created: false };
        const time = new Date().toISOString();
        const configuration = TaskConfigurationSchema.parse(input.configuration);
        db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, description, configuration_json, idempotency_key, request_hash, creator_user_id, creator_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(input.taskId, input.companyId, input.request.projectId, input.request.title, input.request.description, JSON.stringify(configuration), input.request.idempotencyKey, input.requestHash, input.creator.kind === "user" ? input.creator.id : null, input.creator.kind === "agent" ? input.creator.id : null, time, time);
        for (const image of input.images) written.push(this.artifacts.putArtifactSync(db, input.companyId, "task-image", { ...image, taskId: input.taskId }));
        this.controls.create({
          taskId: input.taskId, startImmediately: input.request.startImmediately, objective: `${input.request.title}\n\n${input.request.description}`, deliveryTarget: input.request.deliveryTarget,
          deliveryIntent: { repository: configuration.repository, headBranch: configuration.branch, baseBranch: configuration.baseBranch, baselineSha: configuration.baselineSha, pullRequestNumber: configuration.source?.kind === "pull_request" ? configuration.source.number : null },
          rootProfile: input.rootProfile, workerProfile: input.workerProfile,
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
    const control = this.controls.get(row.id);
    const images = this.database.authQuery(db => z.array(TaskImageSchema).parse(db.prepare("SELECT id AS artifactId, filename, mime_type AS mimeType, byte_size AS byteSize FROM forge_artifacts WHERE task_id = ? AND company_id = ? AND kind = 'task-image' ORDER BY created_at, id").all(row.id, row.company_id)));
    return TaskSchema.parse({
      id: row.id, companyId: row.company_id, projectId: row.project_id,
      issueKey: row.issue_code && row.issue_number ? `${row.issue_code}-${row.issue_number}` : null,
      title: row.title, description: row.description, status: control.status, deliveryTarget: control.deliveryTarget,
      rootProfile: control.rootProfile, workerProfile: control.workerProfile, configuration: JSON.parse(row.configuration_json),
      worktree: control.worktree, pullRequest: control.pullRequest,
      humanQuestion: control.humanQuestion && control.humanQuestionId ? { id: control.humanQuestionId, text: control.humanQuestion, requiresCommandCleanup: control.recoveryTurnId !== null } : null,
      wakeAt: control.wakeAt, images, createdAt: row.created_at, updatedAt: row.activity_updated_at, archivedAt: row.archived_at,
    });
  }

  artifact(row: TaskRow, artifactId: string): StoredArtifact | null {
    const artifact = this.database.authQuery(db => db.prepare("SELECT id, company_id AS companyId, kind, filename, mime_type AS mimeType, byte_size AS byteSize, sha256, storage_path AS storagePath, created_at AS createdAt FROM forge_artifacts WHERE id = ? AND task_id = ? AND company_id = ?").get(artifactId, row.id, row.company_id));
    return artifact ? ArtifactRowSchema.parse(artifact) : null;
  }

  setArchived(taskId: string, archived: boolean): void {
    this.database.authTransaction(db => db.prepare("UPDATE forge_tasks SET archived_at = ?, updated_at = ? WHERE id = ?").run(archived ? new Date().toISOString() : null, new Date().toISOString(), taskId));
  }

  updateDetails(taskId: string, details: { title?: string | undefined; description?: string | undefined }): boolean {
    return this.database.authTransaction(db => {
      const time = new Date().toISOString();
      const updated = db.prepare("UPDATE forge_tasks SET title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ? WHERE id = ? AND archived_at IS NULL AND EXISTS (SELECT 1 FROM forge_task_controls WHERE task_id = forge_tasks.id AND status = 'backlog')")
        .run(details.title ?? null, details.description ?? null, time, taskId);
      if (updated.changes !== 1) return false;
      db.prepare("UPDATE forge_task_controls SET objective = (SELECT title || char(10) || char(10) || description FROM forge_tasks WHERE id = ?), updated_at = ? WHERE task_id = ?").run(taskId, time, taskId);
      return true;
    });
  }
}

export function newTaskId(): string { return `task_${randomUUID().replaceAll("-", "")}`; }
