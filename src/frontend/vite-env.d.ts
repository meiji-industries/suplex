import type { HealthSnapshot } from "../health.js";

declare global {
  interface Window {
    __FORGE_HEALTH__?: HealthSnapshot;
  __FORGE_VIEW__?: "auth" | "admin" | "projects" | "tasks" | "board" | "timeline" | "attention" | "company-settings";
  }
}

export {};
