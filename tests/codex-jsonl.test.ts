import { expect, test } from "vitest";

import { parseCodexJsonl } from "../src/codex-jsonl.js";

const options = { executionId: "developer_jsonl", attempt: 1, worktreePath: "/tmp/worktree" };

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
