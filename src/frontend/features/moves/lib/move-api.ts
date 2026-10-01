import { readJsonUnchecked } from "../../../lib/api.js";
import type { MoveBody, MoveRunBody } from "../../../contracts/moves.js";
import type { MoveResponse } from "../../../contracts/generated/MoveResponse.js";
import type { MoveRunResponse } from "../../../contracts/generated/MoveRunResponse.js";
import type { MoveRunsResponse } from "../../../contracts/generated/MoveRunsResponse.js";
import type { MoveRunTranscript } from "../../../contracts/generated/MoveRunTranscript.js";
import type { MovesResponse } from "../../../contracts/generated/MovesResponse.js";
import type { ApiProfile } from "../../../shell/view-shared.js";

const movePath = (moveId: string, suffix = ""): string => `/api/moves/${encodeURIComponent(moveId)}${suffix}`;

export async function listMoves(companyId: string, signal?: AbortSignal): Promise<MoveResponse[]> {
  const result = await readJsonUnchecked<MovesResponse>(`/api/companies/${encodeURIComponent(companyId)}/moves`, signal ? { signal } : undefined);
  return result.moves;
}

export function createMove(companyId: string, body: MoveBody): Promise<MoveResponse> {
  return readJsonUnchecked<MoveResponse>(`/api/companies/${encodeURIComponent(companyId)}/moves`, { method: "POST", body: JSON.stringify(body) });
}

export function updateMove(moveId: string, body: MoveBody): Promise<MoveResponse> {
  return readJsonUnchecked<MoveResponse>(movePath(moveId), { method: "PATCH", body: JSON.stringify(body) });
}

export async function deleteMove(moveId: string): Promise<void> {
  await readJsonUnchecked<unknown>(movePath(moveId), { method: "DELETE" });
}

export async function listMoveRuns(moveId: string, signal?: AbortSignal): Promise<MoveRunResponse[]> {
  const result = await readJsonUnchecked<MoveRunsResponse>(movePath(moveId, "/runs"), signal ? { signal } : undefined);
  return result.runs;
}

export function startMove(moveId: string, body: MoveRunBody): Promise<MoveRunResponse> {
  return readJsonUnchecked<MoveRunResponse>(movePath(moveId, "/runs"), { method: "POST", body: JSON.stringify(body) });
}

export function getMoveRun(runId: string): Promise<MoveRunResponse> {
  return readJsonUnchecked<MoveRunResponse>(`/api/move-runs/${encodeURIComponent(runId)}`);
}

export async function endMoveRun(runId: string): Promise<void> {
  await readJsonUnchecked<unknown>(`/api/move-runs/${encodeURIComponent(runId)}/terminal`, { method: "DELETE" });
}

export async function listProfiles(): Promise<ApiProfile[]> {
  return (await readJsonUnchecked<{ profiles: ApiProfile[] }>("/api/profiles")).profiles;
}

export function getMoveRunTranscript(runId: string): Promise<MoveRunTranscript> {
  return readJsonUnchecked<MoveRunTranscript>(`/api/move-runs/${encodeURIComponent(runId)}/transcript`);
}

export async function archiveMoveRun(runId: string): Promise<void> {
  await readJsonUnchecked<unknown>(`/api/move-runs/${encodeURIComponent(runId)}/archive`, { method: "POST" });
}

export const moveRunTerminalPath = (runId: string): string => `/api/move-runs/${encodeURIComponent(runId)}/terminal`;
