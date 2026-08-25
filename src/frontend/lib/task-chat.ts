import { activitySentence, activityRole, withoutLegacyMaterialitySummary } from "./task-activity-feed.js";
import type { ApiTask } from "./view-shared.js";
import type { AgentTimelineEvent } from "../../http/contracts/agent-events.js";

export type ChatActor = { name: string; avatarSeed: string };
export type ChatEvent = { id: string; at: string; kind: string; text: string; files?: string[]; exitCode?: number | null; stepNumber?: number | null; status?: "running" | "completed"; detail?: string; toolStatus?: string; output?: string; outputLines?: number; callId?: string; count?: number };
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

export function chatEventFromDeveloperEvent(event: { eventId: string; occurredAt: string; kind: string; stepNumber: number | null; summary: string; exitCode: number | null }): ChatEvent {
  const files = eventFiles(event.summary);
  return { id: event.eventId, at: event.occurredAt, kind: event.kind, text: event.summary, ...(files ? { files } : {}), stepNumber: event.stepNumber, exitCode: event.exitCode };
}

/** Convert the allowlisted rollout payload without recovering structure from prose. */
export function chatEventFromTimelineEvent(event: AgentTimelineEvent): ChatEvent | undefined {
  const metadata = event.metadata;
  const kind = typeof metadata.kind === "string" ? metadata.kind : event.eventType;
  const data = metadata.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : "";
  if (kind === "message" && role === "human") return undefined;
  if (kind === "turn_started" || kind === "turn_finished" || kind === "usage") return undefined;
  const text = typeof record.text === "string" ? record.text
    : typeof record.summary === "string" ? record.summary
      : typeof record.path === "string" ? record.path
        : typeof record.name === "string" ? record.name : "";
  const files = typeof record.path === "string" ? [record.path] : undefined;
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : null;
  const callId = typeof record.id === "string" ? record.id : undefined;
  const output = typeof record.output === "string" ? record.output : undefined;
  if (kind === "tool_call" && output && callId) return { id: event.id, at: event.createdAt, kind: "command_output", text: "", output, outputLines: output.split("\n").length, callId, exitCode };
  const detail = kind === "tool_call" && callId ? callId : undefined;
  const toolStatus = kind === "tool_call" && typeof record.status === "string" ? record.status : undefined;
  return { id: event.id, at: event.createdAt, kind, text, ...(files ? { files } : {}), exitCode, ...(callId ? { callId } : {}), ...(detail ? { detail } : {}), ...(toolStatus ? { toolStatus } : {}) };
}

function systemItem(entry: ApiTask["activity"][number]): ChatItem | undefined {
  const summary = String(entry.metadata.summary ?? entry.metadata.blockerSummary ?? "");
  const text = entry.eventType === "phase_plan_approved" || entry.eventType === "plan_approved" ? "Plan approved automatically"
    : entry.eventType === "phase_ci_passed" || entry.eventType === "ci_passed" ? "CI passed"
      : entry.eventType === "github_pr_merged" || entry.eventType === "phase_merged" ? "Merged"
        : entry.eventType === "delivery_blocked" || entry.eventType === "phase_delivery_blocked" ? (summary || "Delivery blocked")
          : undefined;
  if (!text) return undefined;
  return { kind: "system", id: `system-${entry.id}`, at: entry.createdAt, text, tone: /failed|blocked|cancelled/i.test(text) ? "warning" : /passed|approved|merged/i.test(text) ? "success" : "muted" };
}

function invocationEnd(invocation: ApiTask["agentInvocations"][number], invocations: ApiTask["agentInvocations"]): number {
  const next = invocations.find((candidate) => Date.parse(candidate.startedAt) > Date.parse(invocation.startedAt));
  return Math.min(next ? Date.parse(next.startedAt) : Infinity, invocation.finishedAt ? Date.parse(invocation.finishedAt) : Infinity);
}

function summaryForReview(review: { outcome: "approved" | "blocking"; summary: string; findings: Array<{ rationale: string }> }): string {
  const outcome = `${review.outcome[0]!.toUpperCase()}${review.outcome.slice(1)}`;
  const summary = review.summary.trim();
  const prefixed = new RegExp(`^${outcome}\\b[.:]?\\s*`, "i").test(summary) ? summary : `${outcome}. ${summary}`;
  const findings = review.outcome === "blocking" ? review.findings.map(({ rationale }) => rationale.trim()).filter(Boolean).map((rationale) => `- ${rationale}`).join("\n") : "";
  return findings ? `${prefixed}\n${findings}` : prefixed;
}

function turnSummary(task: ApiTask, invocation: ApiTask["agentInvocations"][number], invocations: ApiTask["agentInvocations"]): string | undefined {
  const startedAt = Date.parse(invocation.startedAt);
  const endsAt = invocationEnd(invocation, invocations);
  const matching = task.activity.filter((entry) => {
    const createdAt = Date.parse(entry.createdAt);
    return createdAt >= startedAt && createdAt <= endsAt;
  });
  if (invocation.role === "planner") {
    if (!matching.some((entry) => entry.eventType === "planning_started" || entry.eventType === "planner_note_revised" || /(?:^|_)plan_approved$/.test(entry.eventType))) return undefined;
    const summary = matching.find((entry) => entry.eventType === "planner_note_revised")?.metadata.summary as string | undefined
      ?? (task.leadOutput?.executionId === invocation.id ? task.leadOutput.summary : undefined);
    return summary ? withoutLegacyMaterialitySummary(summary) : undefined;
  }
  if (invocation.role === "builder") {
    if (task.developerExecution?.id === invocation.id) return task.developerExecution.deliverySummary ?? task.developerExecution.summary ?? undefined;
    return undefined;
  }
  if (invocation.role !== "reviewer") return undefined;
  const delivery = task.deliveryReviewHistory.find((review) => review.leadExecutionId === invocation.id)
    ?? task.deliveryReviewHistory.find((review) => {
      const createdAt = Date.parse(review.createdAt);
      return createdAt >= startedAt && createdAt <= endsAt;
    });
  if (delivery) return summaryForReview({ ...delivery, findings: task.deliveryReview?.id === delivery.id ? task.deliveryReview.findings : [] });
  const finalReview = task.deliveryGate?.finalReview;
  if (finalReview && (finalReview.leadExecutionId === invocation.id || (Date.parse(finalReview.createdAt) >= startedAt && Date.parse(finalReview.createdAt) <= endsAt))) return summaryForReview(finalReview);
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

function commandLabel(event: ChatEvent): string {
  return event.text.split("\n")[0]!.replace(/^(?:Running|Ran \(exit \d+\)|Command finished(?: \(exit \d+\)?)): /, "");
}

function matchingCommand(started: ChatEvent, finished: ChatEvent): boolean {
  return started.kind === "command_started" && finished.kind === "command_finished"
    && started.stepNumber === finished.stepNumber && commandLabel(started) === commandLabel(finished);
}

export function compactChatEvents(events: ChatEvent[], intro?: ChatEvent): ChatEvent[] {
  const paired: ChatEvent[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const next = events[index + 1];
    if (next && matchingCommand(event, next)) {
      paired.push({ ...event, kind: "command", text: commandLabel(event), exitCode: next.exitCode ?? null, status: "completed" });
      index += 1;
    } else if (event.kind === "command_started") paired.push({ ...event, kind: "command", text: commandLabel(event), status: "running" });
    else if (event.kind === "command_finished") paired.push({ ...event, kind: "command", text: commandLabel(event), status: "completed" });
    else paired.push(event);
  }
  const outputs = new Map(paired.filter((event) => event.kind === "command_output" && event.callId && event.output).map((event) => [event.callId!, event]));
  const visible = (intro ? paired.filter((event) => event.id !== intro.id) : paired)
    .filter((event) => event.kind !== "command_output")
    .map((event) => {
      const output = event.kind === "command" && event.callId ? outputs.get(event.callId) : undefined;
      return output ? { ...event, output: output.output!, outputLines: output.outputLines! } : event;
    });
  return visible.reduce<ChatEvent[]>((compacted, event) => {
    const previous = compacted.at(-1);
    if (previous && previous.kind === event.kind && previous.text === event.text && previous.status === event.status && previous.exitCode === event.exitCode && (event.kind === "tool_call" ? previous.toolStatus === event.toolStatus : previous.detail === event.detail)) {
      previous.count = (previous.count ?? 1) + 1;
    } else compacted.push({ ...event });
    return compacted;
  }, []);
}

function shouldShowMemberAction(entry: ApiTask["activity"][number]): boolean {
  if (entry.eventType !== "member_action") return true;
  const command = String(entry.metadata.command ?? entry.metadata.action ?? "");
  const commandId = String(entry.metadata.commandId ?? entry.metadata.command_id ?? "");
  return Boolean(entry.actor) && !["start_planning", "start_development", "resync_projection"].includes(command)
    && !command.startsWith("retry_") && !command.startsWith("auto") && !commandId.includes(":auto-")
    && entry.metadata.automatic !== true && entry.metadata.automatic !== "true";
}

function itemTime(item: ChatItem): number { return Date.parse(item.kind === "agent_turn" ? item.startedAt : item.at); }
function itemTieBreak(item: ChatItem): number { return item.kind === "member" ? 0 : item.kind === "agent_turn" ? 1 : item.kind === "system" ? 2 : 3; }
export function sortChatItems(items: ChatItem[]): ChatItem[] {
  return items.sort((left, right) => itemTime(left) - itemTime(right) || itemTieBreak(left) - itemTieBreak(right) || left.id.localeCompare(right.id));
}

export function buildChatTranscript(task: ApiTask, liveEventsByExecution: Map<string, ChatEvent[]> = new Map()): ChatItem[] {
  const created = task.activity.find((entry) => entry.eventType === "task_created");
  const items: ChatItem[] = [{ kind: "member", id: "task-brief", at: task.createdAt, actor: actorFor(created), markdown: task.description }];
  for (const entry of task.activity) {
    if (entry.eventType === "task_created") continue;
    if (entry.eventType === "planner_note") items.push({ kind: "member", id: entry.id, at: entry.createdAt, actor: actorFor(entry), markdown: String(entry.metadata.note ?? "") });
    else if ((entry.eventType === "member_action" && shouldShowMemberAction(entry)) || entry.eventType.includes("decision")) items.push({ kind: "member", id: entry.id, at: entry.createdAt, actor: actorFor(entry), markdown: activitySentence(entry, activityRole(entry)) });
    else {
      const system = systemItem(entry);
      if (system) items.push(system);
    }
  }
  const renderedSummaries = new Set<string>();
  const invocations = [...task.agentInvocations].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.id.localeCompare(right.id));
  for (const invocation of invocations) {
    const events = liveEventsByExecution.get(invocation.id) ?? [];
    const introEvent = events.find((event) => event.kind === "agent_update");
    const intro = introEvent?.text;
    const status: Extract<ChatItem, { kind: "agent_turn" }>["status"] = invocation.finishedAt ? (terminalStatuses.has(invocation.status) ? invocation.status as "completed" | "failed" | "blocked" : "completed") : "running";
    const candidate = turnSummary(task, invocation, invocations);
    const summary = candidate && !renderedSummaries.has(candidate) ? candidate : undefined;
    if (summary) renderedSummaries.add(summary);
    const stats = turnStats(events);
    items.push({ kind: "agent_turn", id: `agent-${invocation.id}`, role: invocation.role, agent: { name: invocation.agentName ?? `${invocation.role[0]!.toUpperCase()}${invocation.role.slice(1)}`, avatarSeed: invocation.avatarSeed ?? invocation.role }, startedAt: invocation.startedAt, finishedAt: invocation.finishedAt, status, ...(intro ? { intro } : {}), events: compactChatEvents(events, introEvent), ...(summary ? { summary } : {}), ...(stats ? { stats } : {}) });
  }
  if (task.githubPullRequest?.exists && task.githubPullRequest.observedAt) items.push({ kind: "pull_request", id: `pr-${task.githubPullRequest.observedAt}`, at: task.githubPullRequest.observedAt });
  return sortChatItems(items);
}
