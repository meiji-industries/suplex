import { type UpdateResponse } from "../../contracts/updates.js";

export type UpdateNoticeState =
  | { kind: "available"; message: string }
  | { kind: "progress"; message: string }
  | { kind: "failure"; message: string };

export type RestartAttempt = { userId: string; instanceId?: string };
export type RestartObservation = "reload" | "settled" | "wait";

export function observeRestart(attempt: RestartAttempt, update: UpdateResponse): RestartObservation {
  if (attempt.instanceId && update.instanceId && update.instanceId !== attempt.instanceId) return "reload";
  if (update.status.kind === "failed" && update.status.action === "apply") return "settled";
  if (update.status.kind === "available" || update.status.kind === "current") return "settled";
  return "wait";
}

export function selectUpdateNotice(update: UpdateResponse): UpdateNoticeState | undefined {
  if (update.status.kind === "available") return { kind: "available", message: "Suplex update available." };
  if (update.status.kind === "applying") return { kind: "progress", message: update.status.message };
  if (update.status.kind === "failed" && update.status.action === "apply") return { kind: "failure", message: update.status.message };
  return undefined;
}
