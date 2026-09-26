import { type Task } from "../../contracts/tasks.js";
import type { TaskActivity } from "./task-work.js";
import { Button } from "../../components/ui/button.js";

export function TaskWorker({ task, activity, onSelect }: { task: Task; activity: TaskActivity; onSelect: () => void }) {
  const workers = activity.sessions.filter(session => session.kind === "worker" && !session.advisorRole);
  if (!workers.length) return null;
  const worker = workers.find(session => session.current);
  const eligible = !!worker && !task.archivedAt && (task.status === "active" || task.status === "waiting_human");
  const replacements = workers.filter(session => session.replacement);
  const number = (id: string) => workers.findIndex(session => session.id === id) + 1;
  return <section aria-label="Worker" className="grid gap-2 border-b pb-3">
    <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold">Worker{worker ? ` ${number(worker.id)}` : ""}</span><span className="text-xs text-muted-foreground">{task.workerProfile.model}</span>{eligible ? <Button type="button" variant="outline" size="sm" onClick={onSelect}>Select Worker</Button> : null}</div>
    {replacements.length ? <details><summary className="cursor-pointer text-xs">Worker replacements ({replacements.length})</summary><ul className="grid gap-2 pt-2 text-xs">{replacements.map(session => <li key={session.id}><span className="font-medium">Worker {number(session.replacement!.sessionId)} → Worker {number(session.id)}</span><p>{session.replacement!.reason}</p><details><summary className="cursor-pointer text-muted-foreground">Handoff</summary><p className="whitespace-pre-wrap">{session.replacement!.handoff}</p></details></li>)}</ul></details> : null}
  </section>;
}
