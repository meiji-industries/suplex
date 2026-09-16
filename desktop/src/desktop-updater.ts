import { autoUpdater, type UpdateInfo } from "electron-updater";

type DialogPort = {
  showMessageBox(options: { type: "info" | "error"; title: string; message: string; detail?: string; buttons: string[]; defaultId?: number; cancelId?: number }): Promise<{ response: number }>;
};

export type DesktopUpdateMenuItem = { label: string; click(): void };
type UpdaterPort = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: "update-available" | "update-downloaded", listener: (info: UpdateInfo) => void): unknown;
  on(event: "update-not-available", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};

export class DesktopUpdater {
  private readonly updater: UpdaterPort;
  private readonly dialog: DialogPort;
  private readonly configured: boolean;
  private manualCheck = false;
  private activeAction: "check" | "download" | undefined;

  constructor(options: { updater: UpdaterPort; dialog: DialogPort; configured: boolean }) {
    this.updater = options.updater;
    this.dialog = options.dialog;
    this.configured = options.configured;
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.on("update-available", (info) => { this.manualCheck = false; void this.offerDownload(info); });
    this.updater.on("update-not-available", () => { const show = this.manualCheck; this.manualCheck = false; if (show) void this.showCurrent(); });
    this.updater.on("update-downloaded", (info) => { void this.offerRestart(info); });
    this.updater.on("error", (error) => { if (!this.activeAction) void this.showError("install", error); });
  }

  menuItem(): DesktopUpdateMenuItem {
    return { label: "Check for Desktop Update", click: () => { void this.check(true); } };
  }

  async check(manual: boolean): Promise<void> {
    this.manualCheck = manual;
    if (!this.configured) {
      if (manual) await this.dialog.showMessageBox({ type: "info", title: "Desktop app update", message: "Desktop app updates are not configured.", detail: "Install a new Forge.app build to update the desktop app.", buttons: ["Continue"] });
      return;
    }
    this.activeAction = "check";
    try { await this.updater.checkForUpdates(); } catch (error) { this.manualCheck = false; if (manual) await this.showError("check", error); } finally { this.activeAction = undefined; }
  }

  private async offerDownload(info: UpdateInfo): Promise<void> {
    const answer = await this.dialog.showMessageBox({ type: "info", title: "Desktop app update", message: `Forge desktop app ${info.version} is available.`, buttons: ["Start download", "Continue"], defaultId: 0, cancelId: 1 });
    if (answer.response === 0) {
      this.activeAction = "download";
      try { await this.updater.downloadUpdate(); } catch (error) { await this.showError("download", error); } finally { this.activeAction = undefined; }
    }
  }

  private async offerRestart(info: UpdateInfo): Promise<void> {
    const answer = await this.dialog.showMessageBox({ type: "info", title: "Desktop app update", message: `Forge desktop app ${info.version} was downloaded.`, detail: "Restart the desktop app to apply the update. A Forge host started by this app restarts too; an independent host is not changed.", buttons: ["Restart Forge", "Continue"], defaultId: 0, cancelId: 1 });
    if (answer.response === 0) this.updater.quitAndInstall(false, true);
  }

  private async showCurrent(): Promise<void> {
    await this.dialog.showMessageBox({ type: "info", title: "Desktop app update", message: "The Forge desktop app is current.", buttons: ["Continue"] });
  }

  private async showError(action: "check" | "download" | "install", error: unknown): Promise<void> {
    const message = action === "check" ? "Forge could not check the desktop app update." : action === "download" ? "Forge could not download the desktop app update." : "Forge could not install the desktop app update.";
    await this.dialog.showMessageBox({ type: "error", title: "Desktop app update", message, detail: error instanceof Error ? error.message : String(error), buttons: ["Continue"] });
  }
}

export function createDesktopUpdater(options: { dialog: DialogPort; configured: boolean }): DesktopUpdater {
  return new DesktopUpdater({ updater: autoUpdater, ...options });
}
