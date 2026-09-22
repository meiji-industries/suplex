import { expect, test } from "vitest";

import type { HealthCheck } from "../src/platform/health.js";
import type { ProviderSummary } from "../src/http/contracts/providers.js";
import type { ApiProfile, OnboardingState } from "../src/frontend/features/onboarding/onboarding.js";
import { connectedProviders, stepComplete } from "../src/frontend/features/onboarding/onboarding.js";

const provider = (id = "codex", status: ProviderSummary["connection"]["status"] = "connected", models = [{ id: "gpt-5.6-sol", label: "GPT" }]): ProviderSummary => ({ id, label: id, status: "configured", connection: { status, summary: status }, modelCount: models.length, models }) as ProviderSummary;
const profile = (role: "root" | "worker", providerId = "codex"): ApiProfile => ({ id: role, role, provider: providerId, model: "gpt-5.6-sol", archivedAt: null }) as ApiProfile;
const state = (overrides: Partial<OnboardingState> = {}): OnboardingState => ({ company: { issueCode: "SUPLEX" } as OnboardingState["company"], checks: [{ id: "git", status: "healthy" }, { id: "herdr-readiness", status: "healthy" }, { id: "gh-auth", status: "healthy" }] as HealthCheck[], providers: [provider()], profiles: [profile("root"), profile("worker")], projects: [{ id: "project" }] as unknown as OnboardingState["projects"], ...overrides });

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

test("Tools needs GitHub CLI installation and authentication", () => {
  const checks = state().checks.filter(check => check.id !== "gh-auth");
  expect(stepComplete(state({ checks }), "tools")).toBe(false);
  for (const failure of ["command-missing", "unauthenticated"]) {
    const github: HealthCheck = { id: "gh-auth", label: "GitHub CLI", status: "unhealthy", summary: "Not ready", details: { failure } };
    expect(stepComplete(state({ checks: [...checks, github] }), "tools")).toBe(false);
    expect(stepComplete(state({ checks: [...checks, github] }), "done")).toBe(false);
  }
  expect(stepComplete(state(), "tools")).toBe(true);
});

test("connected providers keep configured API order", () => {
  expect(connectedProviders([provider("codex"), { ...provider("devin"), status: "missing" }, provider("claude-code", "not-connected")]).map(item => item.id)).toEqual(["codex"]);
});

test("archived agents do not complete the Agents step", () => {
  expect(stepComplete(state({ profiles: [profile("root"), { ...profile("worker"), archivedAt: "2026-09-16T00:00:00Z" }] }), "agents")).toBe(false);
});
