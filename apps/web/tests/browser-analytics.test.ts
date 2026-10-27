/** @vitest-environment jsdom */
import { beforeEach, expect, test, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const posthog = {
    init: vi.fn(), set_config: vi.fn(), opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn(), reset: vi.fn(),
    identify: vi.fn(), group: vi.fn(), resetGroups: vi.fn(), register: vi.fn(), capture: vi.fn(), captureException: vi.fn(),
  };
  return {
    posthog,
    reset: () => { Object.values(posthog).forEach(value => { if (typeof value === "function" && "mockClear" in value) value.mockClear(); }); },
  };
});

vi.mock("posthog-js", () => ({ default: sdk.posthog, posthog: sdk.posthog }));

import type { TelemetryResponse } from "../contracts/generated/TelemetryResponse.js";
import { applyTelemetry, captureBrowserException, captureReactError, sanitizeRoute, updateBrowserAnalyticsContext } from "../shell/browser-analytics.js";

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
    ...overrides,
  };
}

function inactive(): TelemetryResponse {
  return { noticeRequired: false, enabled: false };
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
    disable_session_recording: true,
  });
  expect(sdk.posthog.identify).toHaveBeenCalledWith("install-1:user:user-1", expect.objectContaining({ user_role: "member" }));
  const scrubbed = config.before_send({ event: "browser_exception", properties: { $current_url: "https://host/tasks/secret?q=token#hash", $initial_current_url: "https://host/projects/secret?token=value", $initial_pathname: "/projects/secret", $initial_referrer: "https://external.test/private", title: "secret title", error_message: "At https://host/tasks/secret?q=token" } });
  expect(scrubbed.properties).toMatchObject({ $current_url: "app://suplex/tasks/:id", $initial_current_url: "app://suplex/tasks/:id", $initial_pathname: "app://suplex/tasks/:id", $initial_referrer: "app://suplex/tasks/:id", error_message: "[redacted]" });
  expect(scrubbed.properties).not.toHaveProperty("title");
  expect(config).not.toHaveProperty("session_recording");

  const pageviews = () => sdk.posthog.capture.mock.calls.filter(([event]) => event === "$pageview").length;
  expect(pageviews()).toBe(1);

  await applyTelemetry(active());
  expect(pageviews()).toBe(1);

  await applyTelemetry(inactive());
  expect(sdk.posthog.opt_out_capturing).toHaveBeenCalled();
  expect(sdk.posthog.reset).toHaveBeenCalled();

  await applyTelemetry(active());
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

test("each user on a host is their own person in the host group", async () => {
  const users = [
    { userId: "user_development", accountId: "user_67e55044-10b1-426f-9247-bb680e5fe0c8", person: "user_67e55044-10b1-426f-9247-bb680e5fe0c8" },
    { userId: "user-chris", accountId: "user_chris_account", person: "user_chris_account" },
    { userId: "user-1", accountId: undefined, person: "install-1:user:user-1" },
  ];
  await applyTelemetry(inactive());
  for (const [index, { userId, accountId, person }] of users.entries()) {
    sdk.posthog.reset.mockClear();
    sdk.posthog.group.mockClear();
    await applyTelemetry(active({ userId, ...(accountId ? { accountId } : {}) }));
    expect(sdk.posthog.reset).toHaveBeenCalledTimes(index === 0 ? 0 : 1);
    expect(sdk.posthog.identify).toHaveBeenLastCalledWith(person, expect.objectContaining({ user_role: "member" }));
    expect(sdk.posthog.group).toHaveBeenCalledWith("host", "install-1");
  }
});

test("browser DNT prevents SDK initialization", async () => {
  Object.defineProperty(navigator, "doNotTrack", { configurable: true, value: "1" });
  await applyTelemetry(active());
  expect(sdk.posthog.init).not.toHaveBeenCalled();
});

function exceptionProperties(): Record<string, any> {
  return sdk.posthog.captureException.mock.calls.at(-1)![1] as Record<string, any>;
}

test("exceptions carry sanitized application frames and no message text", async () => {
  await applyTelemetry(active());
  const origin = window.location.origin;
  const error = new TypeError("secret prompt for acme/private-repo at /Users/alice/private.ts");
  error.stack = [
    "TypeError: secret prompt for acme/private-repo",
    `    at handleClick (${origin}/assets/index-Ab12.js:10:20)`,
    "    at https://cdn.example.test/lib.js:1:1",
    `    at async load (${origin}/assets/chunk.js?token=abc#secret:5:6)`,
    "    at /Users/alice/private.ts:3:4",
    `    at ${origin}/tasks/task_secret/view.js:7:8`,
    `    at new Widget (${origin}/assets/widget.js:2:3)`,
  ].join("\n");
  captureBrowserException(error, { mechanism: "onerror", line: 10, column: 20 });
  const properties = exceptionProperties();
  const entry = properties.$exception_list[0];
  expect(entry).toMatchObject({ type: "TypeError", value: "Browser TypeError", mechanism: { type: "onerror", handled: false, synthetic: false } });
  expect(entry.stacktrace.frames.map((frame: any) => [frame.function, frame.filename, frame.lineno, frame.colno])).toEqual([
    ["Widget", "app://suplex/assets/widget.js", 2, 3],
    ["load", "app://suplex/assets/chunk.js", 5, 6],
    ["handleClick", "app://suplex/assets/index-Ab12.js", 10, 20],
  ]);
  expect(properties.$exception_level).toBe("fatal");
  const sent = JSON.stringify([sdk.posthog.captureException.mock.calls.at(-1)![0].stack, properties]);
  for (const leak of ["secret", "acme", "alice", "cdn.example", "token=abc"]) expect(sent).not.toContain(leak);
});

test("before_send keeps exception frames and the level and redacts message fields", async () => {
  // `init` runs once per module, so this test loads a fresh one to read its config.
  vi.resetModules();
  const fresh = await import("../shell/browser-analytics.js");
  await fresh.applyTelemetry(active());
  const config = sdk.posthog.init.mock.calls.at(-1)![1];
  const origin = window.location.origin;
  const error = new TypeError("secret prompt");
  error.stack = `TypeError: secret prompt\n    at handleClick (${origin}/assets/index-Ab12.js:10:20)`;
  fresh.captureBrowserException(error, { mechanism: "onerror", line: 10, column: 20 });
  const captured = exceptionProperties();
  const scrubbed = config.before_send({
    event: "$exception",
    properties: { ...captured, $exception_message: "secret prompt at /Users/alice/private.ts" },
  });
  const properties = scrubbed.properties as Record<string, any>;
  expect(properties.$exception_message).toBe("[redacted]");
  expect(properties.$exception_level).toBe("fatal");
  const [frame] = properties.$exception_list[0].stacktrace.frames;
  expect(frame).toMatchObject({ filename: "app://suplex/assets/index-Ab12.js", function: "handleClick", lineno: 10, colno: 20 });
  expect(properties.$exception_list[0]).toMatchObject({ type: "TypeError", value: "Browser TypeError", mechanism: { type: "onerror", handled: false } });
  expect(JSON.stringify(properties)).not.toContain("secret");
});

test("react root errors have their own mechanisms and an error is reported once", async () => {
  await applyTelemetry(active());
  const mechanisms = (kind: "uncaught" | "caught" | "recoverable") => {
    captureReactError(kind, new Error(`render failed for ${kind} secret`));
    const entry = exceptionProperties().$exception_list[0];
    return [entry.mechanism.type, entry.mechanism.handled, entry.mechanism.synthetic];
  };
  expect(mechanisms("uncaught")).toEqual(["react.uncaught", false, true]);
  expect(mechanisms("caught")).toEqual(["react.caught", true, true]);
  expect(mechanisms("recoverable")).toEqual(["react.recoverable", true, true]);

  sdk.posthog.captureException.mockClear();
  const error = new Error("boom");
  captureReactError("uncaught", error);
  captureBrowserException(error, { mechanism: "onerror" });
  expect(sdk.posthog.captureException).toHaveBeenCalledOnce();
});

test("exceptions are not captured without consent", async () => {
  await applyTelemetry(inactive());
  captureBrowserException(new Error("x"), { mechanism: "onerror" });
  captureReactError("uncaught", new Error("x"));
  expect(sdk.posthog.captureException).not.toHaveBeenCalled();
});
