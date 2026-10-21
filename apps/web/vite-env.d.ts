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

/** `Status` in `apps/desktop/src-tauri/src/updater.rs`. */
export type DesktopUpdateStatus =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "available"; version: string }
  | { phase: "downloading"; version: string; received: number; total: number | null }
  | { phase: "ready"; version: string };

declare global {
  interface Window {
    __SUPLEX_HEALTH__?: HealthSnapshot;
    /** Present only inside the Suplex desktop app. */
    suplexApp?: {
      /** `macos`, `linux`, or `windows`; an older shell sends none and runs on macOS. */
      platform?: string;
      /** The installed desktop app version; an older shell sends none. */
      version?: string;
      accountCleared(): Promise<void>;
      openHostPicker(): Promise<void>;
      networkAccess(): Promise<DesktopNetworkAccess>;
      saveNetworkAccessPreference(mode: DesktopNetworkAccessMode): Promise<DesktopNetworkAccess>;
      restartNetworkAccess(): Promise<DesktopNetworkAccess>;
      onNetworkAccessChange(listener: (state: DesktopNetworkAccess) => void): () => void;
      /** Absent in an older shell. */
      updateStatus?(): Promise<DesktopUpdateStatus>;
      checkForUpdates?(): Promise<void>;
      onUpdateChange?(listener: (status: DesktopUpdateStatus) => void): () => void;
      /** Zooms the whole app one level in or out, or back to 100 percent. Absent in an older shell. */
      zoom?(step: "in" | "out" | "reset"): Promise<void>;
    };
    /** Present only inside the Suplex iOS and Android apps. */
    suplexMobile?: { openHostPicker(): Promise<void> };
  __SUPLEX_VIEW__?: "auth" | "account-login" | "oauth-consent" | "admin" | "projects" | "tasks" | "board" | "timeline" | "company-settings" | "setup";
  }
}

export {};
