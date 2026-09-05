import { readFile } from "node:fs/promises";

import {
  CodexRolloutLineSchema,
  discoverRollout,
  rolloutCandidatePaths,
} from "./codex-rollout.js";
import { json } from "./task-utils.js";

export type NativeWorkerTurnObservation =
  | { kind: "unknown" }
  | { kind: "missing" }
  | { kind: "accepted" }
  | { kind: "completed"; receiptId: string; nativeTurnId: string; evidence: string };

function messageText(payload: Record<string, unknown>): string {
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.content === "string") return payload.content;
  if (!Array.isArray(payload.content)) return "";
  return payload.content.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    return typeof record.text === "string" ? [record.text] : [];
  }).join("\n");
}

export function createNativeWorkerTurnObserver(candidates: () => Promise<string[]>) {
  return (input: Omit<NativeWorkerTurnObserverInput, "candidates">) => observeNativeWorkerTurn({ ...input, candidates });
}

export async function observeNativePromptMarker(input: { cwd: string; nativeSessionId: string; marker: string }): Promise<"accepted" | "missing" | "unknown"> {
  let source: string;
  try {
    const candidate = await discoverRollout(await rolloutCandidatePaths(), { cwd: input.cwd, sessionId: input.nativeSessionId });
    source = await readFile(candidate.path, "utf8");
  } catch {
    return "unknown";
  }
  if (!source.endsWith("\n")) return "unknown";
  for (const line of source.split("\n")) {
    if (!line) continue;
    const parsed = CodexRolloutLineSchema.safeParse(json(line, undefined));
    if (!parsed.success) return "unknown";
    const payload = parsed.data.payload;
    if (payload && typeof payload === "object" && messageText(payload as Record<string, unknown>).includes(input.marker)) return "accepted";
  }
  return "missing";
}

type NativeWorkerTurnObserverInput = {
  cwd: string;
  nativeSessionId: string;
  assignmentMarker: string;
  candidates?: () => Promise<string[]>;
};

export async function observeNativeWorkerTurn(input: NativeWorkerTurnObserverInput): Promise<NativeWorkerTurnObservation> {
  let source: string;
  try {
    const candidate = await discoverRollout(
      await (input.candidates ?? (() => rolloutCandidatePaths()))(),
      { cwd: input.cwd, sessionId: input.nativeSessionId },
    );
    source = await readFile(candidate.path, "utf8");
  } catch {
    return { kind: "unknown" };
  }

  if (!source.endsWith("\n")) return { kind: "unknown" };
  let accepted = false;
  let activeTurnId: string | null = null;
  let assignmentTurnId: string | null = null;
  let completedTurnId: string | null = null;
  let lastAgentMessage = "";
  for (const line of source.split("\n")) {
    if (!line) continue;
    const parsed = CodexRolloutLineSchema.safeParse(json(line, undefined));
    if (!parsed.success) return { kind: "unknown" };
    const payload = parsed.data.payload;
    if (!payload || typeof payload !== "object") continue;
    const record = payload as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const role = typeof record.role === "string" ? record.role : "";
    const text = messageText(record);
    if (type === "task_started" && typeof record.turn_id === "string") activeTurnId = record.turn_id;
    if (!accepted && (type === "user_message" || role === "user") && text.includes(input.assignmentMarker)) {
      accepted = true;
      assignmentTurnId = activeTurnId;
      continue;
    }
    if (!accepted) continue;
    if (!assignmentTurnId && type === "task_started" && typeof record.turn_id === "string") assignmentTurnId = record.turn_id;
    if (assignmentTurnId && activeTurnId === assignmentTurnId && (type === "agent_message" || role === "assistant" || role === "output") && text) lastAgentMessage = text;
    if (type === "task_complete" && typeof record.turn_id === "string" && record.turn_id === assignmentTurnId) {
      if (typeof record.error === "string") return { kind: "accepted" };
      completedTurnId = record.turn_id;
      break;
    }
  }
  if (!accepted) return { kind: "missing" };
  if (!completedTurnId) return { kind: "accepted" };
  return {
    kind: "completed",
    nativeTurnId: completedTurnId,
    receiptId: `${input.nativeSessionId}:${completedTurnId}`,
    evidence: lastAgentMessage.slice(-4000) || "Native Codex turn completed.",
  };
}
