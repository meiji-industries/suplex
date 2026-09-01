import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { DeveloperRecoveryActions } from "../src/frontend/components/app/developer-recovery-actions.js";
import { DeveloperRecoveryStatus } from "../src/frontend/components/app/developer-recovery-status.js";
import { TaskAttentionCard } from "../src/frontend/components/app/task-attention-card.js";
import { PlanDecisionForm } from "../src/frontend/components/app/plan-decision-form.js";
import { SystemHealthProvider } from "../src/frontend/components/app/system-health.js";
import { NextAction, TaskActions } from "../src/frontend/views/task-details.js";
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
    recovery: { status: "active", reasonCode: null, summary: "Developer result claimed.", lastHeartbeatAt: null, currentOwner: "forge", evidenceArtifactId: null, nextAction: null },
    allowedCommands: ["cancel_development"],
    busy: false,
    isAdmin: true,
    onAction: async () => undefined,
  }));

  expect(html).toContain('data-slot="card"');
  expect(html).toContain('data-slot="card-footer"');
  expect(html.match(/<div data-slot="card-footer"[^>]*>/)?.[0]).toContain("justify-start");
  expect(html).toContain('role="alert"');
  expect(html).toContain('role="button"');
  expect(html).toContain('tabindex="0"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('data-panel-open=""');
  expect(html).toContain("Cancel development");
  expect(html).not.toContain("Developer result claimed.");
});

test("attention cards left-align content and omit repeated status text", () => {
  const repeated = "Waiting for a codex agent slot (2 active, position 1)";
  const html = renderToStaticMarkup(createElement(TaskAttentionCard, {
    card: {
      kind: "generic",
      title: repeated,
      explanation: repeated,
      evidence: [{ kind: "text", ref: repeated }],
      primaryAction: { command: "cancel_development", label: "Cancel development" },
      secondaryAction: { command: "cancel_issue", label: "Cancel issue", destructive: true },
    },
    onAction: async () => undefined,
  }));

  expect(html.match(new RegExp(repeated.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
  expect(html.match(/<section[^>]*>/)?.[0]).toContain("w-full");
  expect(html.match(/<section[^>]*>/)?.[0]).toContain("text-left");
});

test("keeps actionable Developer recovery summaries", () => {
  const html = renderToStaticMarkup(createElement(DeveloperRecoveryStatus, {
    recovery: { status: "failed", reasonCode: "developer-failed", summary: "The Builder process exited before returning a result.", lastHeartbeatAt: null, currentOwner: "forge", evidenceArtifactId: "evidence-1", nextAction: null },
    allowedCommands: ["retry_development"],
    busy: false,
    isAdmin: true,
    onAction: async () => undefined,
  }));

  expect(html).toContain("The Builder process exited before returning a result.");
  expect(html).not.toContain("Open retained evidence");
});

test("hides an idle starting Development card without actions", () => {
  const html = renderToStaticMarkup(createElement(DeveloperRecoveryStatus, {
    recovery: { status: "starting", reasonCode: null, summary: null, lastHeartbeatAt: "2026-08-29T00:00:00.000Z", currentOwner: "forge", evidenceArtifactId: "evidence-1", nextAction: null },
    allowedCommands: [],
    busy: false,
    isAdmin: true,
    onAction: async () => undefined,
  }));
  expect(html).toBe("");
});

test("labels a blocked delivery as awaiting a decision while keeping retry available", () => {
  const html = renderToStaticMarkup(createElement(DeveloperRecoveryStatus, {
    recovery: { status: "failed", reasonCode: "target-suite-failures", summary: "The target repository has unrelated failures.", lastHeartbeatAt: null, currentOwner: "forge", evidenceArtifactId: null, nextAction: null },
    executionStatus: "blocked",
    allowedCommands: ["retry_development"],
    busy: false,
    isAdmin: true,
    onAction: async () => undefined,
  }));

  expect(html).toContain("Needs a decision");
  expect(html).toContain("Retry development");
  expect(html).not.toContain("Failed");
});

test("keeps failed and cancelled Developer executions distinct", () => {
  const render = (status: "failed" | "cancelled", executionStatus: string): string => renderToStaticMarkup(createElement(DeveloperRecoveryStatus, {
    recovery: { status, reasonCode: null, summary: null, lastHeartbeatAt: null, currentOwner: "forge", evidenceArtifactId: null, nextAction: null },
    executionStatus,
    allowedCommands: ["retry_development"],
    busy: false,
    isAdmin: true,
    onAction: async () => undefined,
  }));

  expect(render("failed", "failed")).toContain("Failed");
  expect(render("cancelled", "cancelled")).toContain("Cancelled");
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

  expect(html).toContain("The work is ready.");
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
    source: { kind: "branch", branch: "work/sign-out" },
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

test("labels a sourced pull request publication as a push without a new-PR preview", () => {
  const task = {
    phase: "delivery_reviewed",
    allowedCommands: ["publish_draft"],
    commands: [],
    pendingAction: "Push the reviewed commit",
    projection: { status: "current" },
    source: { kind: "pull_request", number: 1516, url: "https://github.com/NewSchoolFoods/RTD/pull/1516", headBranch: "feat/campaign-derivation-math", baseBranch: "main" },
    leadOutput: { content: { kind: "plan", gitPresentation: { pullRequestTitle: "Do not show this", pullRequestDescription: "Do not show this description." } } },
  } as unknown as ApiTask;
  const render = (busy: boolean, blocked = false): string => renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskActions, {
    task: (blocked ? { ...task, release: { status: "blocked" } } : task) as unknown as ApiTask,
    busy,
    onStartPlanning: async () => undefined,
    onPlanAction: async () => undefined,
    onRevisePlan: async () => undefined,
    onContinueWork: async () => undefined,
  }) }));

  expect(render(false)).toContain("Ready to Update Pull Request");
  expect(render(false)).toContain(">Push Commits<");
  expect(render(false)).toContain("Pull request #1516");
  expect(render(false)).toContain('href="https://github.com/NewSchoolFoods/RTD/pull/1516"');
  expect(render(false)).toContain("feat/campaign-derivation-math</code> → <code>main");
  expect(render(false)).not.toContain("Draft Pull Request");
  expect(render(false)).not.toContain("Do not show this description.");
  expect(render(true)).toContain(">Pushing…<");
  expect(render(false, true)).toContain(">Retry Push<");
});

test("keeps later action titles after publish draft", () => {
  const task = { phase: "accepted", allowedCommands: ["reconcile_merge"], commands: [], pendingAction: "Check merge", projection: { status: "current" } } as unknown as ApiTask;
  const html = renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskActions, {
    task, busy: false, onStartPlanning: async () => undefined, onPlanAction: async () => undefined, onRevisePlan: async () => undefined, onContinueWork: async () => undefined,
  }) }));
  expect(html).toContain("Check merge");
});

test("hides a task-actions card with only a planning status label", () => {
  const task = {
    phase: "planning",
    allowedCommands: [],
    commands: [],
    pendingAction: "Lead planning",
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
  expect(html).not.toContain("data-task-actions");
});

test("keeps task-actions cards with an available command", () => {
  const task = {
    phase: "ready",
    allowedCommands: ["start_planning"],
    commands: [],
    pendingAction: "Start planning",
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
  expect(html).toContain("data-task-actions");
  expect(html).toContain(">Start planning<");
});

test("keeps final-plan decisions together in the actions card", () => {
  const task = {
    phase: "approval",
    allowedCommands: ["request_supplemental_review", "approve_plan", "request_plan_revision"],
    commands: [{ name: "request_supplemental_review", endpoint: "request-supplemental-review" }],
    pendingAction: "A distinctive workflow label that is not a card title",
    projection: { status: "current" },
  } as unknown as ApiTask;
  const decisionControls = createElement(PlanDecisionForm, { approveCommand: { endpoint: "approve-plan", expectedRevision: 3 }, revisionCommand: { endpoint: "request-plan-revision", expectedRevision: 3 }, busy: false, onSubmit: async () => undefined });
  const html = renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskActions, {
    task,
    busy: false,
    onStartPlanning: async () => undefined,
    onPlanAction: async () => undefined,
    onRevisePlan: async () => undefined,
    onContinueWork: async () => undefined,
    decisionControls,
  }) }));

  expect(html).toContain("Review final plan");
  expect(html).not.toContain(task.pendingAction!);
  expect(html.match(/data-plan-decision-controls="true"/g)).toHaveLength(1);
  expect(html.match(/>Approve Plan</g)).toHaveLength(1);
  expect(html.match(/>Request Changes</g)).toHaveLength(1);
  expect(html).toContain(">Request review<");
});

test("explains delivery review without internal role language", () => {
  const task = {
    phase: "reviewing_delivery",
    allowedCommands: [],
    commands: [],
    pendingAction: "Lead delivery review",
    projection: { status: "current" },
  } as unknown as ApiTask;
  const html = renderToStaticMarkup(createElement(NextAction, { value: task.pendingAction }));
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
    recovery: { status: "active", reasonCode: null, summary: "Developer result claimed.", lastHeartbeatAt: null, currentOwner: "forge", evidenceArtifactId: "evidence-1", nextAction: null },
    allowedCommands: ["review_delivery"],
    busy: false,
    isAdmin: true,
    onAction: async () => undefined,
  }));
  expect(html).toBe("");
});
