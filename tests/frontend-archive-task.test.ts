import { describe, expect, test } from "vitest";

import { requestTaskArchive } from "../src/frontend/lib/archive-task.js";

type RecordedRequest = { url: string; init: RequestInit | undefined };

function fakeRequest(records: RecordedRequest[]) {
  return async <T>(url: string, init?: RequestInit): Promise<T> => {
    records.push({ url, init });
    return {} as T;
  };
}

describe("requestTaskArchive", () => {
  test("returns the company-scoped task list path after an archived response", async () => {
    const records: RecordedRequest[] = [];
    const outcome = await requestTaskArchive(
      { taskId: "task-1", companyId: "company-1", expectedRevision: 7, confirmDiscardDirty: false, returnTo: "tasks" },
      { request: fakeRequest(records) as <T>(url: string, init?: RequestInit) => Promise<T> },
    );

    expect(outcome).toEqual({ status: "archived", redirectPath: "/tasks?company=company-1" });
    expect(records).toHaveLength(1);
    expect(records[0]!.url).toBe("/api/tasks/task-1/archive");
    expect(records[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(records[0]!.init?.body))).toEqual({ expectedRevision: 7, confirmDiscardDirty: false });
  });

  test("returns the dirty file count without a redirect path when confirmation is required", async () => {

    const outcome = await requestTaskArchive(
      { taskId: "task-1", companyId: "company-1", expectedRevision: 7, confirmDiscardDirty: false, returnTo: "tasks" },
      {
        request: async <T,>(): Promise<T> => ({ status: "confirmation_required", dirtyFileCount: 3 }) as T,
      },
    );

    expect(outcome).toEqual({ status: "confirmation_required", dirtyFileCount: 3 });
    expect(outcome).not.toHaveProperty("redirectPath");
  });

  test("returns the company-scoped board path in board mode", async () => {
    const records: RecordedRequest[] = [];
    const outcome = await requestTaskArchive(
      { taskId: "task-1", companyId: "company-1", expectedRevision: 7, confirmDiscardDirty: true, returnTo: "board" },
      { request: fakeRequest(records) as <T>(url: string, init?: RequestInit) => Promise<T> },
    );

    expect(outcome).toEqual({ status: "archived", redirectPath: "/board?company=company-1" });
    expect(JSON.parse(String(records[0]!.init?.body)).confirmDiscardDirty).toBe(true);
  });
});
