import type { AdvisorRole } from "../../contracts/advisor-reports.js";
import type { WorkflowId } from "../../contracts/workflows.js";

export interface WorkflowDefinition {
  id: WorkflowId;
  name: string;
  description: string;
  advisorRoles: AdvisorRole[];
  agents: string;
  delivery: string;
  steps: string[];
}

export const WORKFLOWS: readonly WorkflowDefinition[] = [
  { id: "standard", name: "Standard", description: "Coordinator plans, Worker builds, and Coordinator reviews the result.", advisorRoles: [], agents: "Coordinator, Worker", delivery: "Selected target",
    steps: ["Coordinator reads the source and writes the plan and acceptance criteria.", "Worker builds the plan and runs the checks.", "Coordinator reviews the changes and the check evidence.", "Coordinator requests the selected delivery target."] },
  { id: "direct_build", name: "Direct build", description: "Worker builds from your instructions. Coordinator reviews the result before delivery.", advisorRoles: [], agents: "Coordinator, Worker", delivery: "Selected target",
    steps: ["Coordinator observes the source and delegates Worker with your instructions.", "Worker chooses the approach, builds, and runs the checks.", "Coordinator reviews the changes and the check evidence.", "Coordinator requests the selected delivery target."] },
  { id: "independent_review", name: "Second opinion", description: "A separate Reviewer checks the changes before Coordinator delivers the result.", advisorRoles: ["reviewer"], agents: "Coordinator, Worker, Reviewer", delivery: "Selected target",
    steps: ["Coordinator writes the plan and acceptance criteria.", "Worker builds the plan and runs the checks.", "Coordinator reviews the changes and the check evidence.", "Reviewer inspects the complete change independently.", "Worker repairs every blocking finding, then Reviewer makes a new assessment of the current change.", "Coordinator requests the selected delivery target after Reviewer approves."] },
  { id: "competing_plans", name: "Combined planning", description: "Two agents write separate plans. Coordinator combines them and assigns the build to Worker.", advisorRoles: ["planner_a", "planner_b"], agents: "Coordinator, Worker, Plan A, Plan B", delivery: "Selected target",
    steps: ["Plan A writes an implementation plan from the objective.", "Plan B writes a separate plan from the same objective.", "Coordinator combines both plans into one plan with acceptance criteria.", "Worker builds the combined plan and runs the checks.", "Coordinator reviews the changes and requests the selected delivery target."] },
  { id: "refine_pull_request", name: "Pull request repair", description: "Rater reviews an existing pull request. Worker applies repairs until it scores at least 9/10. Suplex then pushes and merges it.", advisorRoles: ["rater"], agents: "Coordinator, Worker, Rater", delivery: "Merged pull request",
    steps: ["Rater rates the existing pull request from 1 to 10 and writes a repair plan.", "Worker applies the repair plan and runs the checks.", "Rater makes a new assessment of the current result. Suplex repeats until the rating is at least 9/10.", "Suplex pushes the branch and observes the checks.", "If CI fails, Rater reviews the failure and Worker repairs it.", "Suplex merges the same pull request after GitHub reports it ready."] },
];

export function workflowDefinition(workflow: WorkflowId): WorkflowDefinition {
  return WORKFLOWS.find(definition => definition.id === workflow)!;
}

export const ADVISOR_LABELS: Record<AdvisorRole, string> = { reviewer: "Reviewer", planner_a: "Plan A", planner_b: "Plan B", rater: "Rater" };

export function roleLabel(session: { kind: "root" | "worker"; advisorRole?: AdvisorRole | null | undefined }): string {
  if (session.kind === "root") return "Coordinator";
  return session.advisorRole ? ADVISOR_LABELS[session.advisorRole] : "Worker";
}

export function latestReview<T extends { role: string }>(reviews: T[], role: "reviewer" | "rater"): T | undefined {
  return reviews.filter(record => record.role === role).at(-1);
}
