import { expect, test, vi } from "vitest";
import { TaskSchema } from "../src/task-contracts.js";
import { TaskSourceService } from "../src/task-sources.js";
import { nativeApp } from "./helpers/native-app.js";

test("issue creation saves current GitHub context and user instructions on a fresh branch", async () => {
  const value = await nativeApp();
  let body = "Search details";
  const source = new TaskSourceService({
    async getPullRequest() { throw new Error("An issue must not resolve a pull request"); },
    async getIssue() {
      return {
        number: 42, url: "https://github.com/owner/repo/issues/42", title: "Fix search", body,
        author: { login: "octo" }, state: "OPEN", labels: [{ name: "bug" }],
        assignees: [{ login: "worker" }], milestone: { title: "Launch" }, updatedAt: "2026-09-07",
        comments: [{ html_url: "https://github.com/owner/repo/issues/42#issuecomment-1", body: "Comment from reviewer", user: { login: "reviewer" }, created_at: "2026-09-07" }],
      };
    },
  });
  const resolve = vi.spyOn(value.projects, "resolveTaskSource").mockImplementation((project, selector) => source.resolve(project, selector));
  const request = {
    method: "POST" as const, url: `/api/companies/${value.company.id}/tasks`, headers: value.headers,
    payload: { projectId: value.project.id, title: "Fix search", description: "Keep my instructions.", idempotencyKey: "issue-create-001", source: { kind: "issue", number: 42 } },
  };
  try {
    const response = await value.app.inject(request);
    expect(response.statusCode, response.body).toBe(201);
    const task = TaskSchema.parse(response.json());
    expect(task.configuration.source).toEqual({ kind: "issue", number: 42 });
    expect(task.configuration.branch).toBe(`forge/${task.id}`);
    expect(task.configuration.startingSha).toBe("a".repeat(40));
    expect(task.configuration.baseBranch).toBe("main");
    for (const text of ["Keep my instructions.", body, "Comment from reviewer", "https://github.com/owner/repo/issues/42", "octo", "bug", "worker", "Launch"]) expect(task.description).toContain(text);
    expect(task.pullRequest).toBeNull();

    body = "Later issue edit";
    const retried = await value.app.inject(request);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(TaskSchema.parse(retried.json())).toEqual(task);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(value.tasks.getTask(value.userId, task.id).description).toBe(task.description);
  } finally { resolve.mockRestore(); await value.close(); }
});
