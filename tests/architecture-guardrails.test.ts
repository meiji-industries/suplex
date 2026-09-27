import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { TaskInputSchema } from "../src/frontend/contracts/tasks.js";
import { ProjectBodySchema } from "../src/frontend/contracts/projects.js";
import { AgentProfileInputSchema } from "../src/frontend/contracts/profiles.js";

test("task and project configuration have no phase, mirror gate, or harness capacity fields", () => {
  expect(Object.keys(TaskInputSchema.shape)).not.toEqual(expect.arrayContaining(["expectedRevision"]));
  expect(Object.keys(ProjectBodySchema.shape).sort()).toEqual(["agentTaskPolicy", "baseBranch", "execution", "integration", "name", "providerPolicy", "repository", "repositoryPath", "rootProfileId", "setupCommand", "verificationCommand", "workerProfileId", "worktreeRoot"]);
  expect(Object.keys(AgentProfileInputSchema.shape).sort()).toEqual(["avatarSeed", "model", "name", "provider", "providerInstanceId", "reasoningLevel", "role", "serviceTier"]);
});

test("TypeScript application source is confined to the browser", () => {
  expect(readdirSync("src")).toEqual(["frontend"]);
  const frontend = resolve("src/frontend") + sep;
  const paths = readdirSync("src/frontend", { recursive: true, encoding: "utf8" }).filter(path => /\.[jt]sx?$/.test(path));
  for (const path of paths) {
    const owner = resolve(frontend, path);
    const source = ts.createSourceFile(owner, readFileSync(owner, "utf8"), ts.ScriptTarget.Latest, false);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      expect(specifier.text, owner).not.toMatch(/^(?:node:|better-sqlite3|child_process|fs(?:\/|$)|fastify|drizzle-orm)/);
      if (specifier.text.startsWith(".")) expect(resolve(dirname(owner), specifier.text).startsWith(frontend), `${owner}: ${specifier.text}`).toBe(true);
    }
  }
});

test("native task UI has Coordinator, Worker, and workflow Advisors without the old role selectors", () => {
  const source = readFileSync("src/frontend/features/tasks/new-task-dialog.tsx", "utf8");
  expect(source).toContain('role="root"');
  expect(source).toContain('role="worker"');
  expect(source).toContain("startImmediately");
  expect(source).not.toMatch(/builder|integrator|role="planner"|role="reviewer"/);
  expect(source).toContain("advisorRoles");
});
