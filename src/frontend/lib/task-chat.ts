import { activitySentence, activityRole, withoutLegacyMaterialitySummary } from "./task-activity-feed.js";
import type { ApiTask } from "./view-shared.js";

export type ChatActor = { name: string; avatarSeed: string };
export type ChatEvent = { id: string; at: string; kind: string; text: string; files?: string[]; exitCode?: number | null };
export type ChatItem =
  | { kind: "member"; id: string; at: string; actor: ChatActor; markdown: string }
  | { kind: "agent_turn"; id: string; role: ApiTask["agentInvocations"][number]["role"]; agent: ChatActor; startedAt: string; finishedAt: string | null; status: "running" | "completed" | "failed" | "blocked"; intro?: string; events: ChatEvent[]; summary?: string; stats?: { filesChanged: number; additions: number; deletions: number } }
  | { kind: "pull_request"; id: string; at: string }
  | { kind: "system"; id: string; at: string; text: string; tone: "muted" | "warning" | "success" };

const terminalStatuses = new Set(["completed", "failed", "blocked"]);

function actorFor(entry: ApiTask["activity"][number] | undefined): ChatActor {
  return { name: entry?.actor?.displayName ?? "You", avatarSeed: entry?.actor?.avatarSeed ?? entry?.actor?.id ?? "member" };
}

function eventFiles(summary: string): string[] | undefined {
  const files = [...summary.matchAll(/(?:`|\b)([\w./-]+\.[\w-]+)(?:`|\b)/g)].map((match) => match[1]!);
  return files.length ? [...new Set(files)] : undefined;
}

export function chatEventFromDeveloperEvent(event: { eventId: string; occurredAt: string; kind: string; summary: string; exitCode: number | null }): ChatEvent {
  const files = eventFiles(event.summary);
  return { id: event.eventId, at: event.occurredAt, kind: event.kind, text: event.summary, ...(files ? { files } : {}), exitCode: event.exitCode };
}

function systemItem(entry: ApiTask["activity"][number]): ChatItem | undefined {
  const summary = String(entry.metadata.summary ?? entry.metadata.blockerSummary ?? "");
  const text = entry.eventType === "phase_plan_approved" || entry.eventType === "plan_approved" ? "Plan approved automatically"
    : entry.eventType === "phase_delivery_reviewed" ? "Delivery reviewed"
      : entry.eventType === "phase_ci_passed" || entry.eventType === "ci_passed" ? "CI passed"
        : entry.eventType === "phase_ci_failed" || entry.eventType === "ci_failed" ? "CI failed"
          : entry.eventType === "github_pr_merged" || entry.eventType === "phase_merged" ? "Merged"
            : entry.eventType === "phase_cancelled" || entry.eventType === "cancelled" ? "Cancelled"
              : entry.eventType === "delivery_blocked" || entry.eventType === "phase_delivery_blocked" ? (summary || "Delivery blocked")
                : entry.eventType === "planning_started" && entry.metadata.planningStage === "completed" ? "Planner has finished"
                  : undefined;
  if (!text) return undefined;
  return { kind: "system", id: `system-${entry.id}`, at: entry.createdAt, text, tone: /failed|blocked|cancelled/i.test(text) ? "warning" : /passed|approved|merged/i.test(text) ? "success" : "muted" };
}

function turnSummary(task: ApiTask, invocation: ApiTask["agentInvocations"][number]): string | undefined {
  const matching = task.activity.filter((entry) => Date.parse(entry.createdAt) >= Date.parse(invocation.startedAt));
  if (invocation.role === "planner") {
    const summary = matching.find((entry) => entry.eventType === "planner_note_revised")?.metadata.summary as string | undefined ?? task.leadOutput?.summary;
    return summary ? withoutLegacyMaterialitySummary(summary) : undefined;
  }
  if (invocation.role === "builder") return task.developerExecution?.deliverySummary ?? task.developerExecution?.summary ?? undefined;
  if (invocation.role === "reviewer") return task.deliveryReview?.summary;
  return undefined;
}

function turnStats(events: ChatEvent[]): { filesChanged: number; additions: number; deletions: number } | undefined {
  const snapshot = [...events].reverse().find((event) => event.kind === "git_snapshot" || event.kind === "file_change");
  if (!snapshot) return undefined;
  const filesChanged = Number(snapshot.text.match(/(\d+)\s+files?/i)?.[1] ?? snapshot.files?.length ?? 0);
  const additions = Number(snapshot.text.match(/\+(\d+)/)?.[1] ?? 0);
  const deletions = Number(snapshot.text.match(/-(\d+)/)?.[1] ?? 0);
  return filesChanged || additions || deletions ? { filesChanged, additions, deletions } : undefined;
}

export function buildChatTranscript(task: ApiTask, liveEventsByExecution: Map<string, ChatEvent[]> = new Map()): ChatItem[] {
  const created = task.activity.find((entry) => entry.eventType === "task_created");
  const items: ChatItem[] = [{ kind: "member", id: "task-brief", at: task.createdAt, actor: actorFor(created), markdown: task.description }];
  for (const entry of task.activity) {
    if (entry.eventType === "task_created") continue;
    if (entry.eventType === "planner_note") items.push({ kind: "member", id: entry.id, at: entry.createdAt, actor: actorFor(entry), markdown: String(entry.metadata.note ?? "") });
    else if (entry.eventType === "member_action" || entry.eventType.includes("decision")) items.push({ kind: "member", id: entry.id, at: entry.createdAt, actor: actorFor(entry), markdown: activitySentence(entry, activityRole(entry)) });
    else {
      const system = systemItem(entry);
      if (system) items.push(system);
    }
  }
  for (const invocation of task.agentInvocations) {
    const events = liveEventsByExecution.get(invocation.id) ?? [];
    const intro = events.find((event) => event.kind === "agent_update")?.text;
    const status: Extract<ChatItem, { kind: "agent_turn" }>["status"] = invocation.finishedAt ? (terminalStatuses.has(invocation.status) ? invocation.status as "completed" | "failed" | "blocked" : "completed") : "running";
    const summary = turnSummary(task, invocation);
    const stats = turnStats(events);
    items.push({ kind: "agent_turn", id: `agent-${invocation.id}`, role: invocation.role, agent: { name: invocation.agentName ?? `${invocation.role[0]!.toUpperCase()}${invocation.role.slice(1)}`, avatarSeed: invocation.avatarSeed ?? invocation.role }, startedAt: invocation.startedAt, finishedAt: invocation.finishedAt, status, ...(intro ? { intro } : {}), events, ...(summary ? { summary } : {}), ...(stats ? { stats } : {}) });
  }
  if (task.githubPullRequest?.exists && task.githubPullRequest.observedAt) items.push({ kind: "pull_request", id: `pr-${task.githubPullRequest.observedAt}`, at: task.githubPullRequest.observedAt });
  return items.sort((left, right) => Date.parse(left.kind === "agent_turn" ? left.startedAt : left.at) - Date.parse(right.kind === "agent_turn" ? right.startedAt : right.at) || left.id.localeCompare(right.id));
}
