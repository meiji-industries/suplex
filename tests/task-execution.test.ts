import { expect, test } from "vitest";
import { executionFromMessages, readTaskExecution } from "../src/task-execution.js";
import { OpenCodeMessageEnvelopeSchema } from "../src/opencode-contracts.js";
import { nativeApp } from "./helpers/native-app.js";

function message(id: string, created: number, parts: unknown[]) {
  return OpenCodeMessageEnvelopeSchema.parse({ info: {
    id, sessionID: "ses_execution", role: "assistant", time: { created }, parentID: "msg_user", modelID: "model", providerID: "openai", mode: "primary", agent: "forge-root", path: { cwd: "/repo", root: "/repo" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }, parts });
}

test("execution reads tool states and the last successfully recorded plan in message order", () => {
  const todo = (status: string, content: string) => ({ type: "tool", callID: content, tool: "todowrite", state: { status, input: { todos: [{ content, status: "pending", priority: "high" }] } } });
  const result = executionFromMessages([
    message("msg_new", 2, [todo("completed", "Verify worker output"), todo("error", "Do not publish this plan"), { type: "tool", callID: "run", tool: "bash", state: { status: "error", input: { command: "pnpm test" }, error: "1 failed" } }]),
    message("msg_old", 1, [todo("completed", "Inspect scope"), { type: "text", text: "A prose plan is not a todo list" }]),
  ]);
  expect(result.plan).toEqual([{ content: "Verify worker output", status: "pending" }]);
  expect(result.tools).toHaveLength(4);
  expect(result.tools.at(-1)).toMatchObject({ id: "msg_new:run", name: "bash", status: "error", input: { command: "pnpm test" }, output: null, error: "1 failed" });
});

test("execution observation failures are explicit and cannot wake or alter a task", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Execution", description: "Read only", startImmediately: true, idempotencyKey: "execution" });
    const store = value.tasks.repository.controls;
    const reserved = store.claimRoot({ taskId: task.id });
    const root = store.bindHarnessSession({ sessionId: reserved.id, generation: reserved.generation, nativeSessionId: "ses_execution" });
    const before = store.get(task.id);
    const observed = await readTaskExecution(value.config.databasePath, [root], async () => [message("msg_one", 1, [{ type: "tool", callID: "read", tool: "read", state: { status: "running", input: { filePath: "README.md" } } }])]);
    expect(observed.sessions[0]).toMatchObject({ available: true, tools: [{ status: "running" }] });
    const response = await value.app.inject({ url: `/api/tasks/${task.id}/execution`, headers: value.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().sessions[0]).toMatchObject({ available: false, plan: null, tools: [] });
    expect((await value.app.inject({ url: `/api/tasks/${task.id}/execution` })).statusCode).toBe(401);
    expect((await value.app.inject({ url: "/api/tasks/missing/execution", headers: value.headers })).statusCode).toBe(404);
    expect(store.get(task.id)).toEqual(before);
    expect(value.wakes).toEqual([]);
  } finally { await value.close(); }
});
