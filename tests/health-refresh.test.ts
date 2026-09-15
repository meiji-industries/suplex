import { expect, test, vi } from "vitest";

import { createHealthRefresher, healthContextKey, healthContextQuery, type HealthContextSelector } from "../src/frontend/lib/health-refresh.js";
import type { HealthCheck, HealthSnapshot } from "../src/platform/health.js";

const check = (id: HealthCheck["id"], provider?: HealthCheck["provider"]): HealthCheck => ({ id, label: id, status: "healthy", summary: "Ready", details: {}, ...(provider ? { provider } : {}) });

const snapshot = (generatedAt: string, checks: HealthCheck[] = [check("git")]): HealthSnapshot => ({
  generatedAt,
  reachableAddress: "http://127.0.0.1:4111",
  ready: true,
  checks,
});

test("health context selectors serialize to query strings and stable keys", () => {
  expect(healthContextQuery(undefined)).toBe("");
  expect(healthContextQuery({ projectId: "project 1" })).toBe("projectId=project%201");
  expect(healthContextQuery({ profileIds: ["a", "b"] })).toBe("profileIds=a,b");
  expect(healthContextKey({ profileIds: ["b", "a"] })).toBe(healthContextKey({ profileIds: ["a", "b"] }));
  expect(healthContextKey({ projectId: "p" })).not.toBe(healthContextKey({ profileIds: ["p"] }));
});

test("concurrent refreshes for the same context share one request", async () => {
  const read = vi.fn(async () => snapshot("2026-09-08T00:00:00.000Z"));
  const refresher = createHealthRefresher({ read });
  const first = refresher.refresh();
  const second = refresher.refresh();
  const third = refresher.refresh({ profileIds: ["p1"] });
  const fourth = refresher.refresh({ profileIds: ["p1"] });
  await Promise.all([first, second, third, fourth]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(refresher.state.snapshot?.generatedAt).toBe("2026-09-08T00:00:00.000Z");
  expect(refresher.state.freshness).toBe("current");
});

test("a late response for a previous context cannot overwrite the active context", async () => {
  const resolves: Array<(value: HealthSnapshot) => void> = [];
  const read = vi.fn((context: HealthContextSelector) => new Promise<HealthSnapshot>((resolve) => { void context; resolves.push(resolve); }));
  const refresher = createHealthRefresher({
    read,
    initialSnapshot: snapshot("2026-09-07T00:00:00.000Z", [check("git"), check("provider:opencode", "opencode")]),
  });

  void refresher.refresh({ profileIds: ["old"] });
  void refresher.refresh({ profileIds: ["new"] });
  // Switching context drops provider results belonging to the previous context.
  expect(refresher.state.snapshot?.checks.map(({ id }) => id)).toEqual(["git"]);
  resolves[0]!(snapshot("2026-09-08T00:00:00.000Z", [check("git"), check("provider:opencode", "opencode")]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(refresher.state.snapshot?.checks.map(({ id }) => id)).toEqual(["git"]);

  resolves[1]!(snapshot("2026-09-08T00:00:01.000Z", [check("git"), check("provider:claude-code", "claude-code")]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(refresher.state.snapshot?.checks.map(({ id }) => id)).toEqual(["git", "provider:claude-code"]);
  expect(refresher.state.freshness).toBe("current");
});

test("a failed refresh keeps the last snapshot and marks it stale", async () => {
  const first = snapshot("2026-09-08T00:00:00.000Z");
  const read = vi.fn()
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(new Error("host check failed"));
  const refresher = createHealthRefresher({ read });
  await refresher.refresh();
  await refresher.refresh();
  expect(refresher.state.snapshot).toBe(first);
  expect(refresher.state.freshness).toBe("stale");
  expect(refresher.state.lastSuccessfulCheckAt).toBe("2026-09-08T00:00:00.000Z");
});

test("a failed refresh with no prior snapshot is stale without claiming readiness", async () => {
  const refresher = createHealthRefresher({ read: async () => { throw new Error("host check failed"); } });
  await refresher.refresh();
  expect(refresher.state.snapshot).toBeUndefined();
  expect(refresher.state.freshness).toBe("stale");
});

test("visibility and focus re-check only while a health surface is watching", async () => {
  const read = vi.fn(async () => snapshot("2026-09-08T00:00:00.000Z"));
  const refresher = createHealthRefresher({ read });
  refresher.notifyVisible();
  expect(read).not.toHaveBeenCalled();
  const unwatch = refresher.watch();
  refresher.notifyVisible();
  expect(read).toHaveBeenCalledTimes(1);
  unwatch();
  refresher.notifyVisible();
  expect(read).toHaveBeenCalledTimes(1);
});

test("periodic refresh uses the cached read while visible and stops after cleanup", async () => {
  vi.useFakeTimers();
  let visible = true;
  const read = vi.fn(async () => snapshot("2026-09-08T00:00:00.000Z"));
  const refresher = createHealthRefresher({ read });
  const stop = refresher.startPolling(() => visible);
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledWith(undefined, false);
    visible = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
    visible = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
