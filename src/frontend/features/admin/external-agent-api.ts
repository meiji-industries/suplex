import { readJson, readJsonUnchecked } from "../../lib/api.js";
import type { ExternalAgentResult } from "../../contracts/generated/ExternalAgentResult.js";

const agentPath = (agentId: string): string => `/api/admin/external-agents/${encodeURIComponent(agentId)}`;

export function replaceExternalAgentProjects(agentId: string, projectIds: string[]): Promise<ExternalAgentResult> {
  return readJsonUnchecked<ExternalAgentResult>(`${agentPath(agentId)}/projects`, { method: "PUT", body: JSON.stringify({ projectIds }) });
}

/** Let the agent answer Coordinator questions on the current administrator's behalf, or stop it. */
export function setExternalAgentAnswerGrant(agentId: string, granted: boolean): Promise<ExternalAgentResult> {
  return readJsonUnchecked<ExternalAgentResult>(`${agentPath(agentId)}/answer-grant`, { method: "PUT", body: JSON.stringify({ granted }) });
}

/** Let the agent manage and run Moves, or stop it. */
export function setExternalAgentMovesGrant(agentId: string, granted: boolean): Promise<ExternalAgentResult> {
  return readJsonUnchecked<ExternalAgentResult>(`${agentPath(agentId)}/moves-grant`, { method: "PUT", body: JSON.stringify({ granted }) });
}

/** Revocation answers 204 with no body. */
export async function revokeExternalAgent(agentId: string): Promise<void> {
  await readJson(`${agentPath(agentId)}/revoke`, { method: "POST", body: "{}" });
}
