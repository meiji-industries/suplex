import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";

import { TaskProgress } from "../src/frontend/components/app/task-progress.js";
import { ProfileAvatar } from "../src/frontend/components/app/profile-avatar.js";
import { taskIsProcessing, TaskStatusIcon } from "../src/frontend/components/app/task-status.js";

const base = { allowedCommands: ["cancel_development"], createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:01:00.000Z", timeline: [], agentInvocations: [] };

afterEach(() => vi.useRealTimers());

test("agent avatars are square robots and human avatars are circular", () => {
  const agentElement = ProfileAvatar({ name: "Planner", seed: "agent-seed" });
  const humanElement = ProfileAvatar({ name: "Adam", seed: "human-seed", collection: "pixel-art-neutral" });
  const agentImage = (agentElement.props as { children: Array<{ props: { src: string } }> }).children[0]!;
  const humanImage = (humanElement.props as { children: Array<{ props: { src: string } }> }).children[0]!;
  expect(agentImage.props.src).toContain("/bottts-neutral/svg?seed=agent-seed");
  expect(renderToStaticMarkup(agentElement)).toContain('data-shape="square"');
  expect(humanImage.props.src).toContain("/pixel-art-neutral/svg?seed=human-seed");
  expect(renderToStaticMarkup(humanElement)).toContain('data-shape="circle"');
});

test("Build animation requires a fresh Developer heartbeat", () => {
  const fresh = renderToStaticMarkup(createElement(TaskProgress, { ...base, phase: "building", developerLiveness: { status: "running", lastHeartbeatAt: new Date().toISOString() } }));
  const stale = renderToStaticMarkup(createElement(TaskProgress, { ...base, phase: "building", developerLiveness: { status: "active", lastHeartbeatAt: "2026-08-13T00:00:00.000Z" } }));
  const blocked = renderToStaticMarkup(createElement(TaskProgress, { ...base, phase: "building", blocked: true, developerLiveness: { status: "active", lastHeartbeatAt: "2026-08-13T00:00:00.000Z" } }));
  expect(fresh).toContain("animate-spin");
  expect(stale).not.toContain("animate-spin");
  expect(blocked).not.toContain("animate-spin");
});

test("Release starts at delivery, not an earlier retryable Developer block", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-14T05:30:15.000Z"));
  const timeline = [
    { createdAt: "2026-08-14T05:21:15.000Z", metadata: { phase: "building" } },
    { createdAt: "2026-08-14T05:22:15.000Z", metadata: { phase: "building" } },
    { createdAt: "2026-08-14T05:29:15.000Z", metadata: { phase: "reviewing" } },
  ];
  const delivered = renderToStaticMarkup(createElement(TaskProgress, { ...base, phase: "reviewing", timeline, updatedAt: "2026-08-14T05:29:15.000Z" }));
  expect(delivered).toContain("1m 0s");
  expect(delivered).not.toContain("9m 0s");
});

test("Release animation follows known background work", () => {
  const blocked = renderToStaticMarkup(createElement(TaskProgress, { ...base, phase: "shipping", blocked: true }));
  const waiting = renderToStaticMarkup(createElement(TaskProgress, { ...base, phase: "shipping" }));
  const sidebar = renderToStaticMarkup(createElement(TaskStatusIcon, { phase: "shipping", processing: true }));
  expect(blocked).not.toContain("animate-spin");
  expect(waiting).toContain("animate-spin");
  expect(sidebar).toContain("animate-spin");
  expect(taskIsProcessing({ phase: "shipping", blocked: true, agentInvocations: [{ status: "running" }] })).toBe(false);
  expect(taskIsProcessing({ phase: "shipping" })).toBe(true);
});
