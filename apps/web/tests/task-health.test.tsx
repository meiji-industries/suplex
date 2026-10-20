/**
 * @vitest-environment happy-dom
 * @vitest-environment-options { "url": "https://suplex.test/board?company=company-1" }
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notifyManager } from "@tanstack/react-query";
import { ServerStateProvider } from "../shell/server-state.js";
import { TaskDataProvider } from "../features/tasks/task-data.js";
import { NO_PROGRESS_FLOOR_MS, TaskHealthBadges, noProgressFor, type TaskHealth } from "../features/tasks/task-health.js";
import type { Task } from "../contracts/tasks.js";

const api = vi.hoisted(() => ({ company: { id: "company-1", status: "active", plan: "pro" }, user: { id: "user-1", role: "admin" }, readJsonUnchecked: vi.fn(), withCompany: (path: string) => path }));
vi.mock("../lib/api.js", async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), ...api }));
vi.mock("../shell/company-context.js", () => ({ useCompanyContext: () => ({ user: api.user, currentCompany: api.company }), useOptionalCompanyContext: () => ({ avatars: {} }) }));
vi.mock("../shell/application-frame.js", () => ({ ApplicationFrame: ({ children }: { children: ReactNode }) => children }));
vi.mock("../shell/global-new-task-dialog.js", () => ({ requestNewTask: vi.fn(), useHasProjects: () => true }));
vi.mock("../features/analytics/lib/analytics.js", async importOriginal => ({ ...(await importOriginal<Record<string, unknown>>()), useTaskCosts: () => new Map() }));
vi.mock("../features/tasks/task-options.js", () => ({ TaskOptions: () => null }));
const sync = vi.hoisted(() => ({ emit: (_message: unknown): void => undefined }));
vi.mock("../features/tasks/lib/task-sync-api.js", () => ({ openTaskSync: (_companyId: string, onMessage: (message: unknown) => void) => { sync.emit = onMessage; return { close: () => undefined, watch: () => undefined }; } }));

import { TasksView } from "../features/tasks/tasks.js";

const now = Date.parse("2026-10-20T12:00:00.000Z");
const healthy: TaskHealth = { providers: [{ provider: "claude-code", status: "connected", summary: "Signed in", observedAt: "2026-10-20T11:59:00.000Z" }], retries: 0, lastProgressAt: "2026-10-20T11:55:00.000Z", usualTurnSeconds: null };
const notConnected: TaskHealth = { ...healthy, providers: [{ provider: "claude-code", status: "not-connected", summary: "Claude Code is not signed in", observedAt: "2026-10-20T11:59:00.000Z" }] };
const retried: TaskHealth = { ...healthy, retries: 3 };
const stalled: TaskHealth = { ...healthy, lastProgressAt: "2026-10-20T09:00:00.000Z" };

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  notifyManager.setScheduler(queueMicrotask);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  notifyManager.setScheduler(callback => setTimeout(callback, 0));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const badges = (scope: ParentNode = container) => Array.from(scope.querySelectorAll('[data-slot="badge"]')).map(badge => [badge.textContent, badge.getAttribute("title")]);

test("a healthy task shows no badge", async () => {
  await act(async () => root.render(<TaskHealthBadges health={healthy} />));
  expect(container.querySelector("[data-task-health]")).toBeNull();
  await act(async () => root.render(<TaskHealthBadges health={undefined} />));
  expect(container.innerHTML).toBe("");
});

test("a provider that is not connected, retries, and no progress each show one badge", async () => {
  await act(async () => root.render(<TaskHealthBadges health={notConnected} />));
  expect(badges()).toEqual([["Claude Code is not connected", "Claude Code is not signed in"]]);
  expect(container.querySelector('[data-task-health-provider="claude-code"]')?.getAttribute("data-variant")).toBe("destructive");
  await act(async () => root.render(<TaskHealthBadges health={retried} />));
  expect(badges().map(([text]) => text)).toEqual(["Retried 3 times"]);
  await act(async () => root.render(<TaskHealthBadges health={{ ...healthy, retries: 1 }} />));
  expect(badges().map(([text]) => text)).toEqual(["Retried 1 time"]);
  await act(async () => root.render(<TaskHealthBadges health={stalled} />));
  expect(badges().map(([text]) => text)).toEqual(["No progress for 3 h"]);
});

test("no progress shows only after the floor and after twice the usual turn time", () => {
  const at = (minutes: number, usualTurnSeconds: number | null = null) => noProgressFor({ ...healthy, lastProgressAt: new Date(now - minutes * 60_000).toISOString(), usualTurnSeconds }, now);
  expect(NO_PROGRESS_FLOOR_MS).toBe(10 * 60_000);
  expect(at(10)).toBeNull();
  expect(at(11)).toBe(11 * 60_000);
  // A usual turn of 30 minutes waits 60 minutes.
  expect(at(59, 30 * 60)).toBeNull();
  expect(at(61, 30 * 60)).toBe(61 * 60_000);
  // A short usual turn keeps the floor.
  expect(at(9, 60)).toBeNull();
  expect(noProgressFor({ ...healthy, lastProgressAt: null }, now)).toBeNull();
});

const profile = { profileId: "profile", provider: "claude-code", model: "model", reasoningLevel: "medium", serviceTier: "default" } as const;
function task(id: string, title: string, status: Task["status"]): Task {
  return {
    id, companyId: "company-1", projectId: "project-1", issue: null, artifacts: [], issueKey: null, title, description: "", status, deliveryTarget: "pull_request_draft",
    rootProfile: profile, workerProfile: profile, workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null },
    configuration: { repository: "meiji-industries/suplex", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: id, baseBranch: "main", baselineSha: "a".repeat(40), startingSha: "a".repeat(40), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: "2026-09-08T00:00:00.000Z" },
    worktree: null, pullRequest: null, humanQuestion: null, blockedBy: [], queue: { projectConcurrencyLimited: false, planConcurrencyLimited: false, waitingOn: [] }, limits: { budgetUsd: 15, maxTurns: 40, admittedTurns: 0 }, wakeAt: null, images: [],
    dependsOn: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z", statusChangedAt: "2026-10-20T11:00:00.000Z", queuePriority: 0, archivedAt: null,
  };
}
const agents = (taskId: string, health: TaskHealth) => ({ taskId, setup: { state: "none", exitStatus: null }, agents: [], health });

test("active board cards show the health that the agents route reads without a socket, and a pushed frame replaces it", async () => {
  const tasks = [task("task-1", "Healthy task", "active"), task("task-2", "Stuck task", "active"), task("task-3", "Planned task", "backlog")];
  const served = new Map([["task-1", healthy], ["task-2", notConnected]]);
  api.readJsonUnchecked.mockImplementation(async (path: string) => {
    if (path.includes("/projects")) return { projects: [] };
    if (path.includes("/task-agents?")) return { tasks: new URLSearchParams(path.split("?")[1]).getAll("taskId").flatMap(id => served.has(id) ? [agents(id, served.get(id)!)] : []) };
    return { tasks: path.endsWith("/task-costs") ? [] : tasks };
  });
  await act(async () => root.render(<ServerStateProvider><TaskDataProvider><TasksView mode="board" /></TaskDataProvider></ServerStateProvider>));
  const card = (title: string) => Array.from(container.querySelectorAll("li")).find(item => item.textContent?.includes(title))!;
  await vi.waitFor(() => expect(badges(card("Stuck task"))).toEqual([["Claude Code is not connected", "Claude Code is not signed in"]]));
  expect(card("Healthy task").querySelector("[data-task-health]")).toBeNull();
  // Only active cards read the agents value.
  const agentReads = api.readJsonUnchecked.mock.calls.map(([path]) => String(path)).filter(path => path.includes("/task-agents?"));
  expect(agentReads.every(path => !path.includes("task-3"))).toBe(true);

  await act(async () => sync.emit({ type: "agents", tasks: [agents("task-1", stalled), agents("task-2", retried)] }));
  expect(badges(card("Healthy task")).map(([text]) => text)).toEqual(["No progress for 3 h"]);
  expect(badges(card("Stuck task")).map(([text]) => text)).toEqual(["Retried 3 times"]);
  // The card links and moves stay available.
  expect(card("Stuck task").querySelector("a")?.getAttribute("href")).toContain("task-2");
});
