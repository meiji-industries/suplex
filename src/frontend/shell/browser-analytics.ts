import type { PostHog } from "posthog-js";

import type { TelemetryResponse } from "../contracts/generated/TelemetryResponse.js";
import { getTelemetry, telemetryRefreshKey } from "./telemetry-api.js";
import { registerApiFailureCapture } from "../lib/analytics-capture.js";

export type BrowserAnalyticsContext = {
  companyId?: string;
  companyPlan?: "free" | "pro" | null;
  platform: "desktop" | "browser";
};

const replayFlag = "suplex-app-session-replay";
const blockedReplaySelector = [
  ".xterm", "[data-terminal]", "[data-code-block]", "[data-prompt]", "[data-attachment]",
  "form:has(textarea)", "[data-native-message-id]", "pre", "code", "img", "picture", "svg", "canvas", "video",
].join(",");
const staticSegments = new Set(["access", "admin", "agents", "analytics", "api", "api-mcp", "auth", "backups", "billing", "board", "companies", "environment", "health", "moves", "notice", "onboarding", "profile", "projects", "providers", "settings", "setup", "tasks", "telemetry", "templates", "terminal", "timeline", "today", "triggers", "workflows"]);
const featureValues = new Map<string, boolean>();
const apiErrorCodes = new Set(["authentication_required", "request_origin_invalid", "administrator_required", "billing_unavailable", "forbidden", "not_found", "validation_failed", "conflict"]);

let client: PostHog | undefined;
let initializedKey: string | undefined;
let initializedHost: string | undefined;
let currentContext: BrowserAnalyticsContext = { platform: "browser" };
let currentTelemetry: TelemetryResponse | undefined;
let refreshGeneration = 0;
let installed = false;
let refreshTimer: number | undefined;
let routeStartedAt = Date.now();
let lastScreenScope: string | undefined;
let removeFlagListener: (() => void) | undefined;

export function sanitizeRoute(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean).map((segment) => {
    const decoded = (() => { try { return decodeURIComponent(segment); } catch { return segment; } })();
    return staticSegments.has(decoded) ? decoded : ":id";
  });
  return `/${segments.join("/")}` || "/";
}

function safeCurrentUrl(): string {
  return `app://suplex${sanitizeRoute(window.location.pathname)}`;
}

function sanitizeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (/title|prompt|code|text|input|body|header/i.test(key)) continue;
    if (/(?:url|uri|href|referr|pathname)/i.test(key)) {
      sanitized[key] = safeCurrentUrl();
    } else if (typeof value === "string" && /message|stack|exception|error/i.test(key)) {
      sanitized[key] = "[redacted]";
    } else if (typeof value === "string" && /(?:https?:\/\/|file:\/\/)/i.test(value)) {
      sanitized[key] = safeCurrentUrl();
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((entry) => {
        if (typeof entry === "string") return /message|stack|exception|error/i.test(key) ? "[redacted]" : entry;
        return entry && typeof entry === "object" ? sanitizeProperties(entry as Record<string, unknown>) : entry;
      });
    } else if (value && typeof value === "object") {
      sanitized[key] = sanitizeProperties(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function dntEnabled(): boolean {
  const legacy = window as Window & { doNotTrack?: string; msDoNotTrack?: string };
  const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };
  return privacy.globalPrivacyControl === true || [navigator.doNotTrack, legacy.doNotTrack, legacy.msDoNotTrack].some(value => value === "1" || value === "yes");
}

function baseProperties(): Record<string, unknown> {
  return {
    app_version: currentTelemetry?.appVersion,
    app_revision: currentTelemetry?.appRevision,
    platform: currentContext.platform,
    user_role: currentTelemetry?.userRole,
    company_plan: currentContext.companyPlan ?? "unknown",
    screen: sanitizeRoute(window.location.pathname),
    $current_url: safeCurrentUrl(),
  };
}

function syncFeatureFlags(): void {
  if (!client) return;
  const replay = client.isFeatureEnabled(replayFlag, { send_event: false }) === true;
  featureValues.set(replayFlag, replay);
  syncReplay();
}

function syncReplay(): void {
  if (!client) return;
  const enabled = currentTelemetry?.sessionReplayEnabled === true && featureValues.get(replayFlag) === true;
  client.set_config({ disable_session_recording: !enabled });
  if (enabled) client.startSessionRecording(); else client.stopSessionRecording();
}

/** The linked Suplex account, else this signed-in user on this host. */
function personId(telemetry: TelemetryResponse): string {
  return telemetry.accountId ?? `${telemetry.installationId}:user:${telemetry.userId}`;
}

function identify(): void {
  if (!client || !currentTelemetry?.installationId || !currentTelemetry.userId) return;
  client.identify(personId(currentTelemetry), {
    app_version: currentTelemetry.appVersion,
    app_revision: currentTelemetry.appRevision,
    platform: currentContext.platform,
    user_role: currentTelemetry.userRole,
  });
  client.group("host", currentTelemetry.installationId);
  if (currentContext.companyId) client.group("company", currentContext.companyId, { plan: currentContext.companyPlan ?? "unknown" });
  client.register(baseProperties());
}

function captureScreen(): void {
  if (!client || !currentTelemetry?.enabled) return;
  client?.capture("$pageview", baseProperties());
  client?.capture("screen_viewed", baseProperties());
  routeStartedAt = Date.now();
}

function analyticsScope(): string | undefined {
  if (!currentTelemetry?.installationId || !currentTelemetry.userId) return undefined;
  return `${personId(currentTelemetry)}:${currentContext.companyId ?? "none"}`;
}

function captureScreenForNewScope(): void {
  const scope = analyticsScope();
  if (!scope || scope === lastScreenScope) return;
  lastScreenScope = scope;
  captureScreen();
}

function captureEngagement(): void {
  if (!client || !currentTelemetry?.enabled) return;
  client.capture("session_engaged", { ...baseProperties(), duration_s: Math.max(0, Math.round((Date.now() - routeStartedAt) / 1000)) });
}

function disableCapture(): void {
  refreshGeneration += 1;
  currentTelemetry = undefined;
  lastScreenScope = undefined;
  featureValues.clear();
  removeFlagListener?.();
  removeFlagListener = undefined;
  if (client) {
    client.stopSessionRecording();
    client.opt_out_capturing();
    client.resetGroups();
    client.reset();
  }
}

export function stopBrowserAnalytics(): void {
  disableCapture();
}

export async function applyTelemetry(response: TelemetryResponse): Promise<void> {
  const generation = ++refreshGeneration;
  if (!response.enabled || dntEnabled() || !response.projectKey || !response.host || !response.installationId || !response.userId) {
    disableCapture();
    return;
  }
  if ((initializedKey && initializedKey !== response.projectKey) || (initializedHost && initializedHost !== response.host)) {
    disableCapture();
    return;
  }
  const previousUser = currentTelemetry?.installationId && currentTelemetry.userId ? personId(currentTelemetry) : undefined;
  const nextUser = personId(response);
  const imported = await import("posthog-js");
  if (generation !== refreshGeneration) return;
  if (!client) client = imported.posthog;
  const activeClient = client;
  if (previousUser && previousUser !== nextUser) {
    activeClient.stopSessionRecording();
    activeClient.resetGroups();
    activeClient.reset();
    lastScreenScope = undefined;
  }
  currentTelemetry = response;
  if (!initializedKey) {
    activeClient.init(response.projectKey, {
      api_host: response.host,
      ui_host: "https://us.posthog.com",
      defaults: "2026-05-30",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      capture_performance: false,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      rageclick: false,
      disable_session_recording: true,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "*",
        maskAllElementAttributes: true,
        blockSelector: blockedReplaySelector,
        recordHeaders: false,
        recordBody: false,
        streamNetworkBody: false,
        recordCrossOriginIframes: false,
        captureCanvas: { recordCanvas: false },
        captureJsonLd: false,
        maskCapturedNetworkRequestFn: (request) => {
          if (!request.isInitial) return null;
          const timing = { ...request };
          delete timing.requestHeaders;
          delete timing.requestBody;
          delete timing.responseHeaders;
          delete timing.responseBody;
          return { ...timing, name: safeCurrentUrl() };
        },
      },
      enable_recording_console_log: false,
      logs: { captureConsoleLogs: false },
      mask_all_text: true,
      mask_all_element_attributes: true,
      disable_surveys: true,
      disable_surveys_automatic_display: true,
      disable_web_experiments: true,
      opt_out_capturing_by_default: true,
      opt_out_persistence_by_default: true,
      respect_dnt: true,
      before_send: (event) => event ? { ...event, properties: sanitizeProperties(event.properties ?? {}) } : null,
    });
    initializedKey = response.projectKey;
    initializedHost = response.host;
  }
  removeFlagListener ??= activeClient.onFeatureFlags(syncFeatureFlags);
  activeClient.opt_in_capturing({ captureEventName: false });
  identify();
  syncFeatureFlags();
  captureScreenForNewScope();
}

export async function refreshBrowserAnalytics(): Promise<void> {
  try { await applyTelemetry(await getTelemetry()); } catch { disableCapture(); }
}

export function updateBrowserAnalyticsContext(context: BrowserAnalyticsContext): void {
  const companyChanged = currentContext.companyId !== context.companyId;
  currentContext = context;
  if (companyChanged) {
    client?.resetGroups();
    lastScreenScope = undefined;
  }
  identify();
  captureScreenForNewScope();
}

export function captureBrowserException(reason: unknown, source?: { line?: number; column?: number }): void {
  if (!client || !currentTelemetry?.enabled) return;
  const rawType = reason instanceof Error ? reason.name : "Error";
  const type = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError"]).has(rawType) ? rawType : "Error";
  const line = Number.isSafeInteger(source?.line) ? Math.max(0, source?.line ?? 0) : 0;
  const column = Number.isSafeInteger(source?.column) ? Math.max(0, source?.column ?? 0) : 0;
  const safe = new Error(`Browser ${type}`);
  safe.name = type;
  safe.stack = `${type}: Browser ${type}\n    at app (suplex://app.js:${line}:${column})`;
  client.captureException(safe, { ...baseProperties(), source_line: line, source_column: column });
}

function captureApiFailure({ url, status, code }: { url: string; status: number; code?: string }): void {
  if (!client || !currentTelemetry?.enabled) return;
  let pathname = "/";
  try { pathname = new URL(url, window.location.origin).pathname; } catch { /* Use the root route. */ }
  client.capture("api_request_failed", {
    ...baseProperties(),
    api_route: sanitizeRoute(pathname),
    status,
    error_code: code && apiErrorCodes.has(code) ? code : "unknown",
  });
}

function routeChanged(): void {
  captureEngagement();
  captureScreen();
}

export function installBrowserAnalytics(): () => void {
  if (installed) return () => undefined;
  installed = true;
  registerApiFailureCapture(captureApiFailure);
  const refresh = (): void => { void refreshBrowserAnalytics(); };
  const storage = (event: StorageEvent): void => { if (event.key === telemetryRefreshKey) refresh(); };
  const visible = (): void => { if (document.visibilityState === "visible") refresh(); };
  const error = (event: ErrorEvent): void => captureBrowserException(event.error ?? event.message, { line: event.lineno, column: event.colno });
  const rejection = (event: PromiseRejectionEvent): void => captureBrowserException(event.reason);
  window.addEventListener("suplex:telemetry-change", refresh);
  window.addEventListener("suplex:navigate", routeChanged);
  window.addEventListener("popstate", routeChanged);
  window.addEventListener("storage", storage);
  window.addEventListener("pagehide", captureEngagement);
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  document.addEventListener("visibilitychange", visible);
  refreshTimer = window.setInterval(refresh, 30_000);
  refresh();
  return () => {
    installed = false;
    registerApiFailureCapture(undefined);
    window.removeEventListener("suplex:telemetry-change", refresh);
    window.removeEventListener("suplex:navigate", routeChanged);
    window.removeEventListener("popstate", routeChanged);
    window.removeEventListener("storage", storage);
    window.removeEventListener("pagehide", captureEngagement);
    window.removeEventListener("error", error);
    window.removeEventListener("unhandledrejection", rejection);
    document.removeEventListener("visibilitychange", visible);
    if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
    refreshTimer = undefined;
    disableCapture();
  };
}

