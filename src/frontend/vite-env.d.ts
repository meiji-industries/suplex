/// <reference types="vite/client" />
import type { HealthSnapshot } from "../platform/health.js";

declare global {
  interface Window {
    __SUPLEX_HEALTH__?: HealthSnapshot;
    /** Present only inside the Suplex desktop app. */
    suplexApp?: { accountCleared(): Promise<void> };
  __SUPLEX_VIEW__?: "auth" | "oauth-consent" | "admin" | "projects" | "tasks" | "board" | "timeline" | "company-settings" | "setup";
  }
}

export {};
