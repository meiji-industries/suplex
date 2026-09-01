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
