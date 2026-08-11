import type { HealthSnapshot } from "../health.js";

declare global {
  interface Window {
    __FORGE_HEALTH__: HealthSnapshot;
  }
}

export {};
