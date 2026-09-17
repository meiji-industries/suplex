import { z } from "zod";
import { dirname, join } from "node:path";
import { ArtifactStore, type StoredArtifact } from "../platform/artifacts.js";
import { MAX_TASK_IMAGES } from "./limits/attachment-limits.js";
import type { ForgeDatabase } from "../platform/database.js";
import { IssueTracker } from "../integrations/issue-tracker.js";
import type { TrackerConnection } from "../projects/integration-configuration.js";
import { TaskConfigurationSchema, type TaskConfiguration } from "./contracts.js";
import { IssueAssociationSchema, IssueContextSchema } from "./issue-association.js";

export function taskTracker(configuration: Pick<TaskConfiguration, "repository" | "integration">): TrackerConnection {
  if (configuration.integration?.tracker) return configuration.integration.tracker;
  if (configuration.integration) throw new Error("Configure an issue tracker for this project");
  return { kind: "github", repository: configuration.repository };
}

export function hasStartedNativeWork(database: ForgeDatabase, taskId: string): boolean {
  return Boolean(database.authQuery(db => db.prepare("SELECT 1 FROM forge_task_sessions WHERE task_id = ? AND native_session_id IS NOT NULL UNION ALL SELECT 1 FROM forge_task_turns WHERE task_id = ? AND status IN ('prompted', 'unknown', 'completed') LIMIT 1").get(taskId, taskId)));
}

export async function prepareIssueContext(database: ForgeDatabase, taskId: string, tracker: (connection: TrackerConnection) => Pick<IssueTracker, "read"> & Partial<Pick<IssueTracker, "images">> = connection => new IssueTracker(connection), artifactRoot = join(dirname(database.filename()), "artifacts")): Promise<void> {
  const row = database.authQuery(db => z.object({ configuration_json: z.string(), issue_json: z.string().nullable(), issue_context_json: z.string().nullable() }).parse(db.prepare("SELECT configuration_json, issue_json, issue_context_json FROM forge_tasks WHERE id = ?").get(taskId)));
  if (!row.issue_json || row.issue_context_json || hasStartedNativeWork(database, taskId)) return;
  const configuration = TaskConfigurationSchema.parse(JSON.parse(row.configuration_json));
  const client = tracker(taskTracker(configuration));
  const context = IssueContextSchema.parse(await client.read(IssueAssociationSchema.parse(JSON.parse(row.issue_json))));
  const imageCount = () => database.authQuery(db => z.object({ count: z.number() }).parse(db.prepare("SELECT COUNT(*) AS count FROM forge_artifacts WHERE task_id = ? AND kind = 'task-image'").get(taskId)).count);
  const intake = await client.images?.(context.issue, MAX_TASK_IMAGES - imageCount());
  const artifacts = new ArtifactStore(artifactRoot);
  const written: StoredArtifact[] = [];
  try { database.authImmediateTransaction(db => {
    if (hasStartedNativeWork(database, taskId)) return;
    const current = z.object({ company_id: z.string(), issue_json: z.string().nullable(), issue_context_json: z.string().nullable() }).parse(db.prepare("SELECT company_id, issue_json, issue_context_json FROM forge_tasks WHERE id = ?").get(taskId));
    if (current.issue_json !== row.issue_json) throw new Error("The issue changed before context capture. Retry preparation.");
    if (current.issue_context_json) return;
    const available = Math.max(0, MAX_TASK_IMAGES - imageCount());
    for (const image of intake?.images.slice(0, available) ?? []) {
      const artifact = artifacts.putArtifactSync(db, current.company_id, "task-image", { ...image, taskId });
      written.push(artifact);
      context.text += `\n\nIssue image: ${artifact.filename}, task artifact ${artifact.id}. Use the task image reader to inspect it.`;
    }
    if (intake?.notes.length) context.text += `\n\n${intake.notes.join("\n")}`;
    const updated = db.prepare("UPDATE forge_tasks SET issue_context_json = COALESCE(issue_context_json, ?) WHERE id = ? AND issue_json = ?").run(JSON.stringify(context), taskId, row.issue_json);
    if (!updated.changes) throw new Error("The issue changed before context capture. Retry preparation.");
  }); } catch (error) {
    await Promise.all(written.map(artifact => artifacts.removeArtifact(artifact)));
    throw error;
  }
}
