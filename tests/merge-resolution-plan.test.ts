import { describe, expect, it } from "vitest";
import { MergeConflictPlanSchema } from "../src/temporal/contracts/primitives.js";

const mechanical = { kind: "merge_conflict_plan", summary: "Resolve both invariants", resolutions: [{ number: 1, file: "a.ts", resolution: "preserve both", intendedResult: "both", issueInvariant: "issue", baseInvariant: "base", compatibilityConcern: "compat" }], verificationStrategy: "pnpm test", unresolvedQuestions: [] };

describe("merge conflict plan disposition", () => {
  it("accepts mechanical and structured product decisions", () => {
    expect(MergeConflictPlanSchema.parse(mechanical).disposition).toBe("mechanical");
    expect(MergeConflictPlanSchema.parse({ ...mechanical, disposition: "product_decision", resolutions: [], question: "Which behavior?", choices: [{ id: "a", label: "A", description: "A" }, { id: "b", label: "B", description: "B" }], recommendedChoiceId: "a" }).disposition).toBe("product_decision");
  });

  it("rejects incomplete product decisions", () => {
    expect(() => MergeConflictPlanSchema.parse({ ...mechanical, disposition: "product_decision", resolutions: [], question: "Which behavior?" })).toThrow();
  });
});
