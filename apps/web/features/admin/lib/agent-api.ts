import { readJsonUnchecked } from "../../../lib/api.js";
import type { ProfileDefaults } from "../../../contracts/generated/ProfileDefaults.js";
import type { ApiProfile } from "../../../shell/view-shared.js";

export type AgentProfileChanges = Partial<Pick<ApiProfile, "provider" | "model" | "reasoningLevel">>;

/** A role slot with one default agent for new projects. */
export type DefaultSlot = keyof ProfileDefaults;

export async function updateAgentProfile(id: string, changes: AgentProfileChanges): Promise<void> {
  await readJsonUnchecked(`/api/admin/profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(changes) });
}

/** The agent that each slot of a new project receives. */
export function readProfileDefaults(signal?: AbortSignal): Promise<ProfileDefaults> {
  return readJsonUnchecked<ProfileDefaults>("/api/profiles/defaults", signal ? { signal } : undefined);
}

/** Make the agent the default for the slot. Existing projects keep their agents. */
export function setDefaultAgent(id: string, slot: DefaultSlot): Promise<ProfileDefaults> {
  return readJsonUnchecked<ProfileDefaults>(`/api/admin/profiles/${encodeURIComponent(id)}/default`, { method: "POST", body: JSON.stringify({ slot }) });
}
