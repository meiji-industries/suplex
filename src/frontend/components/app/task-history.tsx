import { useEffect, useMemo, useState } from "react";

import { ProfileAvatar } from "./profile-avatar.js";
import { Badge } from "../ui/badge.js";
import { relativeTime } from "../../lib/view-shared.js";
import { readJson } from "../../lib/api.js";
import { activityRole, activityRoleLabel, activitySentence, compactActivityRows, isAutomaticActivity, type ActivityFeedRow, type ActivityRole } from "../../lib/task-activity-feed.js";
import type { TaskResponse } from "../../../http/contracts/tasks.js";

export type TaskActivityEntry = TaskResponse["activity"][number];
type LiveActivityEvent = { at: string; kind: "thinking" | "command" | "output" | "message" | "status"; text: string; exitCode?: number };
type ActivityFeed = { execution: { id: string; role: Exclude<ActivityRole, "you" | "forge">; status: string; currentStep: string | null } | null; events: LiveActivityEvent[] };
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
        if (active) setFeed((current) => ({ execution: current?.execution ?? null, events: [...(current?.events ?? []), event].slice(-300) }));
      } catch { /* Ignore malformed live activity. */ }
    });
    return () => { active = false; stream.close(); };
  }, [taskId]);
  return feed;
}

export function TaskActivity({ taskId = "", timeline, release, ci, onViewChanges }: {
  taskId?: string;
  timeline: TaskActivityEntry[];
  release?: { pullRequestUrl?: string | null; pullRequestNumber?: number | null } | null | undefined;
  ci?: unknown;
  agentInvocations?: unknown;
  processing?: unknown;
  collapsePlan?: boolean;
  deliveryReviewTask?: unknown;
  repository?: string | undefined;
  developerAttempts?: unknown;
  revisionContent?: unknown;
  children?: unknown;
  onViewChanges?: (() => void) | undefined;
}) {
  const feed = useLiveActivity(taskId);
  const rows = useMemo(() => {
    const durable = timeline.map((entry): FeedRow => {
      const role = activityRole(entry);
      const link = timelineLink(entry, release, ci);
      return { id: entry.id, at: entry.createdAt, role, text: activitySentence(entry, role), revision: entry.revision, ...(isAutomaticActivity(entry, role) ? { automatic: true } : {}), ...(link ? { link } : {}) };
    });
    const live = (feed?.events ?? []).map((event, index): FeedRow => ({ id: `live-${event.at}-${event.kind}-${index}`, at: event.at, role: feed?.execution?.role ?? "integrator", text: liveText(event, feed?.execution?.role ?? "integrator"), live: event.kind === "status" || event.kind === "thinking" }));
    return compactActivityRows([...durable, ...live]);
  }, [ci, feed, release, timeline]);
  return <section data-task-activity-feed className="space-y-1" aria-label="Activity">
    <div data-task-activity className="divide-y">
      {rows.map((row) => <div className="flex min-w-0 items-center gap-2 py-2 text-xs" key={row.id} data-task-activity-kind={row.role} {...(row.revision === undefined ? {} : { "data-task-activity-revision": row.revision })}>
        <ProfileAvatar name={activityRoleLabel(row.role)} seed={row.role} size="xs" />
        <span className="shrink-0 font-medium">{activityRoleLabel(row.role)}</span>
        {row.automatic ? <Badge variant="secondary">auto</Badge> : null}
        <span className="min-w-0 flex-1 text-muted-foreground">{row.text.replace(new RegExp(`^${activityRoleLabel(row.role)}\\s+`), "")}</span>
        {row.count ? <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[11px] text-muted-foreground" aria-label={`${row.count} identical events`}>×{row.count}</span> : null}
        {row.link ? <a className="shrink-0 underline underline-offset-2" href={row.link.href} onClick={row.link.label === "View changes" && onViewChanges ? (event) => { event.preventDefault(); onViewChanges(); } : undefined} target={row.link.href.startsWith("http") ? "_blank" : undefined} rel={row.link.href.startsWith("http") ? "noreferrer" : undefined}>{row.link.label}</a> : null}
        <time className="shrink-0 text-[11px] text-muted-foreground" dateTime={row.at} title={new Date(row.at).toLocaleString()}>{row.live ? `updated ${activityRelativeDate(row.at)}` : activityRelativeDate(row.at)}</time>
      </div>)}
      {!rows.length ? <p className="py-2 text-xs text-muted-foreground">No activity yet.</p> : null}
    </div>
  </section>;
}
