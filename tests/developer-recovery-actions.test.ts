import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { DeveloperRecoveryActions } from "../src/frontend/components/app/developer-recovery-actions.js";
import { DeveloperRecoveryStatus } from "../src/frontend/components/app/developer-recovery-status.js";

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
    recovery: { status: "active", reasonCode: null, summary: "Developer is working.", lastHeartbeatAt: null, currentOwner: "forge", evidenceArtifactId: null, nextAction: null },
    allowedCommands: ["cancel_development"],
    busy: false,
    isAdmin: true,
    onAction: async () => undefined,
  }));

  expect(html).toContain('data-slot="card"');
  expect(html).toContain('data-slot="card-footer"');
  expect(html).toContain('role="alert"');
  expect(html).toContain("Cancel development");
});
