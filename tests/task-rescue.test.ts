import { expect, test, vi } from "vitest";

const { getIssueEngine } = vi.hoisted(() => ({ getIssueEngine: vi.fn() }));
vi.mock("../src/engine/index.js", () => ({ getIssueEngine }));

import { TaskRescueService } from "../src/task-rescue.js";

test("diagnostics reports an unloaded local workflow", async () => {
  getIssueEngine.mockReturnValue({ runs: new Map() });
  const database = {
    authQuery: (operation: (db: { prepare: (sql: string) => { get: (...args: string[]) => unknown; all: (...args: string[]) => unknown } }) => unknown) => operation({ prepare: (sql) => ({ get: () => sql.includes("forge_users") ? { id: "admin" } : undefined, all: () => [] }) }),
  };
  const tasks = { getTask: () => ({ id: "task", companyId: "company", workflowId: "workflow" }) };
  const result = await new TaskRescueService(tasks as never, database as never, {} as never).diagnostics("admin", "task");
  expect(result).toEqual({ workflow: { status: "not_loaded", lastError: null }, executions: [] });
});

test("retry reconciles before it issues one current retry command", async () => {
  const run = { reconcileOwnerRead: vi.fn(async () => "reconciled" as const), state: { activeOperation: null } };
  getIssueEngine.mockReturnValue({ run: vi.fn(() => run) });
  const audit = vi.fn();
  const database = {
    authQuery: (operation: (db: { prepare: (sql: string) => { get: (...args: string[]) => unknown; run: (...args: unknown[]) => unknown } }) => unknown) => operation({ prepare: (sql) => ({ get: () => sql.includes("forge_users") ? { id: "admin" } : undefined, run: audit }) }),
  };
  const current = { id: "task", companyId: "company", workflowId: "workflow", phase: "development", revision: 7, allowedCommands: ["retry_development", "cancel_issue"] };
  const updated = { ...current, revision: 8, allowedCommands: [] };
  const executeCommand = vi.fn(async () => updated);
  const tasks = { getTask: vi.fn(() => current), executeCommand };

  const result = await new TaskRescueService(tasks as never, database as never, {} as never).rescue("admin", "task");

  expect(run.reconcileOwnerRead).toHaveBeenCalledOnce();
  expect(executeCommand).toHaveBeenCalledWith("admin", "task", "retry_development", { expectedRevision: 7, commandId: "workflow:task-retry:7:retry_development" });
  expect(result).toEqual({ status: "command_issued", command: "retry_development", detail: "Forge issued retry_development.", revision: 8 });
  expect(audit).toHaveBeenCalledOnce();
});

test("retry waits without dispatch when the driver has not reconciled", async () => {
  const run = { reconcileOwnerRead: vi.fn(async () => "waiting" as const), state: { activeOperation: null } };
  getIssueEngine.mockReturnValue({ run: vi.fn(() => run) });
  const database = {
    authQuery: (operation: (db: { prepare: (sql: string) => { get: (...args: string[]) => unknown; run: (...args: unknown[]) => unknown } }) => unknown) => operation({ prepare: (sql) => ({ get: () => sql.includes("forge_users") ? { id: "admin" } : undefined, run: vi.fn() }) }),
  };
  const current = { id: "task", companyId: "company", workflowId: "workflow", phase: "releasing", revision: 7, allowedCommands: ["publish_draft", "cancel_issue"] };
  const executeCommand = vi.fn();
  const tasks = { getTask: vi.fn(() => current), executeCommand };

  const result = await new TaskRescueService(tasks as never, database as never, {} as never).rescue("admin", "task");

  expect(executeCommand).not.toHaveBeenCalled();
  expect(result).toEqual({ status: "waiting", detail: "Forge is checking the current workflow state.", revision: 7 });
});

test("retry coalesces repeated clicks for one workflow", async () => {
  let reconcile!: () => void;
  const run = { reconcileOwnerRead: vi.fn(() => new Promise<"reconciled">((resolve) => { reconcile = () => resolve("reconciled"); })), state: { activeOperation: null } };
  getIssueEngine.mockReturnValue({ run: vi.fn(() => run) });
  const database = {
    authQuery: (operation: (db: { prepare: (sql: string) => { get: (...args: string[]) => unknown; run: (...args: unknown[]) => unknown } }) => unknown) => operation({ prepare: (sql) => ({ get: () => sql.includes("forge_users") ? { id: "admin" } : undefined, run: vi.fn() }) }),
  };
  const current = { id: "task", companyId: "company", workflowId: "workflow", phase: "development", revision: 7, allowedCommands: ["retry_development", "cancel_issue"] };
  const executeCommand = vi.fn(async () => ({ ...current, revision: 8, allowedCommands: [] }));
  const service = new TaskRescueService({ getTask: vi.fn(() => current), executeCommand } as never, database as never, {} as never);

  const first = service.rescue("admin", "task");
  const second = service.rescue("admin", "task");
  reconcile();
  await Promise.all([first, second]);

  expect(run.reconcileOwnerRead).toHaveBeenCalledOnce();
  expect(executeCommand).toHaveBeenCalledOnce();
});
