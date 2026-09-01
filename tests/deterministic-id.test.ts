import { expect, test } from "vitest";

import { developerExecutionId } from "../src/engine/deterministic-id.js";

test("developer execution IDs remain stable", () => {
  expect(developerExecutionId("wf", 1, 1, "implementation")).toBe("developer_e51eaf910dec62bfe8abf8a3");
});
