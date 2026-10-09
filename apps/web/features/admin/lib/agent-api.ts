import { readJsonUnchecked } from "../../../lib/api.js";
import type { ApiProfile } from "../../../shell/view-shared.js";

export type AgentProfileChanges = Partial<Pick<ApiProfile, "provider" | "model" | "reasoningLevel">>;

export async function updateAgentProfile(id: string, changes: AgentProfileChanges): Promise<void> {
  await readJsonUnchecked(`/api/admin/profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) });
}
