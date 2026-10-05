import { expect, test } from "vitest";
import type { Task } from "../src/frontend/contracts/tasks.js";
import type { TaskActivity } from "../src/frontend/features/tasks/task-work.js";
import { workflowPosition } from "../src/frontend/features/tasks/workflow-position.js";
import { flowEdges, route } from "../src/frontend/features/tasks/workflow-flow.js";
import layouts from "../src/frontend/features/tasks/workflow-layouts.json" with { type: "json" };

const profile = { profileId: "profile", provider: "opencode", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
const base = {
  id: "task-1", companyId: "company-1", projectId: "project-1", issue: null, artifacts: [], issueKey: null, title: "Live", description: "", status: "active", deliveryTarget: "pull_request_draft",
  rootProfile: profile, workerProfile: profile, workflow: "refine_pull_request", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
  configuration: { repository: "meiji-industries/suplex", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: "live", baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
  worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [],
  dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-09-08T00:00:00.000Z", archivedAt: null,
} satisfies Task;
const task = (patch: Partial<Task> = {}): Task => ({ ...base, ...patch });

const session = (id: string, kind: "root" | "worker", advisorRole: TaskActivity["sessions"][number]["advisorRole"] = null) =>
  ({ id, kind, advisorRole, label: id, profileId: "profile", generation: 1, nativeSessionId: null, paneId: null, current: true, replacement: null, harness: "claude-code" }) as const;
const sessions = [session("root", "root"), session("worker", "worker"), session("rater", "worker", "rater"), session("reviewer", "worker", "reviewer"), session("plan-a", "worker", "planner_a"), session("plan-b", "worker", "planner_b")];
const turn = (sessionId: string, open = false) => ({ id: `${sessionId}-${Math.random()}`, sessionId, prompt: "", status: open ? "prompted" as const : "completed" as const, promptedAt: null, completedAt: null, result: open ? null : "{}", assignment: null });
const activity = (...turns: ReturnType<typeof turn>[]): TaskActivity => ({ sessions, turns, shellPaneId: null });
const agent = (role: "root" | "worker", status: "working" | "idle" | "waiting_human", advisorRole: "rater" | "planner_a" | "planner_b" | null = null) =>
  ({ id: `${role}-${advisorRole}`, role, advisorRole, paneId: null, status, statusChangedAt: null });

test("a task that has not started keeps the decorative loop", () => {
  expect(workflowPosition(task({ status: "backlog" }), activity(), [])).toBeNull();
  expect(workflowPosition(task({ status: "queued" }), activity(), [])).toBeNull();
});

test("refine: native agent status picks the station, turn history places the Coordinator", () => {
  const history = activity(turn("root"), turn("rater"), turn("root"), turn("worker"));
  expect(workflowPosition(task(), activity(turn("root", true)), [agent("root", "working")])).toEqual({ targets: ["source"], state: "working" });
  expect(workflowPosition(task(), history, [agent("worker", "working")])).toEqual({ targets: ["repair"], state: "working" });
  expect(workflowPosition(task(), activity(turn("root"), turn("rater")), [agent("root", "working")])).toEqual({ targets: ["coordinator"], state: "working" });
  // After a repair the Coordinator hands the work back for rating. The token waits on that route, not on a station.
  expect(workflowPosition(task(), history, [agent("root", "working")])).toEqual({ targets: ["repair-rater"], state: "working" });
  expect(workflowPosition(task(), history, [agent("root", "idle"), agent("worker", "idle")])).toEqual({ targets: ["repair"], state: "idle" });
});

test("a delegate that is active wins over a Coordinator turn that is still closing", () => {
  expect(workflowPosition(task(), activity(turn("root"), turn("rater", true)), [agent("root", "working"), agent("worker", "working", "rater")])).toEqual({ targets: ["rater"], state: "working" });
});

test("parallel planners occupy both plan stations", () => {
  const position = workflowPosition(task({ workflow: "competing_plans" }), activity(turn("root")), [agent("worker", "working", "planner_a"), agent("worker", "working", "planner_b")]);
  expect(position).toEqual({ targets: ["plan-a", "plan-b"], state: "working" });
  expect(workflowPosition(task({ workflow: "competing_plans" }), activity(turn("root"), turn("plan-a"), turn("plan-b")), [agent("root", "working")])?.targets).toEqual(["combine"]);
});

test("the shared Coordinator stations follow the last delegate", () => {
  const standard = task({ workflow: "standard" });
  expect(workflowPosition(standard, activity(turn("root", true)), [agent("root", "working")])?.targets).toEqual(["plan"]);
  expect(workflowPosition(standard, activity(turn("root"), turn("worker")), [agent("root", "working")])?.targets).toEqual(["review"]);
  const review = task({ workflow: "independent_review" });
  expect(workflowPosition(review, activity(turn("root"), turn("worker"), turn("root"), turn("reviewer")), [agent("root", "working")])?.targets).toEqual(["reviewer-build"]);
});

test("delivery waits and completion come from the task record", () => {
  expect(workflowPosition(task({ workflowState: { ...base.workflowState, deliveryWait: { headSha: "b", fingerprint: "f", since: "now", reason: "merge_queue" } } }), activity(), undefined)).toEqual({ targets: ["merge"], state: "waiting" });
  expect(workflowPosition(task({ status: "delivered", workflow: "standard" }), activity(), undefined)).toEqual({ targets: ["delivery"], state: "done" });
  expect(workflowPosition(task({ status: "waiting_human" }), activity(turn("root"), turn("rater")), [agent("root", "waiting_human")])).toEqual({ targets: ["coordinator"], state: "waiting" });
});

test("without the agents response, open turns stand in", () => {
  expect(workflowPosition(task(), activity(turn("root"), turn("worker", true)), undefined)).toEqual({ targets: ["repair"], state: "working" });
  expect(workflowPosition(task(), activity(), undefined)).toEqual({ targets: ["source"], state: "idle" });
});

test("every live target is reachable from the start along the diagram's routes", () => {
  const edges = flowEdges(layouts.refine_pull_request.wide, new Set());
  expect(route(edges, "source", "repair")?.map(edge => edge.id)).toEqual(["source-rater", "rater-coordinator", "coordinator-repair"]);
  expect(route(edges, "repair", "coordinator")?.map(edge => edge.id)).toEqual(["repair-rater", "rater-coordinator"]);
  expect(route(edges, "merge", "source")).toBeNull();
});
