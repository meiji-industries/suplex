import { afterEach, expect, test, vi } from "vitest";
import { readTaskList } from "../features/tasks/lib/task-list.js";

afterEach(() => vi.unstubAllGlobals());

test("task lists scope each native read to the requested company and archive state", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  expect(await readTaskList("company/a")).toEqual([]);
  expect(fetch).toHaveBeenLastCalledWith("/api/companies/company%2Fa/tasks?archived=false", expect.anything());
  await readTaskList("company-b", true);
  expect(fetch).toHaveBeenLastCalledWith("/api/companies/company-b/tasks?archived=true", expect.anything());
});

test("failed reads propagate instead of presenting an empty successful list", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "Not authorized" }), { status: 403 }));
  await expect(readTaskList("company-a")).rejects.toMatchObject({ statusCode: 403 });
});
