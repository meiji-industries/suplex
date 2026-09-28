import { contextBridge, ipcRenderer } from "electron";
import type { BootFailure, BootState } from "./boot";
import type { InstallEvent, InstallStage } from "./installer";
import type { TailscaleStatus } from "./tailscale";

export type DesktopSnapshot = {
  readonly state: BootState["name"];
  readonly stages: readonly InstallStage[];
  readonly finished: readonly { readonly stage: string; readonly skipped: boolean; readonly elapsedMs: number }[];
  readonly current: string | null;
  readonly log: readonly string[];
  readonly failure: BootFailure | null;
  readonly hosts: readonly string[];
  readonly currentHost: string | null;
  readonly localHost: string | null;
};

export type DesktopMessage =
  | { readonly action: "snapshot" }
  | { readonly action: "choose"; readonly mode: "local" | "remote" }
  | { readonly action: "cancel" }
  | { readonly action: "retry" }
  | { readonly action: "launch" }
  | { readonly action: "back" }
  | { readonly action: "open-logs" }
  | { readonly action: "copy-output" }
  | { readonly action: "test-connection"; readonly url: string }
  | { readonly action: "tailscale-status" }
  | { readonly action: "turn-on-tailscale" }
  | { readonly action: "open-tailscale" }
  | { readonly action: "remove-host"; readonly origin: string }
  | { readonly action: "select-host"; readonly origin: string };

export type DesktopApi = {
  snapshot(): Promise<DesktopSnapshot>;
  choose(mode: "local" | "remote"): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<void>;
  launch(): Promise<void>;
  back(): Promise<void>;
  openLogs(): Promise<void>;
  copyOutput(): Promise<void>;
  testConnection(url: string): Promise<{ readonly ok: boolean; readonly reason: string | null }>;
  tailscaleStatus(): Promise<TailscaleStatus>;
  turnOnTailscale(): Promise<string | null>;
  openTailscale(): Promise<void>;
  removeHost(origin: string): Promise<void>;
  selectHost(origin: string): Promise<void>;
  on(listener: (event: InstallEvent) => void): void;
};

export type NetworkAccessMode = "local" | "tailscale" | "all";
export type AppNetworkAccess =
  | { readonly managed: false }
  | { readonly managed: true; readonly mode: NetworkAccessMode; readonly busy: boolean; readonly httpsUrl: string | null };

declare const location: { readonly protocol: string }; // the preload runs in the renderer; this package compiles without the DOM lib

const send = async (message: DesktopMessage): Promise<unknown> => ipcRenderer.invoke("suplex:desktop", message);

const api: DesktopApi = {
  snapshot: async () => (await send({ action: "snapshot" })) as DesktopSnapshot,
  choose: async (mode) => { await send({ action: "choose", mode }); },
  cancel: async () => { await send({ action: "cancel" }); },
  retry: async () => { await send({ action: "retry" }); },
  launch: async () => { await send({ action: "launch" }); },
  back: async () => { await send({ action: "back" }); },
  openLogs: async () => { await send({ action: "open-logs" }); },
  copyOutput: async () => { await send({ action: "copy-output" }); },
  testConnection: async (url) => (await send({ action: "test-connection", url })) as { ok: boolean; reason: string | null },
  tailscaleStatus: async () => (await send({ action: "tailscale-status" })) as TailscaleStatus,
  turnOnTailscale: async () => (await send({ action: "turn-on-tailscale" })) as string | null,
  openTailscale: async () => { await send({ action: "open-tailscale" }); },
  removeHost: async (origin) => { await send({ action: "remove-host", origin }); },
  selectHost: async (origin) => { await send({ action: "select-host", origin }); },
  on: (listener) => { ipcRenderer.on("suplex:event", (_event, payload: InstallEvent) => { listener(payload); }); },
};

// Only the app's own onboarding pages get the bridge; a loaded Suplex origin must never see it.
// A Suplex origin gets one action: report that it cleared its account, which closes the app.
if (location.protocol === "file:") contextBridge.exposeInMainWorld("suplexDesktop", api);
else contextBridge.exposeInMainWorld("suplexApp", {
  accountCleared: async () => { await ipcRenderer.invoke("suplex:account-cleared"); },
  openHostPicker: async () => { await ipcRenderer.invoke("suplex:host-picker"); },
  networkAccess: async () => (await ipcRenderer.invoke("suplex:access", { action: "read" })) as AppNetworkAccess,
  setNetworkAccess: async (mode: NetworkAccessMode) => (await ipcRenderer.invoke("suplex:access", { action: "change", mode })) as AppNetworkAccess,
});
