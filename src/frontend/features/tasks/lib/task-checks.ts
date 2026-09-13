import { useEffect, useState } from "react";
import type { z } from "zod";
import { TaskChecksResponseSchema } from "../../../../http/contracts/tasks.js";
import { readJson } from "../../../lib/api.js";

export type TaskChecks = z.infer<typeof TaskChecksResponseSchema>;
export type CheckRun = TaskChecks["runs"][number];
export type CheckRunStatus = "passed" | "failed" | "pending" | "skipped" | "neutral";

export function checkRunStatus(run: CheckRun): CheckRunStatus {
  if (run.conclusion === "SKIPPED") return "skipped";
  if (run.conclusion === "NEUTRAL") return "neutral";
  return run.status === "successful" ? "passed" : run.status === "failing" ? "failed" : "pending";
}

export function checkRunName(run: CheckRun): string {
  if (!run.workflow || run.name.includes(" / ")) return run.name;
  return `${run.workflow} / ${run.name}`;
}

function formatCheckDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

export function checkRunLabel(run: CheckRun): string {
  const status = checkRunStatus(run);
  if (status === "pending") return "Pending";
  if (status === "skipped") return "Skipped";
  if (status === "neutral") return "Neutral";
  const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const completed = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
  const duration = Number.isFinite(started) && Number.isFinite(completed) && completed > started ? ` in ${formatCheckDuration(completed - started)}` : "";
  return `${status === "passed" ? "Passed" : "Failed"}${duration}`;
}

/** Polls the task checks endpoint while taskId is set; pass null to disable (for example, a merged pull request). */
export function useTaskChecks(taskId: string | null, refreshKey?: unknown): { checks: TaskChecks | null; error: string } {
  const [checks, setChecks] = useState<TaskChecks | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setChecks(null);
    setError("");
    if (taskId === null) return;
    let closed = false;
    let reading = false;
    const load = async () => {
      if (reading) return;
      reading = true;
      try {
        const result = TaskChecksResponseSchema.parse(await readJson(`/api/tasks/${taskId}/checks`));
        if (!closed) { setChecks(result); setError(""); }
      } catch (cause) {
        if (!closed) setError(cause instanceof Error ? cause.message : "Checks are not available");
      } finally { reading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => { closed = true; clearInterval(timer); };
  }, [taskId, refreshKey]);
  return { checks, error };
}
