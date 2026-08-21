import { expect, test } from "vitest";

import { codexProvider } from "../src/agent-providers/codex.js";
import { parseCodexJsonl } from "../src/codex-jsonl.js";
import { sanitizeCodexLine } from "../src/codex-turn-supervisor.js";

const options = { executionId: "developer_jsonl", attempt: 1, worktreePath: "/tmp/worktree" };

test("disables the inner sandbox for new and resumed Codex turns", () => {
  const initial = codexProvider.buildTurnArgs({ prompt: "Implement" });
  const resumed = codexProvider.buildTurnArgs({ prompt: "Continue", resumeSessionId: "thread_opaque" });
  expect(initial).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(resumed).toEqual(expect.arrayContaining(["exec", "resume", "--dangerously-bypass-approvals-and-sandbox", "thread_opaque"]));
});

test("parses oversized valid output and skips malformed lines without losing following events", () => {
  const oversizedOutput = "x".repeat(2 * 1024 * 1024);
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "item.started", item: { id: "cmd_1", type: "command_execution", command: "git status --short" } }),
    JSON.stringify({ type: "item.completed", item: { id: "cmd_1", type: "command_execution", command: "git status --short", exit_code: 0, aggregated_output: oversizedOutput } }),
    "not-json",
    JSON.stringify({ type: "item.completed", item: { id: "message_1", type: "agent_message", text: "Completed after malformed output." } }),
  ], options);
  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "command_finished", sourceItemId: "cmd_1" }));
  expect(parsed.malformedLines).toBe(1);
  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "agent_update", summary: "Completed after malformed output." }));
  expect(parsed.receipts.some((receipt) => receipt.summary === "Malformed Codex JSONL line preserved as evidence")).toBe(false);
  expect(parsed.receipts.every((receipt) => receipt.stepNumber === null)).toBe(true);
});

test("normalizes absolute file changes inside the owned worktree and rejects escapes", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "item.completed", item: { id: "inside", type: "file_change", changes: [{ path: "/tmp/worktree/src/index.ts" }] } }),
    JSON.stringify({ type: "item.completed", item: { id: "outside", type: "file_change", changes: [{ path: "/tmp/other/secret.ts" }] } }),
  ], options);
  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "file_change", summary: "src/index.ts" }));
  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "reconciliation", summary: "Developer file-change path escaped the owned worktree" }));
});

test("keeps command events independent from plan steps and preserves parser state", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "item.started", item: { id: "start_1", type: "command_execution", command: "git status --short" } }),
    JSON.stringify({ type: "item.completed", item: { id: "start_1", type: "command_execution", command: "git status --short", exit_code: 0 } }),
  ], options);

  expect(parsed.receipts.map((receipt) => receipt.kind)).toEqual(["command_started", "command_finished"]);
  expect(parsed.receipts.every((receipt) => receipt.stepNumber === null)).toBe(true);
  expect(parsed.parserState).toMatchObject({ sequence: 2, terminalItemIds: ["start_1"] });
});

test("persists a distinct test-result receipt for completed test commands", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "item.started", item: { id: "test_1", type: "command_execution", command: "pnpm exec vitest run tests/example.test.ts" } }),
    JSON.stringify({ type: "item.completed", item: { id: "test_1", type: "command_execution", command: "pnpm exec vitest run tests/example.test.ts", exit_code: 1, aggregated_output: "one failed" } }),
  ], options);

  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "command_finished", sourceItemId: "test_1", stepNumber: null, exitCode: 1 }));
  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "test_result", sourceItemId: "test_1", stepNumber: null, exitCode: 1 }));
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

test("preserves the wrapper-observed event time for live activity", () => {
  const observedAt = "2026-08-16T15:00:12.000Z";
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "item.started", observedAt, item: { id: "cmd_1", type: "command_execution", command: "rg README" } }),
  ], options);

  expect(parsed.receipts).toContainEqual(expect.objectContaining({ occurredAt: observedAt, summary: "rg README" }));
});

test("keeps a safe command category while discarding command arguments", () => {
  const line = sanitizeCodexLine(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "rg --glob '*.md' super-secret README.md" } }));
  expect(line).toContain("Searching repository files");
  expect(line).not.toContain("super-secret");
});

test("uses a fixed summary for unknown events and redacts Codex errors", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "unknown.event", prompt: "private reasoning", aws: "AKIAIOSFODNN7EXAMPLE" }),
    JSON.stringify({ type: "error", message: "-----BEGIN PRIVATE KEY-----" }),
  ], options);

  expect(parsed.receipts.map((receipt) => receipt.summary)).toEqual(["Codex event could not be classified", "Codex reported an error: [REDACTED]"]);
});

test("ignores wrapper metadata and transient reconnect notices", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "forge.wrapper_started", childPid: 123 }),
    JSON.stringify({ type: "forge.session_bound", sessionRef: "session_test" }),
    JSON.stringify({ type: "error", error: { message: "Reconnecting... 1/5" } }),
    JSON.stringify({ type: "item.completed", item: { id: "message_1", type: "agent_message", text: "Inspecting the README." } }),
  ], options);

  expect(parsed.receipts.map((receipt) => receipt.summary)).toEqual(["Inspecting the README."]);
});

test("captures an unexpected turn failure as visible redacted evidence", () => {
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "turn.failed", error: { message: "Request failed with Bearer secret-token" } }),
  ], options);

  expect(parsed.receipts).toContainEqual(expect.objectContaining({ kind: "reconciliation", summary: "Codex turn failed: Request failed with [REDACTED]" }));
});
