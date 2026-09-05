import { useEffect, useState } from "react";
import { GitPullRequest } from "lucide-react";
import type { z } from "zod";
import { TaskChecksResponseSchema } from "../../../http/contracts/tasks.js";
import { readJson } from "../../lib/api.js";

type Checks = z.infer<typeof TaskChecksResponseSchema>;

export function pullRequestColor(state: string, checks: Checks | null): "purple" | "red" | "yellow" | "green" | "grey" {
  const observed = checks?.available ? checks.pullRequestState ?? state : state;
  if (state === "merged" || observed === "merged") return "purple";
  if (observed === "closed") return "grey";
  const runs = checks?.available ? checks.runs : [];
  if (runs.some(run => run.status === "failing")) return "red";
  if (runs.some(run => run.status === "pending")) return "yellow";
  if (observed === "ready" || runs.length > 0 && runs.every(run => run.status === "successful")) return "green";
  return "grey";
}

const colors = { purple: "text-purple-500", red: "text-red-500", yellow: "text-yellow-500", green: "text-green-500", grey: "text-muted-foreground" };

export function RecentPullRequest({ taskId, state, headSha }: { taskId: string; state: string; headSha: string }) {
  const [checks, setChecks] = useState<Checks | null>(null);
  useEffect(() => {
    setChecks(null);
    if (state === "merged") return;
    let closed = false;
    let reading = false;
    const load = async () => {
      if (reading) return;
      reading = true;
      try { const result = TaskChecksResponseSchema.parse(await readJson(`/api/tasks/${taskId}/checks`)); if (!closed) setChecks(result); }
      catch { if (!closed) setChecks(null); }
      finally { reading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => { closed = true; clearInterval(timer); };
  }, [taskId, state, headSha]);
  const color = pullRequestColor(state, checks);
  const label = color === "red" ? "CI failed" : color === "yellow" ? "CI in progress" : color === "purple" ? "Merged" : color === "green" ? "Ready or CI passed" : "No passing CI result";
  return <span data-recent-pull-request={state} data-pr-color={color} className={`inline-flex size-4 shrink-0 items-center justify-center ${colors[color]}`} title={label}><GitPullRequest aria-label={label} className="size-4" /></span>;
}
