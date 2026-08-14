import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { DeveloperRecoveryActions } from "../src/frontend/components/app/developer-recovery-actions.js";
import { DeveloperRecoveryStatus } from "../src/frontend/components/app/developer-recovery-status.js";
import { SystemHealthProvider } from "../src/frontend/components/app/system-health.js";
import { TaskActions } from "../src/frontend/views/task-details.js";
import type { ApiTask } from "../src/frontend/lib/view-shared.js";

test("only Developer cancellation remains available while another task command is pending", () => {
  const html = renderToStaticMarkup(createElement(DeveloperRecoveryActions, {
    allowedCommands: ["cancel_development", "cancel_issue"],
    busy: true,
    isAdmin: true,
    onAction: async () => undefined,
  }));

  const developmentButton = html.match(/<button[^>]*>Cancel development<\/button>/)?.[0];
  expect(developmentButton).toBeDefined();
  expect(developmentButton).not.toMatch(/\sdisabled(?:=|\s|>)/);
  expect(html).not.toContain("Cancel issue");
});

test("recovery actions render in the shared card footer", () => {
  const html = renderToStaticMarkup(createElement(DeveloperRecoveryStatus, {
    taskId: "task-1",
    recovery: { status: "active", reasonCode: null, summary: "Developer result claimed.", lastHeartbeatAt: null, currentOwner: "forge", evidenceArtifactId: null, nextAction: null },
    allowedCommands: ["cancel_development"],
    busy: false,
    isAdmin: true,
    onAction: async () => undefined,
  }));

  expect(html).toContain('data-slot="card"');
  expect(html).toContain('data-slot="card-footer"');
  expect(html).toContain('role="alert"');
  expect(html).toContain('role="button"');
  expect(html).toContain('tabindex="0"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('data-panel-open=""');
  expect(html).toContain("Cancel development");
  expect(html).not.toContain("Developer result claimed.");
});

test("keeps actionable Developer recovery summaries", () => {
  const html = renderToStaticMarkup(createElement(DeveloperRecoveryStatus, {
    taskId: "task-1",
    recovery: { status: "failed", reasonCode: "developer-failed", summary: "The Implementer process exited before returning a result.", lastHeartbeatAt: null, currentOwner: "forge", evidenceArtifactId: null, nextAction: null },
    allowedCommands: ["retry_development"],
    busy: false,
    isAdmin: true,
    onAction: async () => undefined,
  }));

  expect(html).toContain("The Implementer process exited before returning a result.");
});

test("claimed Developer recovery does not hide delivery review actions", () => {
  const task = {
    phase: "delivery_ready",
    allowedCommands: ["review_delivery"],
    commands: [],
    pendingAction: "Lead delivery review",
    projection: { status: "current" },
    developerExecution: { branchName: "work/readme-joke", worktreePath: "/tmp/forge/worktrees/task-1", resultCommit: "a".repeat(40) },
    developerRecovery: { status: "active" },
  } as unknown as ApiTask;
  const html = renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskActions, {
    task,
    busy: false,
    onStartPlanning: async () => undefined,
    onPlanAction: async () => undefined,
    onRevisePlan: async () => undefined,
    onContinueWork: async () => undefined,
  }) }));
  expect(html).toContain("Review completed delivery");
  expect(html).toContain("/tmp/forge/worktrees/task-1");
  expect(html).toContain("work/readme-joke");
  expect(html).toContain("Approve delivery");
});

test("shows the exact draft publication preview and diff action", () => {
  const task = {
    phase: "releasing",
    allowedCommands: ["accept_delivery", "publish_draft", "request_delivery_changes"],
    commands: [],
    pendingAction: "Publish draft pull request",
    projection: { status: "current" },
    developerExecution: { status: "completed", branchName: "work/readme-joke", resultCommit: "a".repeat(40) },
    release: { repository: "acme/forge", baseBranch: "main", headBranch: "work/readme-joke", title: "Add a sound-decision pun", bodyPreview: "Summary\n\nA long description that reviewers should see before opening the diff." },
  } as unknown as ApiTask;
  const html = renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskActions, {
    task,
    busy: false,
    onStartPlanning: async () => undefined,
    onPlanAction: async () => undefined,
    onRevisePlan: async () => undefined,
    onContinueWork: async () => undefined,
    onOpenDiff: () => undefined,
  }) }));
  expect(html).toContain('data-task-publish-preview="true"');
  expect(html).toContain("What will be published?");
  expect(html).toContain("Add a sound-decision pun");
  expect(html).toContain("A long description that reviewers should see before opening the diff.");
  expect(html).toContain(">Diff<");
  expect(html).toContain(">Publish<");
  expect(html).toContain(">Publish Draft<");
  expect(html).toContain(">Request Changes<");
  expect(html.indexOf(">Publish<")).toBeLessThan(html.indexOf(">Publish Draft<"));
  expect(html.indexOf(">Publish Draft<")).toBeLessThan(html.indexOf(">Request Changes<"));
});

test("claimed Developer recovery does not remain an active Development card", () => {
  const html = renderToStaticMarkup(createElement(DeveloperRecoveryStatus, {
    taskId: "task-1",
    recovery: { status: "active", reasonCode: null, summary: "Developer result claimed.", lastHeartbeatAt: null, currentOwner: "forge", evidenceArtifactId: "evidence-1", nextAction: null },
    allowedCommands: ["review_delivery"],
    busy: false,
    isAdmin: true,
    onAction: async () => undefined,
  }));
  expect(html).toBe("");
});
