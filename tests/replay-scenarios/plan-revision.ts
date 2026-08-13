import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";

export const scenario = {
  name: "plan_revision",
  captureId: "plan-revision-v1",
  activityOverrides: {},
  async script(handle, helpers) {
    return helpers.drive(handle, { planRevision: true });
  },
} satisfies ReplayScenarioDefinition<"plan_revision">;
