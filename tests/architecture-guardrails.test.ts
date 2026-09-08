import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { TaskInputSchema } from "../src/tasks/contracts.js";
import { ProjectBodySchema } from "../src/http/contracts/projects.js";
import { AgentProfileInputSchema } from "../src/profiles/agent-profile-contracts.js";

test("task and project configuration have no phase, mirror gate, or harness capacity fields", () => {
  expect(Object.keys(TaskInputSchema.shape)).not.toEqual(expect.arrayContaining(["expectedRevision"]));
  expect(Object.keys(ProjectBodySchema.shape).sort()).toEqual(["baseBranch", "name", "repository", "repositoryPath", "rootProfileId", "setupCommand", "verificationCommand", "workerProfileId", "worktreeRoot"]);
  expect(Object.keys(AgentProfileInputSchema.shape).sort()).toEqual(["avatarSeed", "model", "name", "provider", "reasoningLevel", "role", "serviceTier"]);
  expect(existsSync("src/engine/index.ts")).toBe(false);
  expect(existsSync("src/capacity.ts")).toBe(false);
});

const sourceFiles = () => readdirSync("src", { recursive: true, encoding: "utf8" }).filter(path => /\.[jt]sx?$/.test(path)).map(path => `src/${path}`);
const valueImportSpecifiers = (path: string): string[] => {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false);
  return source.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) return clause ? [] : [statement.moduleSpecifier.text];
    if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return [statement.moduleSpecifier.text];
    return clause.namedBindings.elements.some(element => !element.isTypeOnly) ? [statement.moduleSpecifier.text] : [];
  });
};

test("production source has no runtime import of retired engine or relay modules", () => {
  for (const path of sourceFiles()) {
    for (const specifier of valueImportSpecifiers(path)) {
      expect(specifier, path).not.toMatch(/(?:^|\/)(?:engine\/|agent-providers\/|github-release\.js|worktrees\.js)/);
    }
  }
});
const localModule = (owner: string, specifier: string): string | null => {
  if (!specifier.startsWith(".")) return null;
  const stem = resolve(dirname(owner), specifier.replace(/\.js$/, ""));
  for (const suffix of [".ts", ".tsx", ".js", ".jsx"]) {
    const candidate = `${stem}${suffix}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const suffix of [".ts", ".tsx", ".js", ".jsx"]) {
    const candidate = resolve(stem, `index${suffix}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

test("only executable composition entrypoints remain at src root", () => {
  const rootFiles = readdirSync("src", { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort();
  expect(rootFiles).toEqual(["app.ts", "cli.ts", "server.ts"]);
});

test("browser code has no transitive server-only value dependency", () => {
  const visited = new Set<string>();
  const walk = (path: string, chain: string[]): void => {
    if (visited.has(path)) return;
    visited.add(path);
    for (const specifier of valueImportSpecifiers(path)) {
      expect(specifier, chain.join(" -> ")).not.toMatch(/^(?:node:|better-sqlite3|child_process|fs\/promises)/);
      const target = localModule(path, specifier);
      if (target) walk(target, [...chain, target]);
    }
  };
  for (const path of sourceFiles().filter(path => path.startsWith("src/frontend/"))) walk(path, [path]);
});

test("native task UI has Coordinator, Worker, and workflow Advisors without the old role selectors", () => {
  const source = readFileSync("src/frontend/features/tasks/new-task-dialog.tsx", "utf8");
  expect(source).toContain('role="root"');
  expect(source).toContain('role="worker"');
  expect(source).toContain("startImmediately");
  // Advisors (Reviewer, Plan A, Plan B, Rater) reuse root profiles; the retired builder/integrator roles stay out.
  expect(source).not.toMatch(/builder|integrator|role="planner"|role="reviewer"/);
  expect(source).toContain("advisorRoles");
});
