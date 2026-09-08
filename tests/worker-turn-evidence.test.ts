import { expect, test } from "vitest";

import { readWorkerEvidence } from "../src/coordination/worker-turn-evidence.js";

const tool = (input: Partial<{
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "error";
  command: string;
  output: string | null;
  error: string | null;
}> = {}) => ({
  id: input.id ?? "tool-1",
  name: input.name ?? "bash",
  status: input.status ?? "completed",
  input: { command: input.command ?? "pnpm test" },
  output: input.output ?? "passed",
  error: input.error ?? null,
});

test("the default evidence view indexes commands with bounded tail excerpts", () => {
  const tools = Array.from({ length: 24 }, (_, index) => tool({ id: `read-${index}`, name: "read", command: `read file-${index}`, output: "x".repeat(100_000) }));
  tools.push(tool({ id: "pnpm-test", command: "pnpm test", output: `${"x".repeat(100_000)}\nTests 667 passed` }));

  const result = readWorkerEvidence(tools, { maxCharacters: 20_000 });

  expect(result.kind).toBe("index");
  if (result.kind !== "index") throw new Error("Expected an evidence index");
  expect(result.tools).toHaveLength(25);
  expect(result.tools.find(candidate => candidate.toolId === "pnpm-test")).toMatchObject({
    status: "completed",
    command: { text: "pnpm test", truncated: false },
    outputTail: { text: expect.stringContaining("Tests 667 passed"), truncated: true },
  });
  expect(result.tools.every(candidate => candidate.outputTail.text.length <= 240 && candidate.inputPreview.text.length <= 240)).toBe(true);
  expect(result.tools.reduce((total, candidate) => total + candidate.inputPreview.text.length + (candidate.command?.text.length ?? 0) + candidate.outputTail.text.length + candidate.errorTail.text.length, 0)).toBeLessThanOrEqual(20_000);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(20_200);
});

test("the compact index counts serialized metadata and returns a continuation cursor", () => {
  const tools = Array.from({ length: 1_000 }, (_, index) => tool({ id: `tool-${index}`, name: "read", command: "", output: "" }));
  const result = readWorkerEvidence(tools, { maxCharacters: 1_000 });
  if (result.kind !== "index") throw new Error("Expected an evidence index");
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_000);
  expect(result.tools.length).toBeGreaterThan(0);
  expect(result.nextCursor).toMatch(/^index:\d+$/);
});

test("selected evidence reads a large result from its tail without treating completed as passed", () => {
  const output = `${"x".repeat(120_000)}\nFAIL tests/tasks.test.ts`;
  const result = readWorkerEvidence([tool({ id: "pnpm-test", output })], { toolId: "pnpm-test", field: "output", position: "tail", maxCharacters: 1_000 });

  expect(result).toMatchObject({
    kind: "tool",
    tool: { toolId: "pnpm-test", status: "completed" },
    field: "output",
    position: "tail",
    evidence: { text: expect.stringContaining("FAIL tests/tasks.test.ts"), totalCharacters: output.length, complete: false, truncatedBefore: true, truncatedAfter: false },
    nextCursor: null,
  });
  expect(JSON.stringify(result).length).toBeLessThan(2_000);
});

test("selected input is bounded and head cursors provide complete access", () => {
  const command = `apply_patch ${"x".repeat(120_000)}`;
  const tools = [tool({ id: "patch", command })];
  const first = readWorkerEvidence(tools, { toolId: "patch", field: "input", position: "head", maxCharacters: 1_000 });
  if (first.kind !== "tool") throw new Error("Expected selected tool evidence");
  expect(first.evidence.text).toHaveLength(1_000);
  expect(first.evidence.truncatedAfter).toBe(true);
  expect(first.nextCursor).toBe("field:1000");
  expect(JSON.stringify(first).length).toBeLessThan(2_000);

  const second = readWorkerEvidence(tools, { toolId: "patch", field: "input", position: "head", cursor: first.nextCursor ?? undefined, maxCharacters: 1_000 });
  if (second.kind !== "tool") throw new Error("Expected selected tool evidence");
  expect(second.evidence.offset).toBe(1_000);
  expect(second.evidence.truncatedBefore).toBe(true);
});

test("selected evidence rejects unknown tools and invalid cursors", () => {
  const tools = [tool()];
  expect(() => readWorkerEvidence(tools, { toolId: "missing", field: "output", position: "tail", maxCharacters: 1_000 })).toThrow("does not exist");
  expect(() => readWorkerEvidence(tools, { toolId: "tool-1", field: "output", position: "tail", cursor: "field:10", maxCharacters: 1_000 })).toThrow("only valid for head");
  expect(() => readWorkerEvidence(tools, { toolId: "tool-1", field: "output", position: "head", cursor: "field:999", maxCharacters: 1_000 })).toThrow("out of range");
});
