const storageKey = "forge-tab-id";
let tabId: string | undefined;
let documentId: string | undefined;
let lastReportAttempt = 0;
let lastApiSuccess = 0;

function randomId(): string | undefined {
  try { return typeof crypto !== "undefined" ? crypto.randomUUID() : undefined; }
  catch { return undefined; }
}

export function clientTabId(): string | undefined {
  if (tabId) return tabId;
  try {
    const stored = sessionStorage.getItem(storageKey);
    if (stored && /^[a-f0-9-]{36}$/i.test(stored)) return tabId = stored;
    tabId = randomId();
    if (tabId) sessionStorage.setItem(storageKey, tabId);
  } catch { tabId = randomId(); }
  return tabId;
}

function csrfToken(): string | undefined {
  return document.cookie.split(";").map(part => part.trim().split("=", 2)).find(([key]) => key === "csrf_v1")?.[1];
}

export function reportClientLifecycle(state: "startup" | "resumed" | "api_activity" | "pageshow" | "pagehide" | "visible" | "hidden" | "online" | "offline"): void {
  try {
    const token = csrfToken();
    const clientId = clientTabId();
    documentId ??= randomId();
    if (!token || !clientId || !documentId) return;
    lastReportAttempt = Date.now();
    void fetch("/api/system/client-lifecycle", {
      method: "POST",
      credentials: "same-origin",
      keepalive: state === "pagehide",
      headers: { "Content-Type": "application/json", "X-CSRF-V1": token, "X-Forge-Tab-Id": clientId },
      body: JSON.stringify({ state, tabId: clientId, documentId, clientTime: new Date().toISOString(), visible: document.visibilityState === "visible", online: navigator.onLine }),
    }).catch(() => undefined);
  } catch { /* Telemetry cannot block the page. */ }
}

export function reportAuthenticatedResume(force = false): void {
  if (force || Date.now() - lastReportAttempt > 30_000) reportClientLifecycle("resumed");
}

export function reportApiActivity(): void {
  const time = Date.now();
  if (lastApiSuccess && time - lastApiSuccess > 60_000 && time - lastReportAttempt > 30_000) reportClientLifecycle("api_activity");
  lastApiSuccess = time;
}

export function installClientLifecycle(): void {
  reportClientLifecycle("startup");
  window.addEventListener("pageshow", () => reportClientLifecycle("pageshow"));
  window.addEventListener("pagehide", () => reportClientLifecycle("pagehide"));
  document.addEventListener("visibilitychange", () => reportClientLifecycle(document.visibilityState === "visible" ? "visible" : "hidden"));
  window.addEventListener("online", () => reportClientLifecycle("online"));
  window.addEventListener("offline", () => reportClientLifecycle("offline"));
}
