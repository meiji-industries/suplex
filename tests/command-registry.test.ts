import { serializerCompiler, validatorCompiler } from "@fastify/type-provider-zod";
import Fastify from "fastify";
import { expect, test } from "vitest";

import { ISSUE_COMMAND_NAMES, ISSUE_COMMAND_SLUGS, issueCommands, routedIssueCommands } from "../src/commands/registry.js";
import type { TaskService } from "../src/tasks.js";
import taskRoutes from "../src/http/routes/tasks.js";

test("command registry has exactly the frozen names and slugs", () => {
  expect(Object.keys(issueCommands).sort()).toEqual([...ISSUE_COMMAND_NAMES].sort());

  const slugs = Object.values(issueCommands).flatMap((descriptor) => descriptor.slug === null ? [] : [descriptor.slug]);
  expect(new Set(slugs)).toEqual(new Set(ISSUE_COMMAND_SLUGS));
  expect(slugs.every((slug) => ISSUE_COMMAND_SLUGS.includes(slug as (typeof ISSUE_COMMAND_SLUGS)[number]))).toBe(true);
  expect(issueCommands.record_progress.slug).toBe("record-progress");

  for (const [name, descriptor] of Object.entries(issueCommands)) {
    expect(descriptor.name).toBe(name);
  }
});

test("task command routes stay in registry parity", async () => {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(taskRoutes, { tasks: {} as TaskService });
  await app.ready();

  try {
    const commandSlugs = [...ISSUE_COMMAND_SLUGS, "reject-plan"];
    const routes = commandSlugs.filter((slug) => app.hasRoute({ method: "POST", url: `/api/tasks/:taskId/${slug}` })).sort();
    const expected = [...routedIssueCommands.map((descriptor) => descriptor.slug!), "revise-plan", "continue-work", "reject-plan", "resolve-decision-blocker"].sort();

    expect(routes).toEqual(expected);
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
        "retry-capacity",
        "retry-development",
        "retry-forward-merge-verification",
        "retry-target-base-reconciliation",
        "review-delivery",
        "revise-plan",
        "start-development",
        "start-planning",
        "tell-planner",
      ]
    `);
  } finally {
    await app.close();
  }
});
