import { useEffect, useState, type ReactElement } from "react";
import { ApplicationFrame } from "../components/app/application-frame.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { readJson, withCompany } from "../lib/api.js";
import type { Task } from "../../task-contracts.js";

export function documentTitle(count: number): string {
  return count > 0 ? `(${count}) Forge` : "Forge";
}

export function AttentionView(): ReactElement {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    document.title = documentTitle(tasks.length);
    return () => { document.title = "Forge"; };
  }, [tasks.length]);
  useEffect(() => {
    let closed = false;
    const load = async () => { try { const result = await readJson<{ tasks: Task[] }>("/api/tasks"); if (!closed) { setTasks(result.tasks.filter(task => task.status === "waiting_human")); setError(""); } } catch (error) { if (!closed) setError(String(error)); } };
    void load();
    const timer = setInterval(() => void load(), 3_000);
    return () => { closed = true; clearInterval(timer); };
  }, []);
  return <ApplicationFrame title="Attention">{error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}<ul className="divide-y">{tasks.map(task => <li key={task.id}><a className="grid gap-1 p-3 text-sm hover:bg-muted" href={withCompany(`/tasks/${task.id}`, task.companyId)}><span>{task.issueKey} · {task.title}</span><span className="text-xs text-muted-foreground">{task.humanQuestion?.text}</span></a></li>)}</ul>{!tasks.length && !error ? <p className="p-3 text-sm">No answers necessary</p> : null}</ApplicationFrame>;
}
