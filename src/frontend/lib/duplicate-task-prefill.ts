import { duplicateTitle } from "../../duplicate-title.js";
import type { TaskSourceSelector } from "../components/app/task-source-picker.js";
import type { ApiTask } from "./view-shared.js";

export function duplicateTaskDraft(task: ApiTask, usedTitles: Set<string>): {
  projectId: string;
  title: string;
  description: string;
  roleAgents: ApiTask["roleAgents"];
  autoApprovePlan: boolean;
  deliveryTarget: ApiTask["deliveryTarget"];
  runProjectTests: boolean;
  visualEvidence: ApiTask["executionControls"]["visualEvidence"];
  supplementalReview: boolean;
  source: TaskSourceSelector | undefined;
} {
  const source = task.source?.kind === "pull_request"
    ? { kind: "pull_request" as const, number: task.source.number }
    : task.source?.kind === "branch"
      ? { kind: "branch" as const, branch: task.source.branch }
      : undefined;
  return {
    projectId: task.projectId,
    title: duplicateTitle(task.title, usedTitles),
    description: task.description,
    roleAgents: { ...task.roleAgents },
    autoApprovePlan: task.autoApprovePlan,
    deliveryTarget: task.deliveryTarget,
    runProjectTests: task.executionControls.runProjectTests,
    visualEvidence: task.executionControls.visualEvidence,
    supplementalReview: task.executionControls.supplementalReview,
    source,
  };
}
