import { expect, test } from "vitest";

import { reduceAgentAuthBlock, shouldMonitorAgentStatus } from "../src/frontend/components/app/use-agent-status.js";

test("agent status monitoring stops on 401 and resumes after authentication", () => {
  let authBlocked = false;
  expect(shouldMonitorAgentStatus({ authenticated: true, loading: false, authBlocked })).toBe(true);

  authBlocked = reduceAgentAuthBlock(authBlocked, "unauthorized");
  expect(shouldMonitorAgentStatus({ authenticated: true, loading: false, authBlocked })).toBe(false);

  authBlocked = reduceAgentAuthBlock(authBlocked, "authenticated");
  expect(shouldMonitorAgentStatus({ authenticated: true, loading: false, authBlocked })).toBe(true);
});
