import { useEffect, useState, type ReactNode } from "react";
import { CircleX, LoaderCircle } from "lucide-react";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion.js";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert.js";
import { Badge } from "../ui/badge.js";
import { Card, CardContent } from "../ui/card.js";
import { Separator } from "../ui/separator.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.js";
import { Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from "../ui/timeline.js";
import { TaskInvocations, type TaskInvocation } from "./task-invocations.js";
import { ProfileAvatar, type DiceBearCollection } from "./profile-avatar.js";
import { TaskStatus } from "./task-status.js";
import { withCompany } from "../../lib/api.js";
import { phaseLabel, type IssuePhase } from "../../../issue-phases.js";
import type { TaskResponse } from "../../../http/contracts/tasks.js";
import { DeliveryReviewPanel } from "./delivery-review-panel.js";

export type TaskActivityEntry = TaskResponse["activity"][number];
type LinkedTask = NonNullable<TaskResponse["predecessor"]>;
type ProcessingActivity = { profileName: string; avatarSeed: string };
type DurableTaskHistory = Pick<TaskResponse, "id" | "timeline" | "agentInvocations" | "planHistory" | "planDecisionHistory" | "revisionHistory" | "developerExecutionHistory" | "deliveryReviewHistory" | "predecessor" | "successor">;
type TaskHistoryContext = { originalPlan?: { content: ReactNode; current: boolean }; materiality?: { content: ReactNode; routine: boolean }; memberDecision?: ReactNode };

function activityDate(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

export function activityRelativeDate(timestamp: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""} ago`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? ` ${hours % 24}h` : ""} ago`;
}

function activityCopy(entry: TaskActivityEntry): string {
  if (entry.eventType === "member_action") return `chose ${String(entry.metadata?.actionLabel ?? entry.metadata?.command ?? "an action")}`;
  if (entry.eventType === "task_created") return "created the task";
  if (entry.eventType === "planning_started") {
    if (entry.metadata.planningStage === "active") return "planning began";
    if (entry.metadata.planningStage === "completed") return "planning completed";
    if (entry.metadata.planningStage === "queued") return "waiting for planning capacity";
    if (entry.metadata.planningStage === "rate_limited") return "waiting for provider reset";
    return "started planning";
  }
  if (entry.eventType.startsWith("phase_")) {
    const phase = entry.eventType.slice("phase_".length);
    return `moved the task to ${phaseLabel(phase as IssuePhase)}`;
  }
  return entry.eventType.replaceAll("_", " ");
}

function activityActor(entry: TaskActivityEntry, actionIndex: number, invocations: TaskInvocation[], processing?: ProcessingActivity): { label: string; initials: string; avatarSeed?: string; avatarCollection?: DiceBearCollection } {
  if (entry.actor) return { label: entry.actor.displayName, initials: entry.actor.displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?", avatarSeed: entry.actor.avatarSeed ?? entry.actor.username ?? entry.actor.displayName, avatarCollection: "pixel-art-neutral" };
  if (entry.eventType === "task_created") return { label: "Forge", initials: "F" };
  const profileInvocations = invocations.filter((invocation) => invocation.profileName);
  const invocation = profileInvocations[Math.min(actionIndex, profileInvocations.length - 1)];
  const profileName = invocation?.profileName ?? (entry.eventType === "planning_started" ? processing?.profileName : undefined);
  const role = invocation?.role ? `${invocation.role.charAt(0).toUpperCase()}${invocation.role.slice(1)}` : profileName ? "Lead" : "";
  const label = profileName ? `${profileName} · ${role}` : "Forge";
  const avatarSeed = invocation?.avatarSeed ?? (entry.eventType === "planning_started" ? processing?.avatarSeed : undefined);
  return { label, initials: profileName?.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "F", ...(avatarSeed ? { avatarSeed } : {}) };
}

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

type HarnessMessage = { kind?: string | undefined; summary?: string | undefined; outcome?: string | undefined; findings?: Array<{ severity?: string | undefined; rationale?: string | undefined; disposition?: string | undefined }> | undefined; repairPlan?: string | null | undefined };

function parseHarnessMessage(output: string): HarnessMessage | undefined {
  const firstMessage = output.split("\n\n", 1)[0] ?? "";
  try {
    const parsed: unknown = JSON.parse(firstMessage);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const source = parsed as Record<string, unknown>;
    const findings = Array.isArray(source.findings) ? source.findings.flatMap((finding) => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) return [];
      const item = finding as Record<string, unknown>;
      return [{ ...(typeof item.severity === "string" ? { severity: item.severity } : {}), ...(typeof item.rationale === "string" ? { rationale: item.rationale } : {}), ...(typeof item.disposition === "string" ? { disposition: item.disposition } : {}) }];
    }) : undefined;
    return { kind: typeof source.kind === "string" ? source.kind : undefined, summary: typeof source.summary === "string" ? source.summary : undefined, outcome: typeof source.outcome === "string" ? source.outcome : undefined, findings, repairPlan: typeof source.repairPlan === "string" ? source.repairPlan : null };
  } catch {
    return undefined;
  }
}

function AgentHarnessOutput({ taskId, invocation }: { taskId: string; invocation: TaskInvocation }) {
  const [output, setOutput] = useState<string | null>(null);
  useEffect(() => {
    if (!invocation.evidenceArtifactId) return;
    const controller = new AbortController();
    void fetch(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(invocation.evidenceArtifactId)}`, { signal: controller.signal })
      .then(async (response) => response.ok ? extractAgentTranscript(await response.text()) : "")
      .then((next) => { if (!controller.signal.aborted) setOutput(next || "Harness output unavailable"); })
      .catch(() => { if (!controller.signal.aborted) setOutput("Harness output unavailable"); });
    return () => controller.abort();
  }, [invocation.evidenceArtifactId, taskId]);
  if (!invocation.evidenceArtifactId) return null;
  const message = output ? parseHarnessMessage(output) : undefined;
  const findings = message?.findings?.filter((finding) => finding.rationale || finding.severity) ?? [];
  return <Card data-agent-harness-output data-agent-execution-id={invocation.id} size="sm" className="mt-2 gap-0">
    <CardContent className="gap-2 py-2 text-[12px]">
      {message?.summary ? <p className="whitespace-pre-wrap break-words">{message.summary}</p> : null}
      {findings.length ? <div className="divide-y border-y text-[11px]">{findings.map((finding, index) => <div className="py-1.5" key={`${finding.severity ?? "finding"}-${index}`}><span className="font-medium">{finding.severity ?? "Finding"}</span>{finding.rationale ? <span className="text-muted-foreground"> · {finding.rationale}</span> : null}</div>)}</div> : null}
      {message?.repairPlan ? <div className="text-[11px]"><span className="font-medium">Repair plan</span><span className="text-muted-foreground"> · {message.repairPlan}</span></div> : null}
      {!message?.summary ? <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-4 text-foreground">{output ?? "Loading harness output…"}</pre> : null}
    </CardContent>
  </Card>;
}

function ActivityTimeline({ taskId, timeline, invocations = [], revisionContent, processing, collapsePlan, deliveryReviewTask }: { taskId: string; timeline: TaskActivityEntry[]; invocations?: TaskInvocation[]; revisionContent?: { revision: number; content: ReactNode } | undefined; processing?: ProcessingActivity | undefined; collapsePlan?: boolean; deliveryReviewTask?: TaskResponse }) {
  const contentEntryId = revisionContent ? (timeline.find((entry) => entry.revision === revisionContent.revision && entry.kind !== "member") ?? timeline.find((entry) => entry.revision === revisionContent.revision))?.id : undefined;
  const deliveryReviewEntryId = deliveryReviewTask ? [...timeline].reverse().find((entry) => ["phase_delivery_reviewed", "phase_repair_required", "phase_delivery_blocked"].includes(entry.eventType))?.id : undefined;
  return <div data-task-activity>
    <Timeline orientation="vertical" value={0}>
      {timeline.map((entry, index) => {
        const actionIndex = timeline.slice(0, index).filter((candidate) => candidate.kind !== "member" && candidate.eventType !== "task_created").length;
        const actor = activityActor(entry, actionIndex, invocations, processing);
        const phaseInvocations = invocations.filter((invocation) => [...timeline].reverse().find((candidate) => Date.parse(candidate.createdAt) <= Date.parse(invocation.startedAt))?.id === entry.id);
        const blockedReason = typeof entry.metadata.blockedReason === "string" ? entry.metadata.blockedReason : undefined;
        return <TimelineItem key={entry.id} step={index + 1} data-task-activity-kind={entry.kind ?? "workflow"} data-task-activity-revision={entry.revision}>
          <TimelineHeader className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <TimelineSeparator />
            <TimelineTitle className="text-xs">{actor.label}</TimelineTitle>
            <span className="text-xs text-muted-foreground">{activityCopy(entry)}</span>
            <span className="text-xs text-muted-foreground">·</span>
            <TimelineDate dateTime={entry.createdAt} title={activityDate(entry.createdAt)} className="mb-0 font-normal">{activityRelativeDate(entry.createdAt)}</TimelineDate>
            <TimelineIndicator className="flex size-6 items-center justify-center border bg-muted text-[10px] font-semibold text-muted-foreground">{actor.avatarSeed ? <ProfileAvatar name={actor.label} seed={actor.avatarSeed} {...(actor.avatarCollection ? { collection: actor.avatarCollection } : {})} /> : actor.initials}</TimelineIndicator>
          </TimelineHeader>
          <TimelineContent className="text-[12px]">
            {blockedReason ? <div className="mt-2"><Alert variant="destructive" data-task-blocked-reason><CircleX /><AlertTitle>Blocked reason</AlertTitle><AlertDescription>{blockedReason}</AlertDescription></Alert></div> : null}
            {entry.id === contentEntryId ? <div data-task-activity-plan className={collapsePlan ? "mt-2 text-foreground" : "mt-4 text-foreground"}>{revisionContent?.content}</div> : null}
            {entry.id === deliveryReviewEntryId ? <div data-task-activity-delivery-review className="mt-3"><DeliveryReviewPanel task={deliveryReviewTask!} /></div> : null}
            {phaseInvocations.map((invocation) => <AgentHarnessOutput key={invocation.id} taskId={taskId} invocation={invocation} />)}
          </TimelineContent>
        </TimelineItem>;
      })}
      {processing ? <TimelineItem step={timeline.length + 1} data-task-activity-processing>
        <TimelineHeader className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <TimelineSeparator />
          <TimelineTitle className="text-xs">{processing.profileName}</TimelineTitle>
          <span className="text-xs text-muted-foreground">is working</span>
          <TimelineIndicator className="flex size-6 items-center justify-center border bg-muted text-muted-foreground"><LoaderCircle className="size-3 animate-spin" /></TimelineIndicator>
        </TimelineHeader>
      </TimelineItem> : null}
    </Timeline>
  </div>;
}

export function TaskActivity({ taskId, timeline, agentInvocations, revisionContent, processing, collapsePlan, deliveryReviewTask, children }: { taskId?: string; timeline: TaskActivityEntry[]; agentInvocations: TaskInvocation[]; revisionContent?: { revision: number; content: ReactNode } | undefined; processing?: ProcessingActivity | undefined; collapsePlan?: boolean; deliveryReviewTask?: TaskResponse; children?: ReactNode }) {
  const placedContent = revisionContent && timeline.some((entry) => entry.revision === revisionContent.revision) ? revisionContent : undefined;
  return <section data-task-activity-feed className="space-y-3">
    <ActivityTimeline taskId={taskId ?? ""} timeline={timeline} invocations={agentInvocations} revisionContent={placedContent} processing={processing} {...(deliveryReviewTask ? { deliveryReviewTask } : {})} {...(collapsePlan === undefined ? {} : { collapsePlan })} />
    {children}
  </section>;
}

export function TaskHistory({ task, companyId, context = {} }: { task: DurableTaskHistory; companyId: string; context?: TaskHistoryContext }) {
  const planCount = task.planHistory.length + task.planDecisionHistory.length;
  const durableCount = planCount + task.revisionHistory.length + task.developerExecutionHistory.length + task.deliveryReviewHistory.length;
  const hasDecisions = Boolean(context.memberDecision) || planCount > 0 || task.revisionHistory.length > 0 || task.deliveryReviewHistory.length > 0;
  const artifact = (artifactId: string, label: string) => <a href={`/api/tasks/${task.id}/artifacts/${artifactId}`} target="_blank" rel="noreferrer">{label}</a>;
  const taskLink = (linked: LinkedTask, label: string) => <a href={withCompany(`/tasks/${encodeURIComponent(linked.id)}`, companyId)}>{label}: {linked.issueKey ? <span className="text-muted-foreground">{linked.issueKey} </span> : null}{linked.title} · <TaskStatus phase={linked.phase} /></a>;
  return (
    <section data-task-history>
      <Accordion>
        <AccordionItem value="history">
          <AccordionTrigger><span><span>History</span> · {durableCount}</span></AccordionTrigger>
          <AccordionContent>
            <div className="space-y-4">
              <div className="text-xs text-muted-foreground">{durableCount} immutable {durableCount === 1 ? "record" : "records"}</div>
              {task.predecessor || task.successor ? <div className="flex flex-wrap gap-3 text-xs">{task.predecessor ? taskLink(task.predecessor, "Predecessor") : null}{task.successor ? taskLink(task.successor, "Successor") : null}</div> : null}
              <Separator />
              <Tabs defaultValue="invocations">
                <TabsList className="max-w-full overflow-x-auto">
                  {context.originalPlan ? <TabsTrigger value="original-plan">Original plan <Badge variant={context.originalPlan.current ? "secondary" : "outline"}>{context.originalPlan.current ? "Current" : "Superseded"}</Badge></TabsTrigger> : null}
                  {context.materiality ? <TabsTrigger value="materiality">Materiality <Badge variant="secondary">{context.materiality.routine ? "Routine" : "Material"}</Badge></TabsTrigger> : null}
                  {hasDecisions ? <TabsTrigger value="decisions">Decisions</TabsTrigger> : null}
                  {task.developerExecutionHistory.length ? <TabsTrigger value="development">Development</TabsTrigger> : null}
                  <TabsTrigger value="invocations">Invocations</TabsTrigger>
                </TabsList>
                {context.originalPlan ? <TabsContent value="original-plan">{context.originalPlan.content}</TabsContent> : null}
                {context.materiality ? <TabsContent value="materiality">{context.materiality.content}</TabsContent> : null}
                {hasDecisions ? <TabsContent value="decisions" className="space-y-4 text-xs">
                  {context.memberDecision}
                  {task.planHistory.map((entry) => <div key={`plan-${entry.revision}`}>Plan r{entry.revision} · {entry.kind} · {entry.summary} · {artifact(entry.outputArtifactId, "plan")} · {artifact(entry.evidenceArtifactId, "evidence")}</div>)}
                  {task.planDecisionHistory.map((entry) => <div key={entry.id}>Plan r{entry.planRevision} · {entry.decision} · {artifact(entry.noteArtifactId, "decision note")}</div>)}
                  {task.revisionHistory.map((entry) => <div key={entry.id}>Request r{entry.requestRevision} · {entry.disposition} · {entry.status} · {entry.blockerCode ?? entry.branchName ?? entry.exactBaseSha ?? "coordinates recorded"} · {artifact(entry.reasonArtifactId, "revision reason")}</div>)}
                  {task.deliveryReviewHistory.map((entry) => <div key={entry.id}>Plan r{entry.planRevision} · cycle {entry.repairCycle} · {entry.outcome} · {entry.summary} · {artifact(entry.opinionArtifactId, "review")} · {artifact(entry.evidenceArtifactId, "evidence")}</div>)}
                </TabsContent> : null}
                {task.developerExecutionHistory.length ? <TabsContent value="development" className="space-y-2 text-xs">{task.developerExecutionHistory.map((entry) => <div key={entry.id}>Plan r{entry.planRevision} · attempt {entry.attempt} · {entry.status} · {entry.branchName} · {entry.resultCommit ?? entry.failureSummary ?? "no result"}{entry.deliveryArtifactId ? <> · {artifact(entry.deliveryArtifactId, "delivery")}</> : null}{entry.evidenceArtifactId ? <> · {artifact(entry.evidenceArtifactId, "evidence")}</> : null}</div>)}</TabsContent> : null}
                <TabsContent value="invocations">
                  <div className="mb-3 text-xs text-muted-foreground">{task.agentInvocations.length} agent {task.agentInvocations.length === 1 ? "attempt" : "attempts"}</div>
                  <TaskInvocations invocations={task.agentInvocations} />
                </TabsContent>
              </Tabs>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </section>
  );
}
