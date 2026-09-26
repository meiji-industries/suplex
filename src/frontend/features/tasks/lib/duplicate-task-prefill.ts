import { listTasks } from "./task-api.js";
import { duplicateTitle } from "./duplicate-title.js";
import { TaskImageInputSchema, type Task, type TaskInput } from "../../../contracts/tasks.js";
import { issueTaskSource, type TaskSourceSummary } from "../task-source-picker.js";
import { readJsonUnchecked } from "../../../lib/api.js";

/** workflowId names a workflow record whose engine and defaults the dialog applies; workflow alone names an engine. */
export type NewTaskDraft = Omit<TaskInput, "idempotencyKey"> & { sourceSummary?: TaskSourceSummary; workflowId?: string };

export async function duplicateTaskDraft(task: Task): Promise<NewTaskDraft> {
  const tasks = await listTasks(task.companyId);
  const images = await Promise.all(task.images.map(async image => {
    const response = await fetch(`/api/tasks/${task.id}/images/${image.artifactId}`, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`The image ${image.filename} could not be copied.`);
    const blob = await response.blob();
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`The image ${image.filename} could not be copied.`));
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.readAsDataURL(blob);
    });
    return TaskImageInputSchema.parse({ filename: image.filename, mimeType: image.mimeType, base64 });
  }));
  const source = task.configuration.source;
  let sourceSummary = task.issue ? issueTaskSource(task.issue) : undefined;
  if (source && source.kind !== "issue") {
    const result = await readJsonUnchecked<{ sources: TaskSourceSummary[] }>(`/api/projects/${task.projectId}/task-sources?kind=${source.kind}`);
    sourceSummary = result.sources.find(item => source.kind === "branch" ? item.kind === "branch" && item.branch === source.branch : item.kind === source.kind && item.number === source.number);
    if (!sourceSummary) throw new Error("The original task source is not available. Select a source in a new task.");
  }
  return {
    ...taskDraftFields(task), title: duplicateTitle(task.title, new Set(tasks.filter(candidate => candidate.projectId === task.projectId).map(candidate => candidate.title))),
    startImmediately: false, images, ...(sourceSummary ? { ...(source && source.kind !== "issue" ? { source } : {}), sourceSummary } : {}),
  };
}

/** The settings a Task carries into a draft. Synchronous: the edit dialog needs no images and no source lookup. */
export function taskDraftFields(task: Task): Omit<NewTaskDraft, "title" | "idempotencyKey"> {
  return {
    projectId: task.projectId, description: task.description,
    ...(task.issue ? { issue: task.issue } : {}),
    rootProfileId: task.rootProfile.profileId, workerProfileId: task.workerProfile.profileId,
    deliveryTarget: task.deliveryTarget, runProjectTests: task.configuration.runProjectTests, visualEvidence: task.configuration.visualEvidence,
    workflow: task.workflow, advisorProfileIds: Object.fromEntries(Object.entries(task.advisorProfiles).map(([role, profile]) => [role, profile.profileId])),
  };
}

/** The draft the Edit task dialog opens with; the task's own source keeps the repair workflow rules satisfied. */
export function editTaskDraft(task: Task): NewTaskDraft {
  return { ...taskDraftFields(task), title: task.title, ...(task.configuration.source ? { source: task.configuration.source } : {}) };
}
