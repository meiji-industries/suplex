import type { z } from "zod";
import type { Task } from "../../contracts/tasks.js";
import { ReviewerResultSchema, type AdvisorRole } from "../../contracts/advisor-reports.js";
import type { TaskActivityResponse } from "../../contracts/generated/TaskActivityResponse.js";
import type { TaskAgentsResponseSchema } from "../../contracts/task-responses.js";

export type LiveState = "working" | "waiting" | "idle" | "done";
/** Where a running task is on its workflow illustration: station ids, or one route id the token holds partway along. */
export type WorkflowPosition = { targets: string[]; state: LiveState };
type Agents = z.infer<typeof TaskAgentsResponseSchema>["agents"];
type Actor = { kind: "root" | "worker"; advisorRole?: AdvisorRole | null | undefined };

const advisorStations: Record<AdvisorRole, string> = { planner_a: "plan-a", planner_b: "plan-b", reviewer: "reviewer", rater: "rater" };

function station(task: Task, actor: Actor, previous: Actor | undefined): string {
  if (actor.advisorRole) return advisorStations[actor.advisorRole];
  if (actor.kind === "worker") return task.workflow === "refine_pull_request" ? "repair" : "build";
  // The diagram has no Coordinator station after some delegates, so the token waits on the route the Coordinator decides next.
  const after = previous?.advisorRole ?? previous?.kind;
  if (task.workflow === "refine_pull_request") return after === "rater" ? "coordinator" : after === "worker" ? "repair-rater" : "source";
  if (task.workflow === "competing_plans") return after === "worker" ? "review" : after === "planner_a" || after === "planner_b" ? "combine" : "objective";
  if (task.workflow === "independent_review" && after === "reviewer") {
    const review = task.workflowState.reviews.findLast(review => review.role === "reviewer");
    return ReviewerResultSchema.safeParse(review?.result).data?.approved ? "reviewer-delivery" : "reviewer-build";
  }
  return after === "worker" ? "review" : "plan";
}

const agentStates: Partial<Record<Agents[number]["status"], LiveState>> = { working: "working", retrying: "working", queued: "waiting", waiting_human: "waiting" };

/**
 * Display-only: agent status comes from the native runtime; turn history picks among stations that share a role.
 * Without the agents response, open turns stand in, so the illustration degrades instead of failing.
 */
export function workflowPosition(task: Task, activity: TaskActivityResponse, agents: Agents | undefined): WorkflowPosition | null {
  if (task.status === "backlog" || task.status === "queued") return null;
  const terminal = task.workflow === "refine_pull_request" ? "merge" : "delivery";
  if (task.status === "delivered" || task.workflowState.completion) return { targets: [terminal], state: "done" };
  if (task.status === "cancelled") return { targets: [], state: "idle" };
  if (task.workflowState.deliveryWait) return { targets: [terminal], state: "waiting" };
  const sessions = new Map(activity.sessions.map(session => [session.id, session]));
  const turnActors = activity.turns.flatMap(turn => {
    const session = sessions.get(turn.sessionId);
    return session ? [{ turn, actor: { kind: session.kind, advisorRole: session.advisorRole } }] : [];
  });
  const previous = turnActors.findLast(({ actor }) => actor.kind !== "root")?.actor;
  const at = (actor: Actor) => station(task, actor, previous);
  if (task.status === "waiting_human") {
    const approval = task.workflowState.planApproval;
    return { targets: [approval && approval.questionId === task.humanQuestion?.id ? "approval" : at({ kind: "root" })], state: "waiting" };
  }
  const live = agents
    ? agents.flatMap(agent => agentStates[agent.status] ? [{ actor: { kind: agent.role, advisorRole: agent.advisorRole }, state: agentStates[agent.status]! }] : [])
    : turnActors.filter(({ turn }) => !turn.result && (turn.status === "prompted" || turn.status === "pending_prompt"))
      .map(({ turn, actor }) => ({ actor, state: turn.status === "prompted" ? "working" as const : "waiting" as const }));
  // Delegation is serial, so a delegate that is active is newer than a Coordinator turn that is still closing.
  const delegates = live.filter(({ actor }) => actor.kind !== "root");
  const current = delegates.length ? delegates : live;
  if (current.length) return { targets: [...new Set(current.map(({ actor }) => at(actor)))], state: current.some(({ state }) => state === "working") ? "working" : "waiting" };
  return { targets: [at(turnActors.at(-1)?.actor ?? { kind: "root" })], state: "idle" };
}
