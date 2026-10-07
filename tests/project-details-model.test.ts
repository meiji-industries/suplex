import { expect, test } from "vitest";

import type { ApiProfile } from "../src/frontend/shell/view-shared.js";
import { agentsDraftFindings, agentsProjectPatch, executionDraftFindings, executionProjectPatch, repositoryProvides, generalProjectPatch, type AgentsDraft, type ExecutionDraft } from "../src/frontend/features/projects/project-details-model.js";
import type { ProjectProviderPolicy } from "../src/frontend/contracts/provider-policy.js";

const profiles: ApiProfile[] = [
  { id: "root-claude-default", name: "Claude default", role: "root", provider: "claude-code", model: "claude-sonnet-4", reasoningLevel: "medium", serviceTier: "default", avatarSeed: "a".repeat(32), archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "root-codex", name: "Codex", role: "root", provider: "codex", model: "gpt-5.4", reasoningLevel: "medium", serviceTier: "default", avatarSeed: "b".repeat(32), archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "worker-codex", name: "Worker Codex", role: "worker", provider: "codex", model: "gpt-5.4", reasoningLevel: "medium", serviceTier: "default", avatarSeed: "c".repeat(32), archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
];

const unrestricted: AgentsDraft = { rootProfileId: "root-claude-default", workerProfileId: "worker-codex", altProfileId: "root-codex", providerPolicy: null };

test("General saves send only edited project fields", () => {
  const saved = { repository: "acme/suplex", name: "Suplex", baseBranch: "main", repositoryPath: "/repos/suplex" };

  expect(generalProjectPatch(saved, { ...saved, name: "Suplex renamed" })).toEqual({ name: "Suplex renamed" });
  expect(generalProjectPatch(saved, { ...saved, baseBranch: "release" })).toEqual({ baseBranch: "release" });
  expect(generalProjectPatch(saved, { ...saved, repositoryPath: "/repos/moved" })).toEqual({ repositoryPath: "/repos/moved" });
  expect(generalProjectPatch(saved, { ...saved, repository: "acme/renamed" })).toEqual({ repository: "acme/renamed" });
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


test("Alt Coordinator saves its own default and respects provider access", () => {
  const draft = { ...unrestricted, altProfileId: "root-claude-default" };
  expect(agentsProjectPatch(unrestricted, draft)).toEqual({ altProfileId: "root-claude-default" });
  expect(agentsDraftFindings({ ...draft, rootProfileId: "root-codex", providerPolicy: { allowedProviders: ["codex"], allowedInstanceIds: [] } }, profiles)).toEqual([{ field: "altProfileId", message: "Select an agent with a provider and login allowed by this project" }]);
});

test("Execution saves task concurrency as a number, or null when empty", () => {
  const saved: ExecutionDraft = { setupCommand: "", verificationCommand: "", instructions: "", skillDirectories: "", taskConcurrency: "" };

  expect(executionProjectPatch(saved, { ...saved, taskConcurrency: "1" })).toEqual({ taskConcurrency: 1 });
  expect(executionProjectPatch({ ...saved, taskConcurrency: "2" }, saved)).toEqual({ taskConcurrency: null });
  expect(executionProjectPatch(saved, { ...saved, taskConcurrency: " " })).toEqual({});
  expect(executionDraftFindings({ ...saved, taskConcurrency: "3" })).toEqual([]);
  for (const invalid of ["0", "-1", "1.5", "two"]) {
    expect(executionDraftFindings({ ...saved, taskConcurrency: invalid })).toEqual([{ field: "taskConcurrency", message: "Write a whole number of 1 or more." }]);
  }
});

test("repository fields disable editing and stay out of execution patches", () => {
  const saved: ExecutionDraft = { setupCommand: "install", verificationCommand: "check", instructions: "Build", skillDirectories: "", taskConcurrency: "1" };
  const settings = { path: ".suplex/settings.toml", fields: ["setup_command", "verification_command", "task_concurrency", "instructions"] as const, error: null };
  const repositorySettings = { ...settings, fields: [...settings.fields] };
  for (const field of settings.fields) expect(repositoryProvides(repositorySettings, field)).toBe(true);
  expect(repositoryProvides(null, "instructions")).toBe(false);
  expect(repositoryProvides({ ...repositorySettings, fields: [], error: "Invalid TOML" }, "setup_command")).toBe(false);
  const changed = { setupCommand: "other", verificationCommand: "other", instructions: "other", skillDirectories: "skills", taskConcurrency: "2" };
  expect(executionProjectPatch(saved, changed, repositorySettings)).toEqual({ execution: { skillDirectories: ["skills"] } });
  expect(executionProjectPatch(saved, changed, { ...repositorySettings, fields: ["setup_command"] })).toEqual({ verificationCommand: "other", taskConcurrency: 2, execution: { instructions: "other", skillDirectories: ["skills"] } });
});
