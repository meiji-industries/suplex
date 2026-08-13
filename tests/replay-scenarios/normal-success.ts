import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "normal_success",
  captureId: "normal-success-v1",
  activityOverrides: {},
  async script(handle, helpers) {
    return helpers.drive(handle, { acceptance: "accept", merge: true });
  },
} satisfies ReplayScenarioDefinition<"normal_success">;
