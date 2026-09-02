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

test("keeps later action titles after publish draft", () => {
  const task = { phase: "accepted", allowedCommands: ["reconcile_merge"], commands: [], pendingAction: "Check merge", projection: { status: "current" } } as unknown as ApiTask;
  const html = renderToStaticMarkup(createElement(SystemHealthProvider, { initialSnapshot: undefined, children: createElement(TaskActions, {
    task, busy: false, onStartPlanning: async () => undefined, onPlanAction: async () => undefined, onRevisePlan: async () => undefined, onContinueWork: async () => undefined,
  }) }));
  expect(html).toContain("Check merge");
});

test("shows an agent status card for planning", () => {
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
  expect(html).toContain("data-task-status-card");
  expect(html).toContain("Lead planning");
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
    owner: "human",
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

  expect(html).toContain(task.pendingAction!);
  expect(html.match(/>Approve Plan</g)).toHaveLength(1);
  expect(html.match(/>Request changes</g)).toHaveLength(1);
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
    phase: "reviewing",
    step: "delivery_reviewed",
    blocked: true,
    blocker: { summary: "Retry the delivery check", actions: [{ command: "retry_forward_merge_verification", label: "Retry verification" }, { command: "cancel_issue", label: "Cancel task", destructive: true }] },
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
  expect(html).toContain("Retry the delivery check");
  expect(html).toContain(">Cancel task<");
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
