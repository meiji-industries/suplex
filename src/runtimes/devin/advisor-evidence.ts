import { readFile } from "node:fs/promises";
import { AdvisorResultSchema } from "../../coordination/advisor-report.js";
import type { TaskExecution } from "../../tasks/execution/contracts.js";
import { advisorBridgeResultPath } from "../task-harness.js";

export async function readDevinAdvisorEvidence(runtimeDirectory: string, turnId: string): Promise<{ tools: TaskExecution["sessions"][number]["tools"]; limitation: string | null }> {
  const path = advisorBridgeResultPath(runtimeDirectory, turnId);
  try {
    const result = AdvisorResultSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return {
      tools: [{ id: `devin-advisor-report-${turnId}`, name: "mcp__forge_advisor__submit_report", status: "completed", input: {}, output: JSON.stringify({ structuredContent: result }), error: null }],
      limitation: "Devin CLI does not expose other machine-readable tool evidence.",
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { tools: [], limitation: "Devin CLI does not expose machine-readable tool evidence." };
    throw error;
  }
}
