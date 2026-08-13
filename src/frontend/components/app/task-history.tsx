import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../ui/accordion.js";
import { Separator } from "../ui/separator.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.js";
import { Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from "../ui/timeline.js";
import { TaskInvocations, type TaskInvocation } from "./task-invocations.js";
import { TaskStatus } from "./task-status.js";
import { withCompany } from "../../lib/api.js";
import type { IssuePhase } from "../../../issue-phases.js";

type TaskActivityEntry = {
  id: string;
  revision: number;
  eventType: string;
  createdAt: string;
};

type LinkedTask = { id: string; title: string; phase: IssuePhase; issueKey: string | null };
type DurableTaskHistory = {
  id: string;
  timeline: TaskActivityEntry[];
  agentInvocations: TaskInvocation[];
  planHistory: Array<{ revision: number; kind: string; summary: string; outputArtifactId: string; evidenceArtifactId: string }>;
  planDecisionHistory: Array<{ id: string; planRevision: number; decision: string; noteArtifactId: string }>;
  revisionHistory: Array<{ id: string; requestRevision: number; disposition: string; status: string; blockerCode: string | null; branchName: string | null; exactBaseSha: string | null; reasonArtifactId: string }>;
  developerExecutionHistory: Array<{ id: string; planRevision: number; attempt: number; status: string; branchName: string; resultCommit: string | null; failureSummary: string | null; deliveryArtifactId: string | null; evidenceArtifactId: string | null }>;
  deliveryReviewHistory: Array<{ id: string; planRevision: number; repairCycle: number; outcome: string; summary: string; opinionArtifactId: string; evidenceArtifactId: string }>;
  predecessor?: LinkedTask | undefined;
  successor?: LinkedTask | undefined;
};

function activityDate(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

export function TaskHistory({ task, companyId }: { task: DurableTaskHistory; companyId: string }) {
  const planCount = task.planHistory.length + task.planDecisionHistory.length;
  const durableCount = planCount + task.revisionHistory.length + task.developerExecutionHistory.length + task.deliveryReviewHistory.length;
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
              {durableCount ? <Accordion multiple>
                {planCount ? <AccordionItem value="plans"><AccordionTrigger>Plans and decisions · {planCount}</AccordionTrigger><AccordionContent><div className="space-y-2 text-xs">{task.planHistory.map((entry) => <div key={`plan-${entry.revision}`}>Plan r{entry.revision} · {entry.kind} · {entry.summary} · {artifact(entry.outputArtifactId, "plan")} · {artifact(entry.evidenceArtifactId, "evidence")}</div>)}{task.planDecisionHistory.map((entry) => <div key={entry.id}>Plan r{entry.planRevision} · {entry.decision} · {artifact(entry.noteArtifactId, "decision note")}</div>)}</div></AccordionContent></AccordionItem> : null}
                {task.revisionHistory.length ? <AccordionItem value="revisions"><AccordionTrigger>Plan revisions · {task.revisionHistory.length}</AccordionTrigger><AccordionContent><div className="space-y-2 text-xs">{task.revisionHistory.map((entry) => <div key={entry.id}>Request r{entry.requestRevision} · {entry.disposition} · {entry.status} · {entry.blockerCode ?? entry.branchName ?? entry.exactBaseSha ?? "coordinates recorded"} · {artifact(entry.reasonArtifactId, "revision reason")}</div>)}</div></AccordionContent></AccordionItem> : null}
                {task.developerExecutionHistory.length ? <AccordionItem value="development"><AccordionTrigger>Development · {task.developerExecutionHistory.length}</AccordionTrigger><AccordionContent><div className="space-y-2 text-xs">{task.developerExecutionHistory.map((entry) => <div key={entry.id}>Plan r{entry.planRevision} · attempt {entry.attempt} · {entry.status} · {entry.branchName} · {entry.resultCommit ?? entry.failureSummary ?? "no result"}{entry.deliveryArtifactId ? <> · {artifact(entry.deliveryArtifactId, "delivery")}</> : null}{entry.evidenceArtifactId ? <> · {artifact(entry.evidenceArtifactId, "evidence")}</> : null}</div>)}</div></AccordionContent></AccordionItem> : null}
                {task.deliveryReviewHistory.length ? <AccordionItem value="reviews"><AccordionTrigger>Delivery reviews · {task.deliveryReviewHistory.length}</AccordionTrigger><AccordionContent><div className="space-y-2 text-xs">{task.deliveryReviewHistory.map((entry) => <div key={entry.id}>Plan r{entry.planRevision} · cycle {entry.repairCycle} · {entry.outcome} · {entry.summary} · {artifact(entry.opinionArtifactId, "review")} · {artifact(entry.evidenceArtifactId, "evidence")}</div>)}</div></AccordionContent></AccordionItem> : null}
              </Accordion> : null}
              <Separator />
              <Tabs defaultValue="activity">
                <TabsList>
                  <TabsTrigger value="activity">Activity</TabsTrigger>
                  <TabsTrigger value="invocations">Invocations</TabsTrigger>
                </TabsList>
                <TabsContent value="activity">
                  <div className="mb-3 text-xs text-muted-foreground">{task.timeline.length} workflow {task.timeline.length === 1 ? "change" : "changes"}</div>
                  <div data-task-activity>
                    <Timeline orientation="vertical" value={task.timeline.length}>
                      {task.timeline.map((entry, index) => (
                        <TimelineItem key={entry.id} step={index + 1}>
                          <TimelineHeader>
                            <TimelineSeparator />
                            <TimelineDate dateTime={entry.createdAt}>{activityDate(entry.createdAt)}</TimelineDate>
                            <TimelineTitle>{entry.eventType}</TimelineTitle>
                            <TimelineIndicator />
                          </TimelineHeader>
                          <TimelineContent>revision {entry.revision}</TimelineContent>
                        </TimelineItem>
                      ))}
                    </Timeline>
                  </div>
                </TabsContent>
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
