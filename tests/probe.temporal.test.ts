import { expect, test } from "vitest";

import { queryProbeWorkflow, startProbeWorkflow } from "../src/temporal/service.js";
import { createTemporalHarness } from "./helpers/temporal-harness.js";

test("starts, persists, restarts, and queries a probe Workflow in isolated test infrastructure", async () => {
  const harness = createTemporalHarness();
  await harness.start();
  try {
    const started = await startProbeWorkflow(harness.config, { probeId: "probe-restart", companyId: "company-1" });
    let state = await queryProbeWorkflow(harness.config, started.workflowId, started.runId);
    for (let attempt = 0; attempt < 20 && state.status !== "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await queryProbeWorkflow(harness.config, started.workflowId, started.runId);
    }
    expect(state.status).toBe("running");
    expect(harness.database.getProbe("probe-restart")).toEqual({ workflowId: started.workflowId, probeId: "probe-restart", companyId: "company-1", status: "running" });
    await harness.restartWorker();
    const afterRestart = await queryProbeWorkflow(harness.config, started.workflowId, started.runId);
    expect(afterRestart.status).toBe("running");
    expect(harness.database.getProbe("probe-restart")?.workflowId).toBe(started.workflowId);
  } finally {
    await harness.stop();
  }
}, 120_000);
