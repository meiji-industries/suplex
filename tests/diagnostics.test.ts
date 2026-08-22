import { describe, expect, test } from "vitest";

import { formatDoctor } from "../src/diagnostics/doctor.js";
import { formatTaskDiagnostic } from "../src/diagnostics/task.js";

describe("operator diagnostics formatting", () => {
  test("makes a projection/live disagreement conspicuous", () => {
    const output = formatTaskDiagnostic({
      taskId: "task-1",
      projection: { title: "Repair build", phase: "planning", revision: 3, owner: "human", pendingAction: "Approve", allowedCommands: ["approve"] },
      live: { phase: "development", revision: 4, allowedCommands: ["retry_development"], differences: [{ field: "phase" }] },
      workflow: { status: "RUNNING", buildId: "build-old", pendingWorkflowTaskAgeSeconds: 61, lastFailure: "worker lost" },
      executions: [], capacity: [], commands: [], history: [],
    });
    expect(output).toContain("DIFF");
    expect(output).toContain("build-old");
    expect(output).toContain("worker lost");
  });

  test("keeps doctor status at the front of every line", () => {
    expect(formatDoctor([{ status: "PASS", name: "sqlite WAL", detail: "wal" }, { status: "FAIL", name: "replay open workflows", detail: "task-1: nondeterministic" }])).toBe("PASS sqlite WAL: wal\nFAIL replay open workflows: task-1: nondeterministic\n");
  });
});
