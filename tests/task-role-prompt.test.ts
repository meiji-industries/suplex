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

it.each([
  { workerMode: "planned", purpose: "implementation" },
  { workerMode: "planned", purpose: "verification" },
  { workerMode: "direct", purpose: "implementation" },
  { workerMode: "direct", purpose: "verification" },
] as const)("gives every $workerMode $purpose Worker enough check time", options => {
  const prompt = taskRolePrompt("worker", options);
  expect(prompt.match(/For configured verification commands, set a 30-minute shell timeout, or the tool maximum if lower\. Normal completion ends the command immediately\./g)).toHaveLength(1);
});

it.each([
  { workerMode: "planned", purpose: "implementation" },
  { workerMode: "direct", purpose: "implementation" },
] as const)("gives $workerMode Workers implementation ownership", options => {
  const prompt = taskRolePrompt("worker", options);
  expect(prompt).toContain("own the design and implementation choices within that assignment");
  expect(prompt).toContain("routine internal seams, fixture corrections, and tests");
  expect(prompt).toContain("Continue until the complete assignment and its necessary checks are done");
  expect(prompt).not.toMatch(/Return missing design decisions|Coordinator owns planning, design decisions|Do not take over planning/);
});
