import { expect, test } from "vitest";

import type { ApiProfile } from "../src/frontend/shell/view-shared.js";
import { agentsDraftFindings, agentsProjectPatch, generalProjectPatch, type AgentsDraft } from "../src/frontend/features/projects/project-details-model.js";
import type { ProjectProviderPolicy } from "../src/projects/provider-policy.js";

const profiles: ApiProfile[] = [
  { id: "root-claude-default", name: "Claude default", role: "root", provider: "claude-code", model: "claude-sonnet-4", reasoningLevel: "medium", serviceTier: "default", avatarSeed: "a".repeat(32), archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "root-codex", name: "Codex", role: "root", provider: "codex", model: "gpt-5.4", reasoningLevel: "medium", serviceTier: "default", avatarSeed: "b".repeat(32), archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "worker-codex", name: "Worker Codex", role: "worker", provider: "codex", model: "gpt-5.4", reasoningLevel: "medium", serviceTier: "default", avatarSeed: "c".repeat(32), archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
];

const unrestricted: AgentsDraft = { rootProfileId: "root-claude-default", workerProfileId: "worker-codex", providerPolicy: null };

test("General saves send only edited project fields", () => {
  const saved = { name: "Forge", baseBranch: "main" };

  expect(generalProjectPatch(saved, { ...saved, name: "Forge renamed" })).toEqual({ name: "Forge renamed" });
  expect(generalProjectPatch(saved, { ...saved, baseBranch: "release" })).toEqual({ baseBranch: "release" });
  expect(generalProjectPatch(saved, saved)).toEqual({});
});

test("Agents allow a system login when its provider row is checked", () => {
  const providerPolicy: ProjectProviderPolicy = { allowedProviders: ["claude-code", "codex"], allowedInstanceIds: [] };

  expect(agentsDraftFindings({ ...unrestricted, providerPolicy }, profiles)).toEqual([]);
});

test("Agents block a system login when its provider row is unchecked", () => {
  const providerPolicy: ProjectProviderPolicy = { allowedProviders: ["codex"], allowedInstanceIds: [] };

  expect(agentsDraftFindings({ ...unrestricted, providerPolicy }, profiles)).toEqual([{ field: "rootProfileId", message: "Select an agent with a provider and login allowed by this project" }]);
});

test("Agents block an empty default profile ID", () => {
  const draft = { ...unrestricted, rootProfileId: "" };

  expect(agentsDraftFindings(draft, profiles)).toEqual([{ field: "rootProfileId", message: "Select an agent with a provider and login allowed by this project" }]);
});

test("Agents defer to the server when profiles have not loaded", () => {
  const providerPolicy: ProjectProviderPolicy = { allowedProviders: ["codex"], allowedInstanceIds: [] };
  const draft = { ...unrestricted, providerPolicy };

  expect(agentsDraftFindings(draft, [])).toEqual([]);
});

test("Agents defer to the server when a default profile is missing locally", () => {
  const providerPolicy: ProjectProviderPolicy = { allowedProviders: ["codex"], allowedInstanceIds: [] };
  const draft = { ...unrestricted, rootProfileId: "unknown-root", providerPolicy };

  expect(agentsDraftFindings(draft, profiles)).toEqual([]);
});

test("Agents send an allowed new Coordinator with the new policy", () => {
  const providerPolicy: ProjectProviderPolicy = { allowedProviders: ["codex"], allowedInstanceIds: [] };
  const draft = { ...unrestricted, rootProfileId: "root-codex", providerPolicy };

  expect(agentsDraftFindings(draft, profiles)).toEqual([]);
  expect(agentsProjectPatch(unrestricted, draft)).toEqual({ rootProfileId: "root-codex", providerPolicy });
});

test("Agents have no findings when the provider policy does not change", () => {
  expect(agentsDraftFindings(unrestricted, profiles)).toEqual([]);
});
