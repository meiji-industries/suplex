import { useEffect, useState } from "react";
import type { z } from "zod";
import { TaskChecksResponseSchema } from "../../../contracts/task-responses.js";
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

function formatRunningCheckDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remainderSeconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return `${hours}h ${String(remainderMinutes).padStart(2, "0")}m`;
}

export function checkRunLabel(run: CheckRun, now = Date.now()): string {
  const status = checkRunStatus(run);
  if (status === "pending") {
    const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
    return Number.isFinite(started) ? `Running ${formatRunningCheckDuration(now - started)}` : "Pending";
  }
  if (status === "skipped") return "Skipped";
  if (status === "neutral") return "Neutral";
  const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const completed = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
  const duration = Number.isFinite(started) && Number.isFinite(completed) && completed > started ? ` in ${formatCheckDuration(completed - started)}` : "";
  return `${status === "passed" ? "Passed" : "Failed"}${duration}`;
}

type ChecksObservation = { checks: TaskChecks | null; error: string };
const emptyObservation: ChecksObservation = { checks: null, error: "" };

class ChecksPoll {
  private readonly subscribers = new Set<(value: ChecksObservation, key: unknown) => void>();
  private observation = emptyObservation;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reading = false;
  private invalidated = false;
  private disposed = false;
  private refreshKey: unknown;
  private revision = 0;

  constructor(private readonly taskId: string, refreshKey: unknown) {
    this.refreshKey = refreshKey;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  subscribe(listener: (value: ChecksObservation, key: unknown) => void): () => void {
    this.subscribers.add(listener);
    listener(this.observation, this.refreshKey);
    if (this.subscribers.size === 1) this.load();
    return () => {
      this.subscribers.delete(listener);
      if (this.subscribers.size !== 0) return;
      this.disposed = true;
      clearTimeout(this.timer);
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      polls.delete(this.taskId);
    };
  }

  refresh(key: unknown): void {
    if (Object.is(key, this.refreshKey)) return;
    this.refreshKey = key;
    this.revision += 1;
    this.publish(emptyObservation);
    this.load();
  }

  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "visible") this.load();
    else clearTimeout(this.timer);
  };

  private load(): void {
    if (this.disposed || document.visibilityState === "hidden") return;
    if (this.reading) { this.invalidated = true; return; }
    clearTimeout(this.timer);
    this.reading = true;
    this.invalidated = false;
    const revision = this.revision;
    void (async () => {
      try {
        const checks = TaskChecksResponseSchema.parse(await readJson(`/api/tasks/${this.taskId}/checks`));
        if (!this.disposed && revision === this.revision) this.publish({ checks, error: "" });
      } catch (cause) {
        if (!this.disposed && revision === this.revision) this.publish({ checks: this.observation.checks, error: cause instanceof Error ? cause.message : "Checks are not available" });
      } finally {
        this.reading = false;
        if (this.disposed || document.visibilityState === "hidden") return;
        if (this.invalidated) {
          this.invalidated = false;
          this.load();
        } else {
          const pending = this.observation.error !== "" || this.observation.checks?.runs.some(run => checkRunStatus(run) === "pending");
          this.timer = setTimeout(() => this.load(), pending ? 15_000 : 60_000);
        }
      }
    })();
  }

  private publish(observation: ChecksObservation): void {
    this.observation = observation;
    for (const subscriber of this.subscribers) subscriber(observation, this.refreshKey);
  }
}

const polls = new Map<string, ChecksPoll>();

export function useTaskChecks(taskId: string | null, refreshKey?: unknown): { checks: TaskChecks | null; error: string } {
  const [state, setState] = useState<{ taskId: string | null; refreshKey: unknown; observation: ChecksObservation }>({ taskId: null, refreshKey: undefined, observation: emptyObservation });
  useEffect(() => {
    if (taskId === null) return;
    const poll = polls.get(taskId) ?? new ChecksPoll(taskId, refreshKey);
    polls.set(taskId, poll);
    return poll.subscribe((observation, key) => setState({ taskId, refreshKey: key, observation }));
  }, [taskId]);
  useEffect(() => {
    if (taskId !== null) polls.get(taskId)?.refresh(refreshKey);
  }, [taskId, refreshKey]);
  return state.taskId === taskId && Object.is(state.refreshKey, refreshKey) ? state.observation : emptyObservation;
}
