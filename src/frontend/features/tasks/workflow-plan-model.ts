import { REPAIR_RATING_TARGET, type AdvisorRole } from "../../../coordination/workflows.js";
import type { Task } from "../../../tasks/contracts.js";

export type WorkflowStation = {
  id: string;
  label: string;
  role?: "coordinator" | "worker" | AdvisorRole;
  icon?: "target" | "delivery" | "merge";
  note?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
};

export type WorkflowEdge = {
  from: string;
  to: string;
  condition?: string;
  pathKind: "direct" | "branch" | "return";
  path: string;
  label?: { x: number; y: number; width?: number };
};

export type WorkflowTopology = { height: number; nodes: WorkflowStation[]; edges: WorkflowEdge[] };

const center = 100;
const left = 12;
const right = 200;
const stationHeight = 48;
const branchWidth = 178;
const node = (id: string, label: string, y: number, options: Omit<WorkflowStation, "id" | "label" | "x" | "y"> & { x?: number } = {}): WorkflowStation => ({ id, label, x: options.x ?? center, y, ...options });
const down = (from: string, to: string, y: number): WorkflowEdge => ({ from, to, pathKind: "direct", path: `M195 ${y + stationHeight}V${y + 64}` });

export function workflowTopology(workflow: Task["workflow"], targetLabel: string): WorkflowTopology {
  const target = (y: number) => node("target", targetLabel, y, { icon: "target", height: stationHeight });
  switch (workflow) {
    case "standard": return { height: 248, nodes: [node("plan", "Coordinator plan", 8, { role: "coordinator", height: stationHeight }), node("build", "Worker build and checks", 72, { role: "worker", height: stationHeight }), node("review", "Coordinator review", 136, { role: "coordinator", height: stationHeight }), target(200)], edges: [down("plan", "build", 8), down("build", "review", 72), down("review", "target", 136)] };
    case "direct_build": return { height: 312, nodes: [node("instructions", "Your instructions", 8, { icon: "target", height: stationHeight }), node("delegate", "Coordinator delegation", 72, { role: "coordinator", height: stationHeight }), node("build", "Worker approach, build and checks", 136, { role: "worker", height: stationHeight }), node("review", "Coordinator review", 200, { role: "coordinator", height: stationHeight }), target(264)], edges: [down("instructions", "delegate", 8), down("delegate", "build", 72), down("build", "review", 136), down("review", "target", 200)] };
    case "independent_review": return { height: 388, nodes: [node("plan", "Coordinator plan", 8, { role: "coordinator", height: stationHeight }), node("build", "Worker build and checks", 72, { role: "worker", height: stationHeight }), node("review", "Coordinator review", 136, { role: "coordinator", height: stationHeight }), node("reviewer", "Reviewer", 200, { role: "reviewer", height: stationHeight }), node("target", targetLabel, 264, { icon: "target", x: right, width: branchWidth, height: stationHeight }), node("repair", "Worker repair and checks", 264, { role: "worker", note: "Blocking findings", x: left, width: branchWidth, height: 60 }), node("inspection", "Coordinator inspection", 340, { role: "coordinator", x: left, width: branchWidth, height: stationHeight })], edges: [down("plan", "build", 8), down("build", "review", 72), down("review", "reviewer", 136), { from: "reviewer", to: "target", condition: "Approve", pathKind: "branch", path: "M290 224H289V264", label: { x: 294, y: 232 } }, { from: "reviewer", to: "repair", condition: "Blocking findings", pathKind: "branch", path: "M100 224H101V264", label: { x: 0, y: 232, width: 75 } }, { from: "repair", to: "inspection", pathKind: "direct", path: "M101 324V340" }, { from: "inspection", to: "reviewer", condition: "Fresh review", pathKind: "return", path: "M12 364H4V224H100", label: { x: 0, y: 202, width: 75 } }] };
    case "competing_plans": return { height: 376, nodes: [node("objective", "Same objective", 8, { icon: "target", height: stationHeight }), node("plan-a", "Plan A", 72, { role: "planner_a", x: left, width: branchWidth, height: stationHeight }), node("plan-b", "Plan B", 72, { role: "planner_b", x: right, width: branchWidth, height: stationHeight }), node("combine", "Coordinator combines", 136, { role: "coordinator", height: stationHeight }), node("build", "Worker build and checks", 200, { role: "worker", height: stationHeight }), node("review", "Coordinator review", 264, { role: "coordinator", height: stationHeight }), target(328)], edges: [{ from: "objective", to: "plan-a", pathKind: "branch", path: "M160 56V64H101V72" }, { from: "objective", to: "plan-b", pathKind: "branch", path: "M230 56V64H289V72" }, { from: "plan-a", to: "combine", pathKind: "branch", path: "M101 120V128H160V136" }, { from: "plan-b", to: "combine", pathKind: "branch", path: "M289 120V128H230V136" }, down("combine", "build", 136), down("build", "review", 200), down("review", "target", 264)] };
    case "refine_pull_request": return { height: 408, nodes: [node("pull-request", "Existing pull request", 8, { icon: "delivery", height: stationHeight }), node("rater", "Rater", 72, { role: "rater", height: stationHeight }), node("repair", "Worker repair and checks", 184, { role: "worker", x: left, width: branchWidth, height: stationHeight }), node("push", "Forge push and CI", 184, { icon: "delivery", x: right, width: branchWidth, height: stationHeight }), node("merge", "GitHub ready", 296, { icon: "merge", x: right, width: branchWidth, height: stationHeight }), node("done", "Forge merge", 360, { icon: "merge", x: right, width: branchWidth, height: stationHeight })], edges: [down("pull-request", "rater", 8), { from: "rater", to: "push", condition: `${REPAIR_RATING_TARGET}/10+, no blockers, verified checks`, pathKind: "branch", path: "M290 120V184", label: { x: 300, y: 124, width: 75 } }, { from: "rater", to: "repair", condition: "Otherwise", pathKind: "branch", path: "M100 120V184", label: { x: 0, y: 124, width: 75 } }, { from: "repair", to: "rater", condition: "Fresh rating", pathKind: "return", path: "M12 232H4V96H100", label: { x: 0, y: 236, width: 70 } }, { from: "push", to: "rater", condition: "CI fails", pathKind: "return", path: "M378 232V248H386V96H290", label: { x: 300, y: 236 } }, { from: "push", to: "merge", condition: "CI passes", pathKind: "direct", path: "M289 232V296", label: { x: 298, y: 264 } }, { from: "merge", to: "done", pathKind: "direct", path: "M289 344V360" }] };
  }
}
