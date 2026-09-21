import type { HealthSnapshot } from "../platform/health.js";

declare global {
  interface Window {
    __FORGE_HEALTH__?: HealthSnapshot;
  __FORGE_VIEW__?: "auth" | "oauth-consent" | "admin" | "projects" | "tasks" | "board" | "timeline" | "company-settings" | "setup";
  }
}

export {};
