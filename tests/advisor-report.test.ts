import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { advisorReportFromTurn, advisorReportInputSchema, parseAdvisorReport } from "../src/coordination/advisor-report.js";
import { startAdvisorReportBridgeTransport } from "../src/coordination/advisor-report-bridge.js";
import { writeAdvisorReportBridgeBinding } from "../src/runtimes/task-harness.js";
import { initializeAndList, runMcpProcess } from "./helpers/mcp-process.js";

const report = { rating: 9, blockingFindings: [], verification: "passed", verificationSummary: "Focused tests passed", summary: "Ready" };
const tool = (value: unknown, overrides: Partial<{ name: string; status: "pending" | "running" | "completed" | "error"; output: string | null }> = {}) => ({ name: "suplex_advisor_submit_report", status: "completed" as const, output: JSON.stringify(value), ...overrides });

it("the Advisor bridge process authenticates and atomically retains its latest valid submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "suplex-advisor-bridge-auth-"));
  try {
    const server = await writeAdvisorReportBridgeBinding({ runtimeDirectory: directory, role: "rater" });
    const resultPath = join(directory, "turn-result.json");
    const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => !["SUPLEX_ADVISOR_TOKEN", "SUPLEX_ADVISOR_RESULT"].includes(key) && value !== undefined));
    for (const token of [undefined, "00000000-0000-4000-8000-000000000000"]) {
      const attempt = await runMcpProcess(server, { ...cleanEnvironment, SUPLEX_ADVISOR_BINDING: server.environment.SUPLEX_ADVISOR_BINDING!, ...(token ? { SUPLEX_ADVISOR_TOKEN: token } : {}) }, initializeAndList);
      expect(attempt.responses).toEqual([]);
      expect(attempt.stderr).toContain("authentication failed");
    }
    const first = { ...report, rating: 8, summary: "Revise" };
    const second = { ...report, rating: 10, summary: "Ready after revision" };
    const requests = [
      ...initializeAndList,
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "submit_report", arguments: first } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "submit_report", arguments: { rating: 9 } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "submit_report", arguments: second } },
    ];
    const accepted = await runMcpProcess(server, { ...cleanEnvironment, ...server.environment, SUPLEX_ADVISOR_RESULT: resultPath }, requests);
    expect(accepted.responses).toHaveLength(5);
    expect(accepted.responses.slice(0, 2)).toMatchObject([{ result: { serverInfo: { name: "suplex-advisor-report" } } }, { result: { tools: [{ name: "submit_report" }] } }]);
    expect(await readFile(resultPath, "utf8").then(JSON.parse)).toEqual({ ...second, role: "rater" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Advisor report parsing", () => {
  it("derives the role-bound MCP input schema without accepting a role argument", () => {
    expect(advisorReportInputSchema("rater")).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["rating", "blockingFindings", "verification", "verificationSummary", "summary"],
      properties: { rating: { type: "integer", minimum: 1, maximum: 10 } },
    });
    expect(advisorReportInputSchema("rater")).not.toMatchObject({ properties: { role: expect.anything() } });
  });

  it("accepts raw JSON and a complete object after an unclosed JSON fence", () => {
    expect(parseAdvisorReport("rater", JSON.stringify(report))).toMatchObject({ result: { role: "rater", rating: 9 } });
    expect(parseAdvisorReport("rater", `Assessment complete.\n\n\`\`\`json\n${JSON.stringify(report)}\n`)).toMatchObject({ result: { role: "rater", rating: 9 } });
  });

  it("rejects truncated JSON and missing semantic fields", () => {
    expect(parseAdvisorReport("rater", `\`\`\`json\n${JSON.stringify(report).slice(0, -2)}`)).toMatchObject({ result: null, invalidReason: expect.stringContaining("not valid") });
    expect(parseAdvisorReport("rater", JSON.stringify({ rating: 9 }))).toMatchObject({ result: null, invalidReason: expect.stringContaining("blockingFindings") });
  });

  it("uses only the last explicit legacy report", () => {
    expect(parseAdvisorReport("rater", `\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n\`\`\`json\n${JSON.stringify({ ...report, rating: 10 })}\n\`\`\``)).toMatchObject({ result: { rating: 10 } });
    expect(parseAdvisorReport("rater", `\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(report).slice(0, -2)}`)).toMatchObject({ result: null, invalidReason: expect.stringContaining("not valid") });
  });

  it("prefers a successful structured call over prose and accepts a correction after a failed call", () => {
    const tools = [
      tool(null, { status: "error", output: null }),
      tool({ ...report, role: "rater" }, { name: "mcp__suplex_advisor__submit_report" }),
    ];
    expect(advisorReportFromTurn("rater", tools, JSON.stringify({ ...report, rating: 2 }))).toMatchObject({ result: { role: "rater", rating: 9 } });
  });

  it("uses the latest successful valid structured submission", () => {
    const tools = [
      tool({ ...report, role: "rater", rating: 9 }),
      tool({ ...report, role: "rater", rating: 10 }),
    ];
    expect(advisorReportFromTurn("rater", tools, "No JSON here")).toMatchObject({ result: { role: "rater", rating: 10 } });
  });

  it("ignores an MCP error envelope before a successful correction", () => {
    const errorEnvelope = { isError: true, structuredContent: { ...report, role: "rater", rating: 10 } };
    const tools = [
      tool(errorEnvelope),
      tool({ isError: false, structuredContent: { ...report, role: "rater", rating: 9 } }),
    ];
    expect(advisorReportFromTurn("rater", tools, "No JSON here")).toMatchObject({ result: { role: "rater", rating: 9 } });
    expect(advisorReportFromTurn("rater", [tool({ ...report, role: "rater", rating: 9 }), tool(errorEnvelope)], "No JSON here")).toMatchObject({ result: { role: "rater", rating: 9 } });
  });

  it("ignores unrelated and failed tools and rejects a successful result for the wrong role", () => {
    expect(advisorReportFromTurn("rater", [tool(report, { name: "submit_other" })], JSON.stringify(report))).toMatchObject({ result: { rating: 9 } });
    expect(advisorReportFromTurn("reviewer", [tool({ ...report, role: "rater" })], "Approval prose")).toMatchObject({ result: null });
    expect(advisorReportFromTurn("reviewer", [tool({ ...report, role: "rater" })], JSON.stringify({ approved: false, blockingFindings: ["src/a.ts: defect"], verification: "failed", verificationSummary: "Failed", summary: "Repair" }))).toMatchObject({ result: null, invalidReason: expect.stringContaining("role") });
    expect(advisorReportFromTurn("planner_a", [tool({ role: "planner_b", summary: "Alternate plan" })], JSON.stringify({ summary: "Legacy plan" }))).toMatchObject({ result: null, invalidReason: expect.stringContaining("role") });
  });
});

it("the Advisor bridge returns field errors and then a validated structured result", async () => {
  const stdin = new PassThrough();
  const lines: string[] = [];
  const transport = startAdvisorReportBridgeTransport({ role: "rater", stdin, stdout: { write: chunk => { lines.push(chunk); return true; } } });
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_report", arguments: { rating: 9 } } })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "submit_report", arguments: report } })}\n`);
  await new Promise(resolve => setImmediate(resolve));
  transport.close();
  const responses = lines.map(line => JSON.parse(line) as { id: number; result: { isError?: boolean; structuredContent?: unknown; content: Array<{ text: string }> } });
  expect(responses.find(response => response.id === 2)?.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("blockingFindings") }] });
  expect(responses.find(response => response.id === 3)?.result).toMatchObject({ structuredContent: { role: "rater", rating: 9 } });
});
