import { describe, expect, it } from "vitest";

import { taskRolePrompt } from "../src/task-role-prompt.js";

describe.each(["root", "worker"] as const)("%s Git boundary prompt", (role) => {
  it("does not freeze work at the captured SHA and still forbids force-pushing main", () => {
    const prompt = taskRolePrompt(role);

    expect(prompt).toContain("captured starting SHA records provenance; it does not permanently freeze the branch");
    expect(prompt).not.toContain("Work only on the captured task branch and starting revision");
    expect(prompt).toContain("Never force-push the main or base branch, or any shared branch");
  });
});
