/** @vitest-environment jsdom */
import { beforeEach, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => {
  let flagCallback: (() => void) | undefined;
  let replayFlag = false;
  const posthog = {
    init: vi.fn(), set_config: vi.fn(), opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn(), reset: vi.fn(),
    identify: vi.fn(), group: vi.fn(), resetGroups: vi.fn(), register: vi.fn(), capture: vi.fn(), captureException: vi.fn(), startSessionRecording: vi.fn(), stopSessionRecording: vi.fn(),
    isFeatureEnabled: vi.fn(() => replayFlag),
    onFeatureFlags: vi.fn((callback: () => void) => { flagCallback = callback; return vi.fn(); }),
  };
  return {
    posthog,
    enableReplay: () => { replayFlag = true; flagCallback?.(); },
    reset: () => { replayFlag = false; flagCallback = undefined; Object.values(posthog).forEach(value => { if (typeof value === "function" && "mockClear" in value) value.mockClear(); }); },
  };
});

vi.mock("posthog-js", () => ({ default: sdk.posthog, posthog: sdk.posthog }));

import type { TelemetryResponse } from "../src/frontend/contracts/generated/TelemetryResponse.js";
import { applyTelemetry, captureBrowserException, sanitizeRoute, updateBrowserAnalyticsContext } from "../src/frontend/shell/browser-analytics.js";

function active(overrides: Partial<TelemetryResponse> = {}): TelemetryResponse {
  return {
    noticeRequired: false,
    enabled: true,
    projectKey: "ph_public_key",
    host: "https://meta.suplex.sh",
    installationId: "install-1",
    appVersion: "1.2.1",
    appRevision: "revision",
    userId: "user-1",
    userRole: "member",
    sessionReplayEnabled: false,
    ...overrides,
  };
}

function inactive(): TelemetryResponse {
  return { noticeRequired: false, enabled: false, sessionReplayEnabled: false };
}

beforeEach(() => {
  sdk.reset();
  window.history.replaceState({}, "", "/tasks/task_secret?token=secret#prompt");
  Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "0" });
});

test("sanitizes route identifiers", () => {
  expect(sanitizeRoute("/tasks/task_secret")).toBe("/tasks/:id");
  expect(sanitizeRoute("/admin/environment")).toBe("/admin/environment");
});

test("loads PostHog only for active consent and stops immediately after opt out", async () => {
  await applyTelemetry(inactive());
  expect(sdk.posthog.init).not.toHaveBeenCalled();

  await applyTelemetry(active());
  expect(sdk.posthog.init).toHaveBeenCalledOnce();
  const config = sdk.posthog.init.mock.calls[0]![1];
  expect(config).toMatchObject({
    api_host: "https://meta.suplex.sh",
    autocapture: false,
    capture_pageview: false,
    capture_exceptions: false,
    capture_performance: false,
    opt_out_capturing_by_default: true,
    respect_dnt: true,
    session_recording: { maskAllInputs: true, maskAllElementAttributes: true, recordHeaders: false, recordBody: false, streamNetworkBody: false },
  });
  expect(sdk.posthog.identify).toHaveBeenCalledWith("install-1:user:user-1", expect.objectContaining({ user_role: "member" }));
  const scrubbed = config.before_send({ event: "browser_exception", properties: { $current_url: "https://host/tasks/secret?q=token#hash", $initial_current_url: "https://host/projects/secret?token=value", $initial_pathname: "/projects/secret", $initial_referrer: "https://external.test/private", title: "secret title", error_message: "At https://host/tasks/secret?q=token" } });
  expect(scrubbed.properties).toMatchObject({ $current_url: "app://suplex/tasks/:id", $initial_current_url: "app://suplex/tasks/:id", $initial_pathname: "app://suplex/tasks/:id", $initial_referrer: "app://suplex/tasks/:id", error_message: "[redacted]" });
  expect(scrubbed.properties).not.toHaveProperty("title");
  const initialRequest = config.session_recording.maskCapturedNetworkRequestFn({ name: "https://host/tasks/secret?q=token", isInitial: true, requestHeaders: { authorization: "secret" }, requestBody: "secret" });
  expect(initialRequest).toMatchObject({ name: "app://suplex/tasks/:id", isInitial: true });
  expect(initialRequest).not.toHaveProperty("requestHeaders");
  expect(initialRequest).not.toHaveProperty("requestBody");
  expect(config.session_recording.maskCapturedNetworkRequestFn({ name: "https://host/api/tasks", isInitial: false })).toBeNull();

  const pageviews = () => sdk.posthog.capture.mock.calls.filter(([event]) => event === "$pageview").length;
  expect(pageviews()).toBe(1);

  await applyTelemetry(active({ sessionReplayEnabled: true }));
  expect(pageviews()).toBe(1);
  expect(sdk.posthog.startSessionRecording).not.toHaveBeenCalled();
  sdk.enableReplay();
  expect(sdk.posthog.startSessionRecording).toHaveBeenCalledOnce();

  await applyTelemetry(inactive());
  expect(sdk.posthog.stopSessionRecording).toHaveBeenCalled();
  expect(sdk.posthog.opt_out_capturing).toHaveBeenCalled();
  expect(sdk.posthog.reset).toHaveBeenCalled();

  await applyTelemetry(active());
  expect(sdk.posthog.onFeatureFlags).toHaveBeenCalledTimes(2);
  updateBrowserAnalyticsContext({ companyId: "company-1", companyPlan: "pro", platform: "browser" });
  expect(sdk.posthog.group).toHaveBeenCalledWith("company", "company-1", { plan: "pro" });
  updateBrowserAnalyticsContext({ platform: "browser" });
  expect(sdk.posthog.resetGroups).toHaveBeenCalled();

  captureBrowserException(new Error("prompt secret at /Users/alice/private.ts"), { line: 42, column: 7 });
  const captured = sdk.posthog.captureException.mock.calls.at(-1)![0] as Error;
  expect(captured.message).toBe("Browser Error");
  expect(captured.stack).toBe("Error: Browser Error\n    at app (suplex://app.js:42:7)");
  expect(captured.stack).not.toContain("secret");
});

test("browser DNT prevents SDK initialization", async () => {
  Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "1" });
  await applyTelemetry(active());
  expect(sdk.posthog.init).not.toHaveBeenCalled();
});
