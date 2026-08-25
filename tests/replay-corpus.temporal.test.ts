import { expect, test } from "vitest";

import { connectTemporal } from "../src/temporal/service.js";
import { runReplayScenarioCorpus } from "./replay-scenario-driver.js";
import { replayScenarios } from "./replay-scenarios/index.js";
import { captureWorkflowHistory } from "../scripts/capture-workflow-history.js";
import { createTemporalHarness } from "./helpers/temporal-harness.js";

test("runs and replays the Temporal scenario corpus", async () => {
  const harness = createTemporalHarness();
  await harness.start();
  const { config } = harness;
  try {
    const scenarioClient = await connectTemporal(config);
    try {
      const executions = await runReplayScenarioCorpus({ client: scenarioClient.client.workflow, connection: harness.workerConnection, namespace: config.temporalNamespace, taskQueue: `${config.taskQueue}-replay-scenarios` });
      expect(executions.map(({ scenario }) => scenario)).toEqual(replayScenarios.map((definition) => definition.name));
      expect(executions.find(({ scenario }) => scenario === "normal_success")?.currentPhase).toBe("done");
      expect(executions.find(({ scenario }) => scenario === "continue_as_new")?.finalState.continuationCount).toBe(2);
      for (const execution of executions) {
        const revisions = execution.projections.map(({ revision }) => revision);
        expect(new Set(revisions).size, `duplicate projected revision in ${execution.scenario}: ${execution.projections.map(({ revision, phase, continuationCount }) => `${revision}:${phase}:${continuationCount}`).join(",")}`).toBe(revisions.length);
      }
      if (process.env.FORGE_REPLAY_CAPTURE_PATH) {
        const replacementIds = Object.fromEntries(replayScenarios.map((definition) => [definition.name, definition.captureId])) as Partial<Record<(typeof executions)[number]["scenario"], string>>;
        const requested = new Set((process.env.FORGE_REPLAY_CAPTURE_SCENARIOS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
        for (const execution of executions.filter(({ scenario }) => requested.size === 0 || requested.has(scenario))) await captureWorkflowHistory({ address: config.temporalAddress, namespace: config.temporalNamespace, workflowId: execution.workflowId, firstRunId: execution.firstRunId, scenario: execution.scenario, currentPhase: execution.currentPhase, outputDir: process.env.FORGE_REPLAY_CAPTURE_PATH, ...(replacementIds[execution.scenario] ? { replace: replacementIds[execution.scenario] } : {}) });
      }
    } finally {
      await scenarioClient.connection.close();
    }


  } finally {
    await harness.stop();
  }
}, 120_000);
