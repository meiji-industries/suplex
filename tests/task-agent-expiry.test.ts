import { expect, test } from "vitest";
import { isTaskAgentExpired } from "../src/frontend/components/app/recent-task-agents.js";
import { defaultTaskAgentExpiryMs, parseTaskAgentExpiry, taskAgentExpiryOptions } from "../src/frontend/components/app/task-agent-expiry.js";

const now = Date.parse("2026-09-06T00:00:00.000Z");
const expiryMs = 300_000;
const agent = (status: "queued" | "working" | "retrying" | "idle" | "waiting_human" | "stopped" | "unknown", statusChangedAt: string | null = null) => ({
  id: status,
  role: "worker" as const,
  paneId: null,
  status,
  statusChangedAt,
});

test("task-agent expiry accepts the shipped values and defaults invalid storage", () => {
  expect(taskAgentExpiryOptions.map(option => option.value)).toEqual([0, 60_000, 300_000, 900_000, 3_600_000, 21_600_000, 86_400_000]);
  expect(taskAgentExpiryOptions.map(option => option.label)).toEqual(["Immediately", "1 minute", "5 minutes", "15 minutes", "1 hour", "6 hours", "24 hours"]);
  expect(parseTaskAgentExpiry(null)).toBe(defaultTaskAgentExpiryMs);
  expect(parseTaskAgentExpiry("invalid")).toBe(defaultTaskAgentExpiryMs);
  expect(parseTaskAgentExpiry("")).toBe(defaultTaskAgentExpiryMs);
  expect(parseTaskAgentExpiry("300000")).toBe(defaultTaskAgentExpiryMs);
  expect(parseTaskAgentExpiry("0")).toBe(0);
  expect(parseTaskAgentExpiry("86400000")).toBe(86_400_000);
});

test.each(["idle", "stopped"] as const)("%s agents expire immediately without a timestamp", status => {
  expect(isTaskAgentExpired(agent(status), now, 0)).toBe(true);
  expect(isTaskAgentExpired(agent(status, new Date(now + expiryMs).toISOString()), now, 0)).toBe(true);
});

test.each(["idle", "stopped"] as const)("%s agents with nonzero expiry require a valid past timestamp", status => {
  expect(isTaskAgentExpired(agent(status), now, expiryMs)).toBe(false);
  expect(isTaskAgentExpired(agent(status, "not-a-timestamp"), now, expiryMs)).toBe(false);
  expect(isTaskAgentExpired(agent(status, new Date(now + expiryMs).toISOString()), now, expiryMs)).toBe(false);
  expect(isTaskAgentExpired(agent(status, new Date(now - expiryMs).toISOString()), now, expiryMs)).toBe(true);
});

test.each(["queued", "working", "retrying", "waiting_human", "unknown"] as const)("%s agents never expire based on age", status => {
  const oldTimestamp = new Date(now - expiryMs * 2).toISOString();
  expect(isTaskAgentExpired(agent(status, oldTimestamp), now, 0)).toBe(false);
  expect(isTaskAgentExpired(agent(status, oldTimestamp), now, expiryMs)).toBe(false);
});
