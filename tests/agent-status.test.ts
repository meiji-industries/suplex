import { expect, test } from "vitest";

import { reduceAgentAuthBlock, runtimeRefreshDelay, shouldMonitorAgentStatus } from "../src/frontend/components/app/use-agent-status.js";

test("agent status monitoring stops on 401 and resumes after authentication", () => {
  let authBlocked = false;
  expect(shouldMonitorAgentStatus({ authenticated: true, loading: false, authBlocked })).toBe(true);

  authBlocked = reduceAgentAuthBlock(authBlocked, "unauthorized");
  expect(shouldMonitorAgentStatus({ authenticated: true, loading: false, authBlocked })).toBe(false);

  authBlocked = reduceAgentAuthBlock(authBlocked, "authenticated");
  expect(shouldMonitorAgentStatus({ authenticated: true, loading: false, authBlocked })).toBe(true);
});

test("agent runtime invalidations use a five-second trailing window", () => {
  expect(runtimeRefreshDelay(undefined, 10_000)).toBe(0);
  expect(runtimeRefreshDelay(10_000, 12_000)).toBe(3000);
  expect(runtimeRefreshDelay(10_000, 15_000)).toBe(0);
  expect(runtimeRefreshDelay(10_000, 16_000)).toBe(0);
});
