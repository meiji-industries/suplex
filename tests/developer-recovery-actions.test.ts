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
  expect(html.match(/<div data-slot="card-footer"[^>]*>/)?.[0]).toContain("justify-end");
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
    recovery: { status: "failed", reasonCode: "developer-failed", summary: "The Builder process exited before returning a result.", lastHeartbeatAt: null, currentOwner: "forge", evidenceArtifactId: null, nextAction: null },
    allowedCommands: ["retry_development"],
    busy: false,
    isAdmin: true,
    onAction: async () => undefined,
  }));

  expect(html).toContain("The Builder process exited before returning a result.");
});

test("claimed Developer recovery does not hide delivery review actions", () => {
  const task = {
    phase: "delivery_blocked",
    allowedCommands: ["review_delivery"],
    commands: [],
    pendingAction: "Lead delivery review",
    projection: { status: "current" },
    developerExecution: { branchName: "work/readme-joke", worktreePath: "/tmp/forge/worktrees/task-1", resultCommit: "a".repeat(40), verificationResults: ["Server tests passed.", "Browser check unavailable."] },
    agentInvocations: [{ role: "builder", status: "completed", agentName: "Marin", avatarSeed: "marin" }],
    developerRecovery: { status: "active" },
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
  expect(html).toContain("Marin completed the approved work.");
  expect(html).toContain("In Review");
  expect(html).not.toContain('data-task-blocked-card="true"');
  expect(html).toContain('data-size="xs"');
  expect(html).toContain("Review the changes, then choose what happens next.");
  expect(html).toContain("/tmp/forge/worktrees/task-1");
  expect(html).not.toContain(">cd /tmp/forge/worktrees/task-1<");
  expect(html).toContain("work/readme-joke");
  expect(html).toContain("Copy worktree command");
  expect(html).toContain("Server tests passed.");
  expect(html).toContain("Browser check unavailable.");
  expect(html).not.toContain("Passed: ");
  expect(html).not.toContain("Delivered commit");
  expect(html).toContain("Looks Good");
  expect(html.indexOf(">Show Diff<")).toBeLessThan(html.indexOf(">Request Changes<"));
  expect(html.indexOf(">Request Changes<")).toBeLessThan(html.indexOf(">Looks Good<"));
});

test("explains required delivery changes in human terms", () => {
  const task = {
    phase: "repair_required",
    allowedCommands: ["repair_delivery"],
    commands: [],
    pendingAction: "Builder is fixing review findings",
    projection: { status: "current" },
    deliveryReview: { summary: "Keyboard and logout behavior still need browser verification.", findings: [{ id: "finding-1", severity: "blocking", disposition: "open", rationale: "Runtime behavior is unverified.", repairInstruction: "Verify keyboard navigation and the logout redirect at desktop and mobile widths." }] },
  } as unknown as ApiTask;
  const html = renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskActions, {
    task,
    busy: false,
    onStartPlanning: async () => undefined,
    onPlanAction: async () => undefined,
    onRevisePlan: async () => undefined,
    onContinueWork: async () => undefined,
  }) }));

  expect(html).toContain("More proof is needed");
  expect(html).toContain("Missing verification: Verify keyboard navigation and the logout redirect at desktop and mobile widths.");
  expect(html).toContain("Run missing check");
  expect(html).toContain("Continue anyway");
  expect(html).not.toContain("Repair delivery");
});

test("explains the member publication decision", () => {
  const task = {
    phase: "accepted",
    allowedCommands: ["accept_delivery", "request_delivery_changes"],
    commands: [],
    pendingAction: "Member acceptance required",
    projection: { status: "current" },
  } as unknown as ApiTask;
  const html = renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskActions, {
    task,
    busy: false,
    onStartPlanning: async () => undefined,
    onPlanAction: async () => undefined,
    onRevisePlan: async () => undefined,
    onContinueWork: async () => undefined,
  }) }));

  expect(html).toContain("Ready to publish");
  expect(html).toContain("The work is ready. Publish makes the pull request available for review. Request Changes sends it back to the Developer.");
  expect(html).toContain(">Publish<");
  expect(html).toContain(">Request Changes<");
});

test("explains a final review retry and keeps it as the rightmost action", () => {
  const task = {
    phase: "delivery_blocked",
    allowedCommands: ["final_review", "request_delivery_changes"],
    commands: [],
    pendingAction: "Final review is temporarily unavailable; retry the exact review or request changes",
    projection: { status: "current" },
  } as unknown as ApiTask;
  const html = renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskActions, {
    task,
    busy: false,
    onStartPlanning: async () => undefined,
    onPlanAction: async () => undefined,
    onRevisePlan: async () => undefined,
    onContinueWork: async () => undefined,
  }) }));

  expect(html).toContain("Final review did not finish");
  expect(html).toContain("Forge could not finish its last review. Try again, or choose Request Changes to send the work back.");
  expect(html.indexOf(">Request Changes<")).toBeLessThan(html.indexOf(">Final review<"));
});

test("shows the exact draft publication preview and diff action", () => {
  const task = {
    phase: "releasing",
    allowedCommands: ["accept_delivery", "publish_draft", "request_delivery_changes"],
    commands: [],
    pendingAction: "Opening the pull request",
    projection: { status: "current" },
    developerExecution: { status: "completed", branchName: "work/readme-joke", resultCommit: "a".repeat(40) },
    release: { repository: "acme/forge", baseBranch: "main", headBranch: "work/readme-joke", title: "Add a sound-decision pun", bodyPreview: "Summary\n\nA long description that reviewers should see before opening the diff. It also explains the implementation, verification, compatibility, and operational impact in enough detail to require an expandable preview instead of showing the entire pull request description inline." },
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
  expect(html).toContain("Ready to Create Pull Request");
  expect(html).not.toContain("What will be published?");
  expect(html).toContain("Add a sound-decision pun");
  expect(html).toContain("lucide-git-pull-request");
  expect(html).not.toContain("PR title");
  expect(html).not.toContain("PR description</dt>");
  expect(html).toContain("A long description that reviewers should see before opening the diff.");
  expect(html).toContain('aria-label="Expand PR description"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain(">Show Diff<");
  expect(html).toContain(">Publish<");
  expect(html).toContain(">Draft Pull Request<");
  expect(html).toContain(">Request Changes<");
  expect(html.match(/<button[^>]*>Draft Pull Request<\/button>/)?.[0]).toContain("bg-primary");
  expect(html.indexOf(">Publish<")).toBeLessThan(html.indexOf(">Draft Pull Request<"));
  expect(html.indexOf(">Draft Pull Request<")).toBeLessThan(html.indexOf(">Request Changes<"));
});

test("uses planned publication copy before publishing and skeletons while publishing", () => {
  const task = {
    phase: "delivery_reviewed",
    allowedCommands: ["publish_draft"],
    commands: [],
    pendingAction: "Opening the pull request",
    projection: { status: "current" },
    leadOutput: { content: { kind: "plan", gitPresentation: { pullRequestTitle: "Add sign-out controls", pullRequestDescription: "Explain the logout behavior." } } },
  } as unknown as ApiTask;
  const render = (busy: boolean): string => renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskActions, {
    task,
    busy,
    onStartPlanning: async () => undefined,
    onPlanAction: async () => undefined,
    onRevisePlan: async () => undefined,
    onContinueWork: async () => undefined,
  }) }));

  expect(render(false)).toContain("Add sign-out controls");
  expect(render(false)).toContain("Explain the logout behavior.");
  expect(render(false)).not.toContain("Publication details are not available yet.");
  expect(render(true)).toContain('data-publication-preview-loading="true"');
  expect(render(true).match(/data-slot="skeleton"/g)).toHaveLength(3);
});

test("shows a status card when a background phase has no action", () => {
  const task = {
    phase: "releasing",
    allowedCommands: [],
    commands: [],
    pendingAction: "Publishing draft pull request",
    projection: { status: "current" },
  } as unknown as ApiTask;
  const html = renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskActions, {
    task,
    busy: false,
    onStartPlanning: async () => undefined,
    onPlanAction: async () => undefined,
    onRevisePlan: async () => undefined,
    onContinueWork: async () => undefined,
  }) }));
  expect(html).toContain('data-task-status-card="true"');
  expect(html).toContain("Opening PR");
  expect(html).toContain("Publishing draft pull request");
});

test("explains delivery review without internal role language", () => {
  const task = {
    phase: "reviewing_delivery",
    allowedCommands: [],
    commands: [],
    pendingAction: "Lead delivery review",
    projection: { status: "current" },
  } as unknown as ApiTask;
  const html = renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskActions, {
    task,
    busy: false,
    onStartPlanning: async () => undefined,
    onPlanAction: async () => undefined,
    onRevisePlan: async () => undefined,
    onContinueWork: async () => undefined,
  }) }));
  expect(html).toContain("Forge is checking the completed work against the approved plan.");
  expect(html).not.toContain("Lead delivery review");
});

test("marks blocked action cards with the destructive status badge", () => {
  const task = {
    phase: "delivery_blocked",
    allowedCommands: ["retry_forward_merge_verification"],
    commands: [],
    pendingAction: "mise run test did not complete successfully",
    projection: { status: "current" },
  } as unknown as ApiTask;
  const html = renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskActions, {
    task,
    busy: false,
    onStartPlanning: async () => undefined,
    onPlanAction: async () => undefined,
    onRevisePlan: async () => undefined,
    onContinueWork: async () => undefined,
  }) }));
  expect(html).toContain('data-task-blocked-card="true"');
  expect(html).toContain('data-variant="destructive"');
  expect(html).toContain("bg-destructive/10");
  expect(html).toContain(">Needs attention<");
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
