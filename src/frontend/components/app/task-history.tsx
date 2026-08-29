import { useEffect, useMemo, useState, type ReactElement } from "react";

import { ProfileAvatar } from "./profile-avatar.js";
import { CommandOutputBlock, type CommandOutput } from "./command-output.js";
import { Markdown } from "./markdown.js";
import { Badge } from "../ui/badge.js";
import { relativeTime } from "../../lib/view-shared.js";
import { readJson } from "../../lib/api.js";
import { activityRole, activityRoleLabel, activitySentence, agentTurnActivityRows, compactActivityRows, isAutomaticActivity, type ActivityFeedRow, type ActivityRole } from "../../lib/task-activity-feed.js";
import type { TaskResponse } from "../../../http/contracts/tasks.js";

export type TaskActivityEntry = TaskResponse["activity"][number];
type LiveActivityEvent = { at: string; kind: "thinking" | "command" | "output" | "message" | "status"; text: string; command?: string; cwd?: string; exitCode?: number | null; durationMs?: number; stdout?: string; stderr?: string; entries?: Array<{ stream: "stdout" | "stderr"; text: string }> };
type RecordedCommand = CommandOutput & { id: string; stepId: string };
type ActivityFeed = { execution: { id: string; role: Exclude<ActivityRole, "you" | "forge">; status: string; currentStep: string | null } | null; events: LiveActivityEvent[]; commands: RecordedCommand[] };
type FeedRow = ActivityFeedRow;

export const activityRelativeDate = relativeTime;

export function extractAgentTranscript(evidence: string): string {
  return evidence.split("\n").flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      if (event.type !== "item.completed" || event.item?.type !== "agent_message" || typeof event.item.text !== "string") return [];
      try { return [JSON.stringify(JSON.parse(event.item.text), null, 2)]; }
      catch { return [event.item.text]; }
    } catch { return []; }
  }).join("\n\n").slice(0, 12_000);
}

type HarnessMessage = { kind?: string; summary?: string };

export function harnessSummary(message: HarnessMessage): string | undefined {
  if (message.kind !== "decision_blocker" || !message.summary) return message.summary;
  const file = message.summary.match(/`([^`]+)`/)?.[1];
  return file ? `There is a conflict in ${file}. Choose how to resolve it.` : "There is a conflict that needs your choice.";
}

function liveText(event: LiveActivityEvent, role: Exclude<ActivityRole, "you" | "forge">): string {
  const subject = activityRoleLabel(role);
  if (event.kind === "command") return `${subject} ran a command`;
  if (event.kind === "status") return /completed|finished/i.test(event.text) ? `${subject} finished work` : `${subject} is working`;
  if (event.kind === "thinking") return `${subject} is thinking`;
  return `${subject} sent an update`;
}

function commandOutput(event: LiveActivityEvent): CommandOutput | undefined {
  if (event.kind !== "command" || !event.command || event.durationMs === undefined) return undefined;
  return { command: event.command, cwd: event.cwd, exitCode: event.exitCode ?? null, durationMs: event.durationMs, stdout: event.stdout ?? "", stderr: event.stderr ?? "", at: event.at, entries: event.entries };
}


function timelineLink(entry: TaskActivityEntry, release: { pullRequestUrl?: string | null; pullRequestNumber?: number | null } | null | undefined, ci: unknown): FeedRow["link"] {
  if (entry.eventType === "planning_started" && entry.metadata.planningStage === "completed") return { href: "#plan", label: "View plan" };
  if (entry.eventType === "phase_development" || entry.eventType === "phase_repair_required") return { href: "#diffs", label: "View changes" };
  if (entry.eventType === "phase_ci_waiting" && ci) return { href: "#checks", label: "View CI" };
  if (release?.pullRequestUrl && (entry.eventType.includes("release") || entry.eventType.includes("merge") || entry.eventType === "phase_done")) return { href: release.pullRequestUrl, label: `PR #${release.pullRequestNumber}` };
  return undefined;
}

function useLiveActivity(taskId: string): ActivityFeed | null {
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  useEffect(() => {
    let active = true;
    void readJson<ActivityFeed>(`/api/tasks/${encodeURIComponent(taskId)}/activity`).then((value) => { if (active) setFeed(value); }).catch(() => { if (active) setFeed(null); });
    const stream = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/activity/stream`);
    stream.addEventListener("activity", (message) => {
      try {
        const event = JSON.parse((message as MessageEvent<string>).data) as LiveActivityEvent;
        if (active) setFeed((current) => ({ execution: current?.execution ?? null, commands: current?.commands ?? [], events: [...(current?.events ?? []), event].slice(-300) }));
      } catch { /* Ignore malformed live activity. */ }
    });
    stream.addEventListener("command", (message) => {
      try {
        const command = JSON.parse((message as MessageEvent<string>).data) as RecordedCommand;
        if (active) setFeed((current) => ({ execution: current?.execution ?? null, events: current?.events ?? [], commands: [...(current?.commands ?? []).filter((item) => item.id !== command.id), command].slice(-50) }));
      } catch { /* Ignore malformed command activity. */ }
    });
    return () => { active = false; stream.close(); };
  }, [taskId]);
  return feed;
}

export function TaskActivity({ taskId = "", timeline, release, ci, agentInvocations = [], optimisticRows = [], githubPullRequest, onViewChanges, deliveryTarget }: {
  taskId?: string;
  timeline: TaskActivityEntry[];
  release?: { pullRequestUrl?: string | null; pullRequestNumber?: number | null } | null | undefined;
  ci?: unknown;
  agentInvocations?: TaskResponse["agentInvocations"];
  processing?: unknown;
  collapsePlan?: boolean;
  deliveryReviewTask?: unknown;
  repository?: string | undefined;
  developerAttempts?: unknown;
  revisionContent?: unknown;
  optimisticRows?: ActivityFeedRow[];
  githubPullRequest?: { exists: boolean; number: number | null; state: "open" | "closed" | "merged" | null; isDraft: boolean | null; autoMergeEnabled: boolean | null; observedAt: string | null } | undefined;
  deliveryTarget?: "pull_request_draft" | "pull_request_ready" | "local_worktree" | "remote_branch" | "merged";
  children?: unknown;
  onViewChanges?: (() => void) | undefined;
}) {
  const feed = useLiveActivity(taskId);
  const rows = useMemo(() => {
    const durable = timeline.map((entry): FeedRow => {
      const role = activityRole(entry);
      const link = timelineLink(entry, release, ci);
      const commands = feed?.commands.filter((command) => command.stepId === entry.id) ?? [];
      const activity = entry.eventType === "phase_done" ? { ...entry, metadata: { ...entry.metadata, deliveryTarget: deliveryTarget ?? "" } } : entry;
      return { id: entry.id, at: entry.createdAt, role, text: activitySentence(activity, role), eventType: entry.eventType, ...(typeof entry.metadata.pendingAction === "string" ? { pendingAction: entry.metadata.pendingAction } : {}), revision: entry.revision, ...(commands.length ? { commands } : {}), ...(isAutomaticActivity(entry, role) ? { automatic: true } : {}), ...(link ? { link } : {}) };
    });
    const live = (feed?.events ?? []).map((event, index): FeedRow => {
      const command = commandOutput(event);
      return { id: `live-${event.at}-${event.kind}-${index}`, at: event.at, role: feed?.execution?.role ?? "integrator", text: liveText(event, feed?.execution?.role ?? "integrator"), live: event.kind === "status" || event.kind === "thinking", ...(command ? { command } : {}) };
    });
    const githubRow = githubPullRequest?.exists && githubPullRequest.number !== null && githubPullRequest.observedAt
      ? [{ id: `github-${githubPullRequest.observedAt}`, at: githubPullRequest.observedAt, role: "forge" as const, text: activitySentence({ eventType: githubPullRequest.state === "merged" ? "github_pr_merged" : githubPullRequest.state === "closed" ? "github_pr_closed" : githubPullRequest.isDraft ? "github_pr_draft" : githubPullRequest.autoMergeEnabled ? "github_pr_auto_merge_enabled" : "github_pr_ready", metadata: { pullRequestNumber: githubPullRequest.number } }, "forge") }]
      : [];
    return compactActivityRows([...durable, ...agentTurnActivityRows(agentInvocations), ...githubRow, ...live, ...optimisticRows]);
  }, [agentInvocations, ci, deliveryTarget, feed, githubPullRequest, optimisticRows, release, timeline]);
  return <section data-task-activity-feed className="space-y-1" aria-label="Activity">
    <div data-task-activity className="divide-y">
      {rows.map((row) => <ActivityRow key={row.id} row={row} {...(onViewChanges ? { onViewChanges } : {})} />)}
      {!rows.length ? <p className="py-2 text-xs text-muted-foreground">No activity yet.</p> : null}
    </div>
  </section>;
}

function ActivityRow({ row, onViewChanges }: { row: FeedRow; onViewChanges?: () => void }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const failed = row.commands?.some((command) => command.exitCode !== null && command.exitCode !== 0) ?? false;
  return <div className={`min-w-0 py-2 text-xs${row.command ? " items-start" : ""}`} data-task-activity-kind={row.role} {...(row.revision === undefined ? {} : { "data-task-activity-revision": row.revision })}>
    <div className="flex min-w-0 items-start gap-2">
      <ProfileAvatar name={activityRoleLabel(row.role)} seed={row.role} size="xs" />
      <span className="shrink-0 font-medium">{activityRoleLabel(row.role)}</span>
      {row.automatic ? <Badge variant="secondary">auto</Badge> : null}
      {row.command ? <div className="min-w-0 flex-1"><CommandOutputBlock output={row.command} /></div> : <div className="min-w-0 flex-1 text-muted-foreground"><Markdown source={row.text.replace(new RegExp(`^${activityRoleLabel(row.role)}\\s+`), "")} /></div>}
      {row.commands?.length ? <button type="button" data-command-chip className={failed ? "shrink-0 rounded bg-red-500/15 px-1 py-0.5 text-[11px] text-red-600 dark:text-red-400" : "shrink-0 rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground"} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{row.commands.length} commands{failed ? ` · ${row.commands.filter((command) => command.exitCode !== null && command.exitCode !== 0).length} failed` : ""}</button> : null}
      {row.count ? <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground" aria-label={`${row.count} identical events`}>×{row.count}</span> : null}
      {row.link ? <a className="shrink-0 underline underline-offset-2" href={row.link.href} onClick={row.link.label === "View changes" && onViewChanges ? (event) => { event.preventDefault(); onViewChanges(); } : undefined} target={row.link.href.startsWith("http") ? "_blank" : undefined} rel={row.link.href.startsWith("http") ? "noreferrer" : undefined}>{row.link.label}</a> : null}
      <time className="shrink-0 text-[11px] text-muted-foreground" dateTime={row.at} title={new Date(row.at).toLocaleString()}>{row.live ? `updated ${activityRelativeDate(row.at)}` : activityRelativeDate(row.at)}</time>
    </div>
    {expanded && row.commands?.length ? <div className="ml-7 mt-1 space-y-1" data-step-commands>{row.commands.map((command) => <CommandOutputBlock key={command.id} output={command} />)}</div> : null}
  </div>;
}
