import { expect, test } from "vitest";

import type { HealthCheck } from "../src/platform/health.js";
import type { ProviderSummary } from "../src/http/contracts/providers.js";
import type { ApiProfile, OnboardingState } from "../src/frontend/features/onboarding/onboarding.js";
import { connectedProviders, defaultAgentModels, stepComplete } from "../src/frontend/features/onboarding/onboarding.js";

const provider = (id = "codex", status: ProviderSummary["connection"]["status"] = "connected", models = [{ id: "gpt-5.6-sol", label: "GPT" }]): ProviderSummary => ({ id, label: id, status: "configured", connection: { status, summary: status }, modelCount: models.length, models }) as ProviderSummary;
const profile = (role: "root" | "worker", providerId = "codex"): ApiProfile => ({ id: role, role, provider: providerId, model: "gpt-5.6-sol", archivedAt: null }) as ApiProfile;
const state = (overrides: Partial<OnboardingState> = {}): OnboardingState => ({ company: { issueCode: "FORGE" } as OnboardingState["company"], checks: [{ id: "git", status: "healthy" }, { id: "herdr-readiness", status: "healthy" }] as HealthCheck[], providers: [provider()], profiles: [profile("root"), profile("worker")], projects: [{ id: "project" }] as unknown as OnboardingState["projects"], ...overrides });

test("each onboarding step reports complete and incomplete states", () => {
  expect(stepComplete(state(), "company")).toBe(true);
  expect(stepComplete(state({ company: undefined }), "company")).toBe(false);
  expect(stepComplete(state(), "tools")).toBe(true);
  expect(stepComplete(state({ checks: [] }), "tools")).toBe(false);
  expect(stepComplete(state(), "providers")).toBe(true);
  expect(stepComplete(state({ providers: [provider("codex", "not-connected")] }), "providers")).toBe(false);
  expect(stepComplete(state(), "agents")).toBe(true);
  expect(stepComplete(state({ profiles: [profile("root")] }), "agents")).toBe(false);
  expect(stepComplete(state(), "projects")).toBe(true);
  expect(stepComplete(state({ projects: [] }), "projects")).toBe(false);
  expect(stepComplete(state(), "done")).toBe(true);
  expect(stepComplete(state({ projects: [] }), "done")).toBe(false);
});

test("connected providers keep configured API order", () => {
  expect(connectedProviders([provider("codex"), { ...provider("devin"), status: "missing" }, provider("claude-code", "not-connected")]).map(item => item.id)).toEqual(["codex"]);
});

test("default models use supported tables and dynamic fallback models", () => {
  expect(defaultAgentModels([])).toBeUndefined();
  expect(defaultAgentModels([provider("codex", "connected", [{ id: "gpt-5.6-sol", label: "GPT" }, { id: "gpt-5.6-luna", label: "Luna" }])])).toEqual({ coordinator: { provider: "codex", model: "gpt-5.6-sol", reasoningLevel: "high" }, worker: { provider: "codex", model: "gpt-5.6-luna", reasoningLevel: "low" } });
  expect(defaultAgentModels([provider("claude-code", "connected", [{ id: "fable", label: "Fable" }, { id: "sonnet", label: "Sonnet" }])])?.worker.model).toBe("sonnet");
  expect(defaultAgentModels([provider("opencode", "connected", [{ id: "vendor/model", label: "Vendor" }])])?.coordinator.model).toBe("vendor/model");
  expect(defaultAgentModels([provider("codex", "connected", [{ id: "other", label: "Other" }])])?.coordinator.model).toBe("other");
});

test("two providers split Coordinator and Worker defaults", () => {
  expect(defaultAgentModels([provider("codex", "connected", [{ id: "gpt-5.6-sol", label: "GPT" }]), provider("devin", "connected", [{ id: "swe", label: "SWE" }])])).toEqual({ coordinator: { provider: "codex", model: "gpt-5.6-sol", reasoningLevel: "high" }, worker: { provider: "devin", model: "swe", reasoningLevel: "low" } });
});
