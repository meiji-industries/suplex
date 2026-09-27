import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { CostValue } from "../../components/app/cost-value.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table.js";
import { Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from "../../components/ui/timeline.js";
import type { TaskLimitDecision } from "../../contracts/task-limits.js";
import type { Today, TodayTask } from "../../contracts/today.js";
import { isApiError, withCompany } from "../../lib/api.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { taskDeliveryResultLabels } from "../tasks/task-delivery-target.js";
import { runTaskAction } from "../tasks/lib/task-api.js";
import { TaskQuestion } from "../tasks/task-question.js";
import { TaskStatus } from "../tasks/task-status.js";
import { currentLocalWeek, getToday } from "./lib/today-api.js";

function dateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function TaskIdentity({ task }: { task: TodayTask }): ReactElement {
  const { selectCompany } = useCompanyContext();
  return <div className="min-w-0"><a className="block truncate font-medium hover:underline" href={withCompany(`/tasks/${task.taskId}`, task.companyId)} onClick={() => selectCompany(task.companyId)}>{task.issueKey ? `${task.issueKey} · ` : ""}{task.title}</a><div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"><EntityAvatar kind="company" id={task.companyId} name={task.companyName} size="xs" /><span>{task.companyName}</span><span aria-hidden="true">·</span><span>{task.projectName}</span></div></div>;
}

function Empty({ children }: { children: string }): ReactElement {
  return <p className="px-4 py-5 text-sm text-muted-foreground">{children}</p>;
}

function ActiveTable({ tasks }: { tasks: TodayTask[] }): ReactElement {
  return <Table><TableHeader><TableRow><TableHead>Task</TableHead><TableHead>Status</TableHead><TableHead>Updated</TableHead></TableRow></TableHeader><TableBody>{tasks.map(task => <TableRow key={task.taskId}><TableCell><TaskIdentity task={task} /></TableCell><TableCell><TaskStatus status={task.status} /></TableCell><TableCell><span className="whitespace-nowrap text-xs text-muted-foreground">{dateTime(task.lastUpdated)}</span></TableCell></TableRow>)}</TableBody></Table>;
}

function ShippedTimeline({ tasks }: { tasks: TodayTask[] }): ReactElement {
  return <div className="px-6 py-4"><Timeline defaultValue={tasks.length}>{tasks.map((task, index) => <TimelineItem step={index + 1} key={task.taskId}><TimelineSeparator /><TimelineIndicator /><TimelineDate dateTime={task.shippedAt ?? undefined}>{dateTime(task.shippedAt ?? task.lastUpdated)}</TimelineDate><TimelineHeader><TimelineTitle><TaskIdentity task={task} /></TimelineTitle></TimelineHeader><TimelineContent><Badge variant="green">{taskDeliveryResultLabels[task.deliveryTarget]}</Badge></TimelineContent></TimelineItem>)}</Timeline></div>;
}

function NeedsYou({ tasks, pending, errors, answer, decide }: {
  tasks: TodayTask[];
  pending: ReadonlySet<string>;
  errors: ReadonlyMap<string, string>;
  answer: (task: TodayTask, value: { answer: string; confirmCommandsStopped: boolean }) => Promise<void>;
  decide: (task: TodayTask, decision: TaskLimitDecision) => Promise<void>;
}): ReactElement {
  return <div className="divide-y">{tasks.map(task => task.humanQuestion ? <article className="grid gap-4 p-4 lg:grid-cols-[minmax(13rem,18rem)_minmax(0,1fr)]" key={`${task.taskId}:${task.humanQuestion.id}`}><div className="space-y-2"><TaskIdentity task={task} /><TaskStatus status={task.status} /><p className="text-xs text-muted-foreground">Updated {dateTime(task.lastUpdated)}</p></div><div className="min-w-0"><TaskQuestion question={task.humanQuestion} busy={pending.has(task.taskId)} onAnswer={value => answer(task, value)} onLimitDecision={decision => decide(task, decision)} />{errors.get(task.taskId) ? <p className="mt-2 text-xs text-destructive" role="alert">{errors.get(task.taskId)}</p> : null}</div></article> : null)}</div>;
}

export function TodayView(): ReactElement {
  const [today, setToday] = useState<Today>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [answerErrors, setAnswerErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const loadSequence = useRef(0);
  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const sequence = ++loadSequence.current;
    try {
      const result = await getToday(currentLocalWeek(new Date()), signal);
      if (sequence === loadSequence.current) { setToday(result); setError(""); }
    } catch (reason) {
      if (!signal?.aborted && sequence === loadSequence.current) setError(isApiError(reason) ? reason.message : "Today is not available");
    } finally {
      if (!signal?.aborted && sequence === loadSequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = window.setInterval(() => void load(controller.signal), 30_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [load]);
  const act = async (task: TodayTask, body: unknown): Promise<void> => {
    if (pending.has(task.taskId)) return;
    setPending(current => new Set(current).add(task.taskId));
    setAnswerErrors(current => { const next = new Map(current); next.delete(task.taskId); return next; });
    try {
      await runTaskAction(task.taskId, "answer", body);
      ++loadSequence.current;
      setToday(current => current ? { ...current, needsYou: current.needsYou.filter(row => row.taskId !== task.taskId) } : current);
      await load();
    } catch (reason) {
      if (isApiError(reason, 409)) await load();
      setAnswerErrors(current => new Map(current).set(task.taskId, isApiError(reason) ? reason.message : "Suplex could not save the answer"));
    } finally {
      setPending(current => { const next = new Set(current); next.delete(task.taskId); return next; });
    }
  };
  const week = today ? { startsAt: today.weekStartsAt, endsAt: today.weekEndsAt } : currentLocalWeek(new Date());
  const range = `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(week.startsAt))}–${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(new Date(week.endsAt).getTime() - 1))}`;
  const counts = today ? [{ label: "Needs you", value: today.needsYou.length }, { label: "In progress", value: today.inProgress.length }, { label: "Shipped", value: today.shippedThisWeek.length }] : [];
  const scope = <span className="flex items-center gap-2"><Badge variant="outline">All companies</Badge>{today ? <span className="text-xs text-muted-foreground">{today.companies.length}</span> : null}</span>;
  const retry = error ? <div className="flex items-center gap-3 border-b px-4 py-2"><p className="min-w-0 flex-1 text-sm text-destructive" role="alert">{error}</p><Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button></div> : null;
  return <ApplicationFrame title="Today" headerActions={scope}><div className="min-h-0 flex-1 overflow-y-auto">{retry}<div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">{counts.map(item => <Badge key={item.label} variant={item.label === "Needs you" && item.value ? "amber" : "outline"}>{item.label} {item.value}</Badge>)}<span className="ml-auto text-xs text-muted-foreground">{range} · Local time</span></div>{loading && !today ? <p className="p-4 text-sm text-muted-foreground" role="status">Today is loading</p> : today ? <div className="grid min-w-0 lg:grid-cols-2"><section className="min-w-0 border-b lg:col-span-2" aria-labelledby="today-needs-you"><div className="flex items-center gap-2 border-b px-4 py-2"><h2 className="text-sm font-medium" id="today-needs-you">Needs you</h2><Badge variant={today.needsYou.length ? "amber" : "outline"}>{today.needsYou.length}</Badge></div>{today.needsYou.length ? <NeedsYou tasks={today.needsYou} pending={pending} errors={answerErrors} answer={(task, value) => act(task, { questionId: task.humanQuestion?.id, ...value })} decide={(task, limitDecision) => act(task, { questionId: task.humanQuestion?.id, limitDecision })} /> : <Empty>No tasks need an answer.</Empty>}</section><section className="min-w-0 border-b lg:border-r" aria-labelledby="today-in-progress"><div className="flex items-center gap-2 border-b px-4 py-2"><h2 className="text-sm font-medium" id="today-in-progress">In progress</h2><Badge variant="outline">{today.inProgress.length}</Badge></div>{today.inProgress.length ? <ActiveTable tasks={today.inProgress} /> : <Empty>No tasks are in progress.</Empty>}</section><section className="min-w-0 border-b" aria-labelledby="today-shipped"><div className="flex items-center gap-2 border-b px-4 py-2"><h2 className="text-sm font-medium" id="today-shipped">Shipped this week</h2><Badge variant="outline">{today.shippedThisWeek.length}</Badge></div>{today.shippedThisWeek.length ? <ShippedTimeline tasks={today.shippedThisWeek} /> : <Empty>No tasks shipped this week.</Empty>}</section><section className="min-w-0 lg:col-span-2" aria-labelledby="today-spend"><div className="flex items-center gap-2 border-b px-4 py-2"><h2 className="text-sm font-medium" id="today-spend">Spend by client this week</h2></div><Table><TableHeader><TableRow><TableHead>Client</TableHead><TableHead>Estimated usage cost</TableHead><TableHead>Coverage</TableHead></TableRow></TableHeader><TableBody>{today.spendByCompany.map(spend => <TableRow key={spend.companyId}><TableCell><span className="flex items-center gap-2"><EntityAvatar kind="company" id={spend.companyId} name={spend.companyName} size="xs" />{spend.companyName}</span></TableCell><TableCell><CostValue value={spend.knownCostUsd} subsidized={spend.subsidized} partial={spend.partial} suffix={spend.partial && spend.knownCostUsd !== null ? "+" : ""} /></TableCell><TableCell>{spend.partial ? spend.unpricedMessages ? `${spend.unpricedMessages} unpriced` : "Partial" : spend.measuredMessages ? "Measured" : "No activity"}</TableCell></TableRow>)}</TableBody></Table></section></div> : null}</div></ApplicationFrame>;
}
