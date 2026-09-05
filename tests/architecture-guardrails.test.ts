import { existsSync, readFileSync, readdirSync } from "node:fs";
import { expect, test } from "vitest";
import { TaskInputSchema } from "../src/task-contracts.js";
import { ProjectBodySchema } from "../src/http/contracts/projects.js";
import { AgentProfileInputSchema } from "../src/agent-profile-contracts.js";

test("task and project configuration have no phase, mirror gate, or harness capacity fields", () => {
  expect(Object.keys(TaskInputSchema.shape)).not.toEqual(expect.arrayContaining(["expectedRevision"]));
  expect(Object.keys(ProjectBodySchema.shape).sort()).toEqual(["baseBranch", "name", "repository", "repositoryPath", "rootProfileId", "setupCommand", "verificationCommand", "workerProfileId", "worktreeRoot"]);
  expect(Object.keys(AgentProfileInputSchema.shape).sort()).toEqual(["avatarSeed", "model", "name", "provider", "reasoningLevel", "role", "serviceTier"]);
  expect(existsSync("src/engine/index.ts")).toBe(false);
  expect(existsSync("src/capacity.ts")).toBe(false);
});

test("production source does not import the retired phase engine or harness relays", () => {
  const paths = readdirSync("src", { recursive: true, encoding: "utf8" }).filter(path => /\.tsx?$/.test(path));
  for (const path of paths) {
    const source = readFileSync(`src/${path}`, "utf8");
    expect(source, path).not.toMatch(/from ["'][^"']*(?:engine\/|agent-providers\/|github-release\.js|worktrees\.js)["']/);
  }
});

test("native task UI has Root and Worker without old role selectors", () => {
  const source = readFileSync("src/frontend/components/app/new-task-dialog.tsx", "utf8");
  expect(source).toContain('role: "Root"');
  expect(source).toContain('role: "Worker"');
  expect(source).toContain("startImmediately");
  expect(source).not.toMatch(/planner|builder|reviewer|integrator/);
});
