/** @vitest-environment happy-dom */
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { agentSummary, modelLabel, providerLabel, reasoningLabel } from "../features/agents/agent-display.js";
import { taskProfilesKey, taskRoleAgent } from "../features/tasks/lib/task-role-profile.js";
import { TaskAgent } from "../features/tasks/task-agent.js";
import { WorkflowPlan } from "../features/tasks/workflow-plan.js";
import { TaskSchema, type Task } from "../contracts/tasks.js";
import type { ProfileResponse } from "../contracts/projects.js";

vi.mock("../components/app/entity-avatar.js", () => ({
  EntityAvatar: ({ id, name, seed }: { id: string; name: string; seed?: string }) => <span data-avatar={`${id}|${name}|${seed ?? ""}`} />,
}));
vi.mock("../features/tasks/workflow-illustration.js", () => ({
  WorkflowIllustration: ({ agentNames, avatars }: { agentNames: Record<string, string>; avatars: Record<string, ReactNode> }) =>
    <div data-diagram>{Object.entries(agentNames).map(([role, name]) => <span key={role} data-diagram-role={role}>{name}{avatars[role]}</span>)}</div>,
}));
vi.mock("../features/tasks/task-data.js", () => ({ useTaskAgents: () => ({ data: undefined }) }));

const raw: unknown = JSON.parse(readFileSync(`${import.meta.dirname}/../../../tests/fixtures/task-response.json`, "utf8"));
// The server fixture matches the generated response type; the schema checks it.
const fixture = (TaskSchema.parse(raw), raw as Task);
const seed = (character: string) => character.repeat(32);
const profile = (id: string, name: string, role: "root" | "worker", extra: Partial<ProfileResponse> = {}) =>
  ({ id, name, role, provider: "claude-code", model: "opus", reasoningLevel: "high", serviceTier: "default", avatarSeed: seed(id === fixture.rootProfile.profileId ? "a" : "b"), archivedAt: null, ...extra }) as ProfileResponse;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear(); container.remove(); vi.unstubAllGlobals();
});

const render = async (node: ReactNode, profiles: ProfileResponse[] | null) => {
  if (profiles) client.setQueryData(taskProfilesKey, profiles);
  else vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Unavailable" }), { status: 500 })));
  await act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
};

test("labels use product names for providers, models, and reasoning", () => {
  expect(providerLabel("claude-code")).toBe("Claude Code");
  expect(providerLabel("opencode")).toBe("OpenCode");
  expect(reasoningLabel("xhigh")).toBe("XHigh");
  expect(modelLabel("opus")).toBe("Opus");
  expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(modelLabel("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
  expect(modelLabel("gpt-5")).toBe("GPT-5");
  expect(modelLabel("swe-2")).toBe("SWE-2");
  expect(modelLabel("anthropic/claude-sonnet-5")).toBe("Sonnet 5");
  expect(modelLabel("google/gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
});

test("the summary reads like the Settings agent card", () => {
  const agent = { provider: "claude-code", model: "opus", reasoningLevel: "high", serviceTier: "priority" } as const;
  expect(agentSummary(agent)).toBe("Claude Code · Opus High");
  expect(agentSummary(agent, { priority: true })).toBe("Claude Code · Opus High · Priority");
  expect(agentSummary({ ...agent, serviceTier: "default" }, { priority: true })).toBe("Claude Code · Opus High");
});

const activeTask: Task = { ...fixture, status: "active", rootProfile: { profileId: fixture.rootProfile.profileId, provider: "claude-code", model: "opus", reasoningLevel: "high", serviceTier: "default" } };

test("the sidebar shows the profile name and human runtime labels", async () => {
  await render(<TaskAgent task={activeTask} role="root" onChange={vi.fn()} onActivityChange={vi.fn()} />, [profile(fixture.rootProfile.profileId, "Ada", "root")]);
  const button = container.querySelector('[aria-label="Select Coordinator"]');
  expect(button?.textContent).toBe("AdaClaude Code · Opus High");
  expect(button?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe(`${fixture.rootProfile.profileId}|Ada|${seed("a")}`);
  expect(container.textContent).not.toContain("claude-code");
  expect(container.textContent).not.toMatch(/opus|high/);
});

test("the sidebar keeps an archived assigned profile and falls back to the role without one", async () => {
  await render(<>
    <TaskAgent task={activeTask} role="root" onChange={vi.fn()} onActivityChange={vi.fn()} />
    <TaskAgent task={activeTask} role="worker" onChange={vi.fn()} onActivityChange={vi.fn()} />
  </>, [profile(fixture.rootProfile.profileId, "Ada", "root", { archivedAt: "2026-10-01T00:00:00.000Z" })]);
  expect(container.querySelector('[aria-label="Select Coordinator"]')?.textContent).toBe("AdaClaude Code · Opus High");
  expect(container.querySelector('[aria-label="Select Worker"]')?.textContent).toBe("WorkerClaude Code · Opus 5.5 Medium");
});

test("the sidebar shows the role and runtime labels when profiles are not available", async () => {
  await render(<TaskAgent task={activeTask} role="root" onChange={vi.fn()} onActivityChange={vi.fn()} />, null);
  expect(container.querySelector('[aria-label="Select Coordinator"]')?.textContent).toBe("CoordinatorClaude Code · Opus High");
});

test("the workflow diagram and the sidebar show the same agent name and avatar", async () => {
  const profiles = [profile(fixture.rootProfile.profileId, "Ada", "root"), profile(fixture.workerProfile.profileId, "Grace", "worker", { archivedAt: "2026-10-01T00:00:00.000Z" })];
  const activity = { sessions: [], turns: [], setup: { state: "none" as const, exitStatus: null }, shellPaneId: null, actions: [] };
  await render(<>
    <WorkflowPlan task={activeTask} activity={activity} />
    <TaskAgent task={activeTask} role="root" onChange={vi.fn()} onActivityChange={vi.fn()} />
    <TaskAgent task={activeTask} role="worker" onChange={vi.fn()} onActivityChange={vi.fn()} />
  </>, profiles);
  for (const [role, label] of [["root", "Coordinator"], ["worker", "Worker"]] as const) {
    const diagram = container.querySelector(`[data-diagram-role="${role}"]`);
    const sidebar = container.querySelector(`[aria-label="Select ${label}"]`);
    expect(diagram?.textContent).toBe(taskRoleAgent(activeTask, role, profiles).name);
    expect(sidebar?.textContent?.startsWith(diagram?.textContent ?? "-")).toBe(true);
    expect(sidebar?.querySelector("[data-avatar]")?.getAttribute("data-avatar")).toBe(diagram?.querySelector("[data-avatar]")?.getAttribute("data-avatar"));
  }
});
