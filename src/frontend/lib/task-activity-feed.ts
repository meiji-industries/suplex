import { phaseLabel, type IssuePhase } from "../../issue-phases.js";

export type ActivityRole = "planner" | "builder" | "reviewer" | "integrator" | "you" | "forge";

type ActivityEntry = {
  eventType: string;
  revision?: number;
  metadata: Record<string, string | number | boolean>;
  actor?: { kind?: string | undefined; id: string } | undefined;
};

export type ActivityFeedRow = {
  id: string;
  at: string;
  role: ActivityRole;
  text: string;
  revision?: number;
  link?: { href: string; label: string };
  count?: number;
  live?: boolean;
  automatic?: boolean;
  command?: {
    command: string;
    cwd?: string | undefined;
    exitCode: number | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    at: string;
    entries?: Array<{ stream: "stdout" | "stderr"; text: string }> | undefined;
  };
  commands?: Array<{
    id: string;
    command: string;
    cwd?: string | undefined;
    exitCode: number | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    at: string;
    entries?: Array<{ stream: "stdout" | "stderr"; text: string }> | undefined;
  }>;
};

export function activityRole(entry: ActivityEntry): ActivityRole {
  if (entry.eventType === "system_action") return "forge";
  if (entry.eventType.startsWith("github_pr_")) return "forge";
  if (entry.actor && entry.actor.kind !== "agent") return "you";
  if (entry.eventType.includes("planning") || entry.eventType.includes("plan")) return "planner";
  if (entry.eventType.includes("review") || entry.eventType === "phase_repair_required") return "reviewer";
  if (entry.eventType.includes("development") || entry.eventType.includes("repair")) return "builder";
  return "integrator";
}

export function activityRoleLabel(role: ActivityRole): string {
  return role === "you" ? "You" : `${role[0]!.toUpperCase()}${role.slice(1)}`;
}

export function isAutomaticActivity(entry: ActivityEntry, role: ActivityRole): boolean {
  if (role !== "you" || entry.eventType !== "member_action") return false;
  if (entry.metadata.automatic === true || entry.metadata.automatic === "true") return true;
  return entry.metadata.command === "start_planning" && entry.revision === 1;
}

function commandSentence(command: string): string {
  switch (command) {
    case "approve_plan": return "You approved the plan";
    case "request_plan_revision": return "You asked for plan changes";
    case "reject_plan": return "You rejected the plan";
    case "retry_development": return "You retried development";
    case "cancel_development":
    case "cancel_issue": return "You cancelled";
    case "rescue_task": return "You rescued the task";
    default: return command ? `You ran ${command.replaceAll("_", "-")}` : "You took an action";
  }
}

export function activitySentence(entry: ActivityEntry, role: ActivityRole): string {
  const subject = activityRoleLabel(role);
  const pullRequest = typeof entry.metadata.pullRequestNumber === "number" ? `#${entry.metadata.pullRequestNumber}` : "this pull request";
  const login = typeof entry.metadata.githubLogin === "string" && entry.metadata.githubLogin ? ` by ${entry.metadata.githubLogin}` : "";
  if (entry.eventType === "github_pr_ready") return `PR ${pullRequest} was marked ready on GitHub${login}`;
  if (entry.eventType === "github_pr_merged") return `PR ${pullRequest} was merged on GitHub${login}`;
  if (entry.eventType === "github_pr_closed") return `PR ${pullRequest} was closed on GitHub${login}`;
  if (entry.eventType === "github_pr_draft") return `PR ${pullRequest} was converted to draft on GitHub${login}`;
  if (entry.eventType === "github_pr_auto_merge_enabled") return `Auto-merge enabled on ${pullRequest}`;
  if (entry.eventType === "task_created") return `${subject} created this task`;
  if (entry.eventType === "system_action") return "Forge resynced the task";
  if (entry.eventType === "member_action") return commandSentence(String(entry.metadata.command ?? entry.metadata.action ?? ""));
  if (entry.eventType === "planner_note") return `You told the Planner: ${String(entry.metadata.note ?? "")}`;
  if (entry.eventType === "planner_note_revised") return `Planner revised the plan: ${String(entry.metadata.summary ?? "Plan updated")}`;
  if (entry.eventType === "planning_started") {
    if (entry.metadata.planningStage === "completed") return "Planner finished the plan";
    if (entry.metadata.planningStage === "queued") return "Planner is waiting to start";
    return "Planner started the plan";
  }
  if (entry.eventType === "phase_development") return "Builder started work";
  if (entry.eventType === "phase_ci_waiting") return "Integrator is waiting for CI";
  if (entry.eventType === "phase_delivery_reviewed") return "Reviewer approved the delivery";
  if (entry.eventType === "phase_repair_required") return "Reviewer asked for fixes";
  if (entry.eventType === "phase_done") return "Integrator completed the task";
  if (entry.eventType.startsWith("phase_")) return `${subject} moved the task to ${phaseLabel(entry.eventType.slice("phase_".length) as IssuePhase)}`;
  return `${subject} ${entry.eventType.replaceAll("_", " ")}`;
}

export function compactActivityRows(rows: ActivityFeedRow[]): ActivityFeedRow[] {
  return rows.slice().sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).reduce<ActivityFeedRow[]>((compact, row) => {
    const previous = compact.at(-1);
    if (row.live && previous?.live) {
      previous.at = row.at;
      previous.text = row.text;
      previous.role = row.role;
      return compact;
    }
    if (previous && !row.live && !previous.live && previous.role !== "planner" && previous.role === row.role && previous.text === row.text) {
      previous.at = row.at;
      previous.count = (previous.count ?? 1) + (row.count ?? 1);
      return compact;
    }
    compact.push(row);
    return compact;
  }, []);
}
