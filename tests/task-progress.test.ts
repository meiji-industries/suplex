import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

import { TaskProgress } from "../src/frontend/components/app/task-progress.js";
import { taskIsProcessing, TaskStatusIcon } from "../src/frontend/components/app/task-status.js";

const base = { allowedCommands: ["cancel_development"], createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:01:00.000Z", timeline: [], agentInvocations: [] };

afterEach(() => vi.useRealTimers());

test("Build animation requires a fresh Developer heartbeat", () => {
  const fresh = renderToStaticMarkup(createElement(TaskProgress, { ...base, phase: "development", developerLiveness: { status: "running", lastHeartbeatAt: new Date().toISOString() } }));
  const stale = renderToStaticMarkup(createElement(TaskProgress, { ...base, phase: "development", developerLiveness: { status: "active", lastHeartbeatAt: "2026-08-13T00:00:00.000Z" } }));
  const blocked = renderToStaticMarkup(createElement(TaskProgress, { ...base, phase: "delivery_blocked", allowedCommands: ["retry_development"], developerLiveness: { status: "active", lastHeartbeatAt: new Date().toISOString() } }));
  expect(fresh).toContain("animate-spin");
  expect(stale).not.toContain("animate-spin");
  expect(blocked).not.toContain("animate-spin");
});

test("Release starts at delivery, not an earlier retryable Developer block", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-14T05:30:15.000Z"));
  const timeline = [
    { createdAt: "2026-08-14T05:21:15.000Z", metadata: { phase: "delivery_blocked" } },
    { createdAt: "2026-08-14T05:22:15.000Z", metadata: { phase: "development" } },
    { createdAt: "2026-08-14T05:29:15.000Z", metadata: { phase: "delivery_ready" } },
  ];
  const delivered = renderToStaticMarkup(createElement(TaskProgress, { ...base, phase: "delivery_ready", allowedCommands: ["review_delivery"], timeline, updatedAt: "2026-08-14T05:29:15.000Z" }));
  expect(delivered).toContain("1m 0s");
  expect(delivered).not.toContain("9m 0s");
});

test("Release animation follows known background work", () => {
  const blocked = renderToStaticMarkup(createElement(TaskProgress, { ...base, phase: "delivery_blocked" }));
  const waiting = renderToStaticMarkup(createElement(TaskProgress, { ...base, phase: "ci_waiting" }));
  const sidebar = renderToStaticMarkup(createElement(TaskStatusIcon, { phase: "ci_waiting", processing: true }));
  expect(blocked).not.toContain("animate-spin");
  expect(waiting).toContain("animate-spin");
  expect(sidebar).toContain("animate-spin");
  expect(taskIsProcessing({ phase: "delivery_blocked", agentInvocations: [{ status: "running" }] })).toBe(false);
  expect(taskIsProcessing({ phase: "ci_waiting" })).toBe(true);
});
