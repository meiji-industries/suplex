import { expect, test } from "vitest";

import type { HealthCheck } from "../contracts/health.js";
import type { ProviderSummary } from "../contracts/providers.js";
import type { ApiProfile, OnboardingState } from "../features/onboarding/onboarding.js";
import { connectedProviders, firstStep, ONBOARDING_STEPS, runsOnConnected, setupComplete, stepComplete } from "../features/onboarding/onboarding.js";
import { ProviderListResponseSchema } from "../contracts/providers.js";
import { planLabel } from "../features/onboarding/onboarding-you.js";
import type { BillingSummary } from "../contracts/billing.js";
import { HARNESS_KIND_IDS } from "../contracts/harness-kind.js";
import { providerIcons } from "../components/app/provider-icons.js";
import { PROVIDER_INSTALLATIONS } from "../components/app/provider-installation.js";

const provider = (id = "codex", status: ProviderSummary["connection"]["status"] = "connected", models = [{ id: "gpt-5.6-sol", label: "GPT" }]): ProviderSummary => ({ id, kind: "cli", harness: id, label: id, status: "configured", connection: { status, summary: status }, modelCount: models.length, models }) as ProviderSummary;
const endpoint = (status: ProviderSummary["connection"]["status"] = "connected"): ProviderSummary => ({
  id: "local-0a1b2c3d4e5f", kind: "local-endpoint", harness: "opencode", label: "Local endpoint 127.0.0.1:8080", status: "configured",
  connection: { status, summary: status === "connected" ? "The endpoint is reachable and lists qwen3-coder." : "The endpoint is reachable, but it does not list qwen3-coder." },
  modelCount: 1, models: [{ id: "local-0a1b2c3d4e5f/qwen3-coder", label: "qwen3-coder (Local endpoint 127.0.0.1:8080)" }],
  endpoint: { baseUrl: "http://127.0.0.1:8080/v1", modelId: "qwen3-coder", hasApiKey: false },
});
const profile = (role: "root" | "worker", providerId = "codex"): ApiProfile => ({ id: role, role, provider: providerId, model: "gpt-5.6-sol", archivedAt: null }) as ApiProfile;
const state = (overrides: Partial<OnboardingState> = {}): OnboardingState => ({ company: { issueCode: "SUPLEX" } as OnboardingState["company"], checks: [{ id: "git", status: "healthy" }, { id: "herdr-readiness", status: "healthy" }, { id: "gh-auth", status: "healthy" }, { id: "gh-cli", status: "healthy" }] as HealthCheck[], providers: [provider()], profiles: [profile("root"), profile("worker")], projects: [{ id: "project" }] as unknown as OnboardingState["projects"], ...overrides });

test("each setup step reports complete and incomplete states", () => {
  expect(stepComplete(state(), "you")).toBe(true);
  expect(stepComplete(state({ company: undefined }), "you")).toBe(false);
  expect(stepComplete(state(), "stack")).toBe(true);
  expect(stepComplete(state({ checks: [] }), "stack")).toBe(false);
  expect(stepComplete(state({ providers: [provider("codex", "not-connected")] }), "stack")).toBe(false);
  expect(stepComplete(state(), "team")).toBe(true);
  expect(stepComplete(state({ profiles: [profile("root")] }), "team")).toBe(false);
  expect(stepComplete(state(), "project")).toBe(true);
  expect(stepComplete(state({ projects: [] }), "project")).toBe(false);
  expect(setupComplete(state())).toBe(true);
  expect(setupComplete(state({ projects: [] }))).toBe(false);
});

test("Your stack needs both the GitHub App and the GitHub CLI signed in", () => {
  for (const id of ["gh-auth", "gh-cli"] as const) {
    const checks = state().checks.filter(check => check.id !== id);
    expect(stepComplete(state({ checks }), "stack")).toBe(false);
    const github: HealthCheck = { id, label: "GitHub", status: "warning", summary: "Not ready", details: {} };
    expect(stepComplete(state({ checks: [...checks, github] }), "stack")).toBe(false);
  }
});

test("a new company starts at the intro; a named one resumes at the first unfinished setup step", () => {
  expect(ONBOARDING_STEPS[0]).toBe("promise");
  expect(firstStep(state({ company: { name: "My Company" } as OnboardingState["company"] }))).toBe("promise");
  expect(firstStep(state({ checks: [] }))).toBe("stack");
  expect(firstStep(state({ projects: [] }))).toBe("project");
  expect(firstStep(state())).toBe("first-task");
});

test("connected providers keep configured API order", () => {
  expect(connectedProviders([provider("codex"), { ...provider("devin"), status: "missing" }, provider("claude-code", "not-connected")]).map(item => item.id)).toEqual(["codex"]);
});

test("Pi lists in Your stack like the other agent tools, with a local model", () => {
  const pi = provider("pi", "connected", [{ id: "llama-server/qwen3-coder", label: "qwen3-coder (llama-server)" }]);
  expect(connectedProviders([provider("codex", "not-connected"), pi]).map(item => item.id)).toEqual(["pi"]);
  expect(stepComplete(state({ providers: [pi], profiles: [profile("root", "pi"), profile("worker", "pi")] }), "stack")).toBe(true);
  for (const id of HARNESS_KIND_IDS) {
    expect(providerIcons[id].label).not.toBe("");
    expect(PROVIDER_INSTALLATIONS[id].command).not.toBe("");
  }
  expect(providerIcons.pi.label).toBe("Pi");
});

test("OMP lists in Your stack as its own agent tool", () => {
  const omp = provider("omp", "connected", [{ id: "localfake/fake-model", label: "fake-model (localfake)" }]);
  expect(connectedProviders([provider("pi", "not-connected"), omp]).map(item => item.id)).toEqual(["omp"]);
  expect(stepComplete(state({ providers: [omp], profiles: [profile("root", "omp"), profile("worker", "omp")] }), "stack")).toBe(true);
  expect(providerIcons.omp.label).toBe("OMP");
  expect(PROVIDER_INSTALLATIONS.omp.command).toBe("curl -fsSL https://omp.sh/install | sh");
});

test("a connected local endpoint counts for Your stack and runs the agents that select its model", () => {
  const local = endpoint();
  expect(connectedProviders([provider("codex", "not-connected"), local]).map(item => item.id)).toEqual(["local-0a1b2c3d4e5f"]);
  expect(connectedProviders([endpoint("not-connected")])).toEqual([]);
  expect(stepComplete(state({ providers: [provider("codex", "not-connected"), local] }), "stack")).toBe(true);
  expect(stepComplete(state({ providers: [endpoint("not-connected")] }), "stack")).toBe(false);
  const onEndpoint = (role: "root" | "worker"): ApiProfile => ({ ...profile(role, "opencode"), model: "local-0a1b2c3d4e5f/qwen3-coder" });
  expect(stepComplete(state({ providers: [local], profiles: [onEndpoint("root"), onEndpoint("worker")] }), "team")).toBe(true);
  // The endpoint runs only its own model, not every OpenCode model.
  expect(runsOnConnected([local], { provider: "opencode", model: "anthropic/claude-opus-5-5" })).toBe(false);
  expect(stepComplete(state({ providers: [endpoint("not-connected")], profiles: [onEndpoint("root"), onEndpoint("worker")] }), "team")).toBe(false);
});

test("the provider list contract accepts tool and endpoint rows", () => {
  const parsed = ProviderListResponseSchema.parse({ directory: "/host", observedAt: "2026-10-20T00:00:00.000Z", providers: [provider(), endpoint()] });
  expect(parsed.providers.map(row => row.kind)).toEqual(["cli", "local-endpoint"]);
  expect(ProviderListResponseSchema.safeParse({ directory: "/host", observedAt: "x", providers: [{ ...endpoint(), id: "codex" }] }).success).toBe(false);
  expect(ProviderListResponseSchema.safeParse({ directory: "/host", observedAt: "x", providers: [{ ...provider(), harness: "local" }] }).success).toBe(false);
});

test("archived agents do not complete Your team", () => {
  expect(stepComplete(state({ profiles: [profile("root"), { ...profile("worker"), archivedAt: "2026-09-16T00:00:00Z" }] }), "team")).toBe(false);
});

test("the workspace preview names the plan the account has", () => {
  const billing = (overrides: Partial<BillingSummary>): BillingSummary => ({ plan: "free", trialAvailable: false, subscriptionStatus: null, accessUntil: null, ...overrides }) as BillingSummary;
  expect(planLabel(undefined)).toBeUndefined();
  expect(planLabel(billing({ trialAvailable: true }))).toBe("Pro trial · 14 days");
  expect(planLabel(billing({}))).toBe("Free");
  expect(planLabel(billing({ plan: "pro" }))).toBe("Pro");
  const now = Date.parse("2026-10-01T00:00:00Z");
  expect(planLabel(billing({ plan: "pro", subscriptionStatus: "trialing", accessUntil: "2026-10-04T12:00:00Z" }), now)).toBe("Pro trial · 4 days");
});
