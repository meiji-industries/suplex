import { expect, test } from "vitest";

import { repairCoverage } from "../src/codex-developer.js";
import { repairCoveragePrompt } from "../src/codex-lead.js";

const finding = {
  findingId: "finding_active_role_flip",
  severity: "blocking" as const,
  rationale: "The role does not update.",
  evidenceRef: "src/frontend/components/app/task-chat/task-chat.tsx",
  disposition: "open" as const,
  repairInstruction: "Update src/frontend/components/app/task-chat/task-chat.tsx.",
};

test("a repair that misses named files produces coverage text", () => {
  const coverage = repairCoverage([finding], ["src/frontend/components/app/other.tsx"]);

  expect(repairCoveragePrompt(JSON.stringify({ coverage }))).toBe("Repair coverage: finding_active_role_flip names src/frontend/components/app/task-chat/task-chat.tsx; the repair commit did not touch it.");
});

test("a repair that touches named files produces no coverage text", () => {
  const coverage = repairCoverage([finding], ["src/frontend/components/app/task-chat/task-chat.tsx"]);

  expect(repairCoveragePrompt(JSON.stringify({ coverage }))).toBe("");
});
