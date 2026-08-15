import { expect, test } from "vitest";

import { codexProvider } from "../src/agent-providers/codex.js";
import { parseCodexJsonl } from "../src/codex-jsonl.js";

const options = { executionId: "developer_jsonl", attempt: 1, worktreePath: "/tmp/worktree" };

test("disables the inner sandbox for new and resumed Codex turns", () => {
  const initial = codexProvider.buildTurnArgs({ prompt: "Implement" });
  const resumed = codexProvider.buildTurnArgs({ prompt: "Continue", resumeSessionId: "thread_opaque" });
  expect(initial).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(resumed).toEqual(expect.arrayContaining(["exec", "resume", "--dangerously-bypass-approvals-and-sandbox", "thread_opaque"]));
});

test("parses Codex file-change changes and preserves malformed output as a blocker receipt", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "item.started", item: { id: "cmd_1", type: "command_execution", command: "forge-step start 1" } }),
    JSON.stringify({ type: "item.completed", item: { id: "cmd_1", type: "command_execution", command: "forge-step start 1", exit_code: 0 } }),
    JSON.stringify({ type: "item.completed", item: { id: "change_1", type: "file_change", changes: [{ path: "README.md", kind: "update" }] } }),
    "not-json",
  ], options);
  expect(parsed.receipts.some((receipt) => receipt.kind === "file_change" && receipt.summary === "README.md")).toBe(true);
  expect(parsed.malformedLines).toBe(1);
  expect(parsed.receipts.some((receipt) => receipt.kind === "reconciliation")).toBe(true);
});

test("normalizes absolute file changes inside the owned worktree and rejects escapes", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "item.completed", item: { id: "inside", type: "file_change", changes: [{ path: "/tmp/worktree/src/index.ts" }] } }),
    JSON.stringify({ type: "item.completed", item: { id: "outside", type: "file_change", changes: [{ path: "/tmp/other/secret.ts" }] } }),
  ], options);
  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "file_change", summary: "src/index.ts" }));
  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "reconciliation", summary: "Developer file-change path escaped the owned worktree" }));
});

test("treats forge-step markers as terminal command events and preserves parser state", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "item.started", item: { id: "start_1", type: "command_execution", command: "forge-step start 1" } }),
    JSON.stringify({ type: "item.completed", item: { id: "start_1", type: "command_execution", command: "forge-step start 1", exit_code: 0 } }),
  ], { ...options, authorizedStepNumbers: [1] });

  expect(parsed.receipts.map((receipt) => receipt.kind)).toEqual(["command_started", "step_started", "command_finished"]);
  expect(parsed.receipts.some((receipt) => receipt.kind === "reconciliation" && receipt.summary.includes("Invalid forge-step marker"))).toBe(false);
  expect(parsed.parserState).toMatchObject({ activeStep: 1, startedSteps: [1], terminalSteps: [], sequence: 3 });
});

test("persists a distinct test-result receipt for completed test commands", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "item.completed", item: { id: "start_1", type: "command_execution", command: "forge-step start 1", exit_code: 0 } }),
    JSON.stringify({ type: "item.started", item: { id: "test_1", type: "command_execution", command: "pnpm exec vitest run tests/example.test.ts" } }),
    JSON.stringify({ type: "item.completed", item: { id: "test_1", type: "command_execution", command: "pnpm exec vitest run tests/example.test.ts", exit_code: 1, aggregated_output: "one failed" } }),
  ], { ...options, authorizedStepNumbers: [1] });

  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "command_finished", sourceItemId: "test_1", stepNumber: 1, exitCode: 1 }));
  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "test_result", sourceItemId: "test_1", stepNumber: 1, exitCode: 1 }));
});

test("redacts credentials before command and test receipts are persisted", () => {
  const command = "curl -H 'Authorization: Bearer very-secret-token' -H 'X-Api-Key: api-secret' 'https://example.test/?access_token=query-secret'";
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "item.started", item: { id: "secret_1", type: "command_execution", command } }),
    JSON.stringify({ type: "item.completed", item: { id: "secret_1", type: "command_execution", command, exit_code: 0, aggregated_output: "Basic dXNlcjpzZWNyZXQ=" } }),
  ], options);

  const visible = parsed.receipts.map((receipt) => receipt.summary).join("\n");
  expect(visible).toContain("curl");
  expect(visible).not.toMatch(/very-secret-token|api-secret|query-secret|dXNlcjpzZWNyZXQ=/);
  expect(visible).toContain("[REDACTED]");
});

test("keeps agent updates and named tool calls in the public activity stream", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "item.completed", item: { id: "message_1", type: "agent_message", text: "I found the failing test and am updating it." } }),
    JSON.stringify({ type: "item.completed", item: { id: "reasoning_1", type: "reasoning", text: "The shared parser is dropping useful fields." } }),
    JSON.stringify({ type: "item.started", item: { id: "tool_1", type: "mcp_tool_call", server: "linear", tool: "get_issue", arguments: { issue: "FOR-123" } } }),
    JSON.stringify({ type: "item.completed", item: { id: "tool_1", type: "mcp_tool_call", server: "linear", tool: "get_issue", result: { ok: true } } }),
    JSON.stringify({ type: "item.started", item: { id: "search_1", type: "web_search", query: "Codex JSONL events" } }),
    JSON.stringify({ type: "item.updated", item: { id: "plan_1", type: "todo_list", items: [{ text: "Inspect the parser", status: "completed" }, { text: "Fix the projection", status: "in_progress" }] } }),
  ], options);

  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "agent_update", summary: "I found the failing test and am updating it." }));
  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "agent_update", summary: "Reasoning summary: The shared parser is dropping useful fields." }));
  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "tool_call", summary: expect.stringContaining("Using linear.get_issue") }));
  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "tool_call", summary: expect.stringContaining("Used linear.get_issue") }));
  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "tool_call", summary: "Searching: Codex JSONL events" }));
  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "agent_update", summary: "Plan update:\nInspect the parser — completed\nFix the projection — in_progress" }));
});

test("uses a fixed summary for unknown events and redacts Codex errors", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "unknown.event", prompt: "private reasoning", aws: "AKIAIOSFODNN7EXAMPLE" }),
    JSON.stringify({ type: "error", message: "-----BEGIN PRIVATE KEY-----" }),
  ], options);

  expect(parsed.receipts.map((receipt) => receipt.summary)).toEqual(["Codex event could not be classified", "Codex reported an error: [REDACTED]"]);
});

test("captures an unexpected turn failure as visible redacted evidence", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "turn.failed", error: { message: "Request failed with Bearer secret-token" } }),
  ], options);

  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "reconciliation", summary: "Codex turn failed: Request failed with [REDACTED]" }));
});
