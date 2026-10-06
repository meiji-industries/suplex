/// <reference types="vite/client" />
import type { HealthSnapshot } from "./contracts/health.js";

type DesktopNetworkAccessMode = "local" | "tailscale" | "all";
type DesktopNetworkAccess = { managed: false } | {
  managed: true;
  preference: DesktopNetworkAccessMode;
  active: DesktopNetworkAccessMode | null;
  pending: boolean;
  busy: boolean;
  httpsUrl: string | null;
};

declare global {
  interface Window {
    __SUPLEX_HEALTH__?: HealthSnapshot;
    /** Present only inside the Suplex desktop app. */
    suplexApp?: {
      /** `macos`, `linux`, or `windows`; an older shell sends none and runs on macOS. */
      platform?: string;
      accountCleared(): Promise<void>;
      openHostPicker(): Promise<void>;
      networkAccess(): Promise<DesktopNetworkAccess>;
      saveNetworkAccessPreference(mode: DesktopNetworkAccessMode): Promise<DesktopNetworkAccess>;
      restartNetworkAccess(): Promise<DesktopNetworkAccess>;
      onNetworkAccessChange(listener: (state: DesktopNetworkAccess) => void): () => void;
    };
    /** Present only inside the Suplex iOS and Android apps. */
    suplexMobile?: { openHostPicker(): Promise<void> };
  __SUPLEX_VIEW__?: "auth" | "account-login" | "oauth-consent" | "admin" | "projects" | "tasks" | "board" | "timeline" | "company-settings" | "setup";
  }
}

export {};
