import { globSync, readFileSync } from "node:fs";

import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import Fastify from "fastify";
import { expect, test } from "vitest";

import { ISSUE_COMMAND_NAMES, ISSUE_COMMAND_SLUGS, issueCommands, routedIssueCommands } from "../src/commands/registry.js";
import type { TaskService } from "../src/tasks.js";
import taskRoutes from "../src/http/routes/tasks.js";
import { issueUpdates } from "../src/temporal/issue-updates.js";

const BESPOKE_COMMANDS = ["reject_plan", "revise_plan", "continue_work", "record_progress", "resolve_decision_blocker", "resync_projection"] as const;

test("issue command registry stays complete across descriptors, updates, routes, and slugs", async () => {
  const entries = Object.entries(issueCommands);
  expect(entries).toHaveLength(ISSUE_COMMAND_NAMES.length);
  expect(new Set(entries.map(([name]) => name)).size).toBe(ISSUE_COMMAND_NAMES.length);
  expect(new Set(entries.map(([, descriptor]) => descriptor.name)).size).toBe(ISSUE_COMMAND_NAMES.length);

  for (const name of ISSUE_COMMAND_NAMES) {
    const descriptors = entries.filter(([key, descriptor]) => key === name && descriptor.name === name);
    expect(descriptors, `${name} must have exactly one descriptor`).toHaveLength(1);
    expect(issueUpdates[name].name).toBe(issueCommands[name].updateName);
  }

  const descriptorSlugs = entries.flatMap(([, descriptor]) => descriptor.slug === null ? [] : [descriptor.slug]);
  expect(new Set(descriptorSlugs).size).toBe(descriptorSlugs.length);
  expect([...descriptorSlugs].sort()).toEqual([...ISSUE_COMMAND_SLUGS].sort());

  const bespokeCommands = ISSUE_COMMAND_NAMES.filter((name) => issueCommands[name].family === "bespoke").sort();
  expect(bespokeCommands).toEqual([...BESPOKE_COMMANDS].sort());

  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(taskRoutes, { tasks: {} as TaskService });
  await app.ready();
  try {
    const routedDescriptors = ISSUE_COMMAND_NAMES
      .map((name) => issueCommands[name])
      .filter((descriptor) => descriptor.family !== "bespoke" && descriptor.slug !== null);
    expect(routedDescriptors.map((descriptor) => descriptor.slug)).toEqual(routedIssueCommands.map((descriptor) => descriptor.slug));
    for (const descriptor of routedDescriptors) {
      expect(app.hasRoute({ method: "POST", url: `/api/tasks/:taskId/${descriptor.slug}` }), `${descriptor.name} route is missing`).toBe(true);
    }
    const routes = [...ISSUE_COMMAND_SLUGS, "reject-plan"].filter((slug) => app.hasRoute({ method: "POST", url: `/api/tasks/:taskId/${slug}` })).sort();
    expect(routes).toMatchInlineSnapshot(`
      [
        "accept-delivery",
        "approve-plan",
        "cancel",
        "cancel-development",
        "continue-work",
        "final-review",
        "publish-draft",
        "reconcile-acceptance",
        "reconcile-ci",
        "reconcile-merge",
        "record-delivery-decision",
        "reject-plan",
        "repair-ci",
        "repair-delivery",
        "request-delivery-changes",
        "request-plan-revision",
        "request-supplemental-review",
        "resolve-decision-blocker",
        "resolve-merge-conflict",
        "respond-plan-blocker",
        "resync-projection",
        "retry-capacity",
        "retry-development",
        "retry-forward-merge-verification",
        "retry-target-base-reconciliation",
        "review-delivery",
        "revise-plan",
        "start-development",
        "start-planning",
        "verify-developer-ownership",
      ]
    `);
  } finally {
    await app.close();
  }
});

const budgets: Record<string, number> = {
  "src/temporal/workflows.ts": 450,
  "src/temporal/issue-contracts.ts": 120,
  "src/temporal/activities.ts": 5,
  "src/tasks.ts": 2_473,
  "src/frontend/main.tsx": 20,
  "src/http/routes/tasks.ts": 179,
  "src/temporal/service.ts": 400,
};

for (const [file, budget] of Object.entries(budgets)) {
  test(`${file} stays within ${budget} lines`, () => {
    const lines = readFileSync(file, "utf8").split("\n").length;
    expect(lines, `${file} grew past its budget — new code goes in the per-domain modules (docs/plans/2026-08-12-conflict-hotspot-refactor.md)`).toBeLessThanOrEqual(budget);
  });
}

test("navigation links do not render through the Button primitive", () => {
  for (const file of globSync("src/frontend/**/*.tsx")) {
    expect(readFileSync(file, "utf8"), file).not.toMatch(/<Button\b[^>]*\brender=\{<a\b/);
  }
});
