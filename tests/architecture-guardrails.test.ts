import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { TaskInputSchema } from "../apps/web/contracts/tasks.js";
import { ProjectBodySchema } from "../apps/web/contracts/projects.js";
import { AgentProfileInputSchema } from "../apps/web/contracts/profiles.js";

test("task and project configuration have no phase, mirror gate, or harness capacity fields", () => {
  expect(Object.keys(TaskInputSchema.shape)).not.toEqual(expect.arrayContaining(["expectedRevision"]));
  expect(Object.keys(ProjectBodySchema.shape).sort()).toEqual(["altProfileId", "baseBranch", "deliveryDefaults", "execution", "integration", "name", "providerPolicy", "repository", "repositoryPath", "rootProfileId", "setupCommand", "verificationCommand", "workerProfileId", "worktreeRoot"]);
  expect(Object.keys(AgentProfileInputSchema.shape).sort()).toEqual(["avatarSeed", "model", "name", "provider", "providerInstanceId", "reasoningLevel", "role", "serviceTier"]);
});

test("TypeScript application source is confined to the browser", () => {
  const frontend = resolve("apps/web") + sep;
  const paths = readdirSync("apps/web", { recursive: true, encoding: "utf8" })
    // Tooling configs, tests, dependencies, and build output run in Node or are not application source.
    .filter(path => /\.[jt]sx?$/.test(path) && !/^(?:node_modules|dist|tests)[\\/]|^[^\\/]+\.config\.ts$/.test(path));
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
  const source = readFileSync("apps/web/features/tasks/new-task-dialog.tsx", "utf8");
  expect(source).toContain('role="root"');
  expect(source).toContain('role="worker"');
  expect(source).toContain("startImmediately");
  expect(source).not.toMatch(/builder|integrator|role="planner"|role="reviewer"/);
  expect(source).toContain("advisorRoles");
});
