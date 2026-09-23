/// <reference types="vite/client" />
import type { HealthSnapshot } from "../platform/health.js";

declare global {
  interface Window {
    __SUPLEX_HEALTH__?: HealthSnapshot;
  __SUPLEX_VIEW__?: "auth" | "oauth-consent" | "admin" | "projects" | "tasks" | "board" | "timeline" | "company-settings" | "setup";
  }
}

export {};
