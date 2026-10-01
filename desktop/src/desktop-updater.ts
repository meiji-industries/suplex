import { autoUpdater, type UpdateInfo } from "electron-updater";

type DialogPort = {
  showMessageBox(options: { type: "info" | "error"; title: string; message: string; detail?: string; buttons: string[]; defaultId?: number; cancelId?: number }): Promise<{ response: number }>;
};

/** Shows a system notification; `open` runs when the viewer clicks it. */
type NotifyPort = (message: string, open: () => void) => void;

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

const FAILURE = {
  check: "Suplex could not check the desktop app update.",
  download: "Suplex could not download the desktop app update.",
  install: "Suplex could not install the desktop app update.",
} as const;

export class DesktopUpdater {
  private readonly updater: UpdaterPort;
  private readonly dialog: DialogPort;
  private readonly notify: NotifyPort;
  private readonly configured: boolean;
  private manualCheck = false;
  private activeAction: "check" | "download" | undefined;
  /** A prompt is open or a download is running; an automatic check waits for the next interval. */
  private offering = false;
  /** The version an automatic check already announced; automatic checks stop offering it, a manual check still does. */
  private announced: string | undefined;
  /** A finished download that waits for a restart; a manual check offers the restart again. */
  private downloaded: UpdateInfo | undefined;

  // A dialog opens only as the direct answer to a click. macOS refuses a quit request while one is open, and it takes
  // the window to the front. An automatic check, a finished download, and a failure after a download arrive when
  // nobody may be present, so they post a notification; clicking it opens the dialog.
  constructor(options: { updater: UpdaterPort; dialog: DialogPort; notify: NotifyPort; configured: boolean }) {
    this.updater = options.updater;
    this.dialog = options.dialog;
    this.notify = options.notify;
    this.configured = options.configured;
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.on("update-available", (info) => {
      const manual = this.manualCheck;
      this.manualCheck = false;
      if (manual) { void this.offerDownload(info); return; }
      if (info.version === this.announced) return;
      this.announced = info.version;
      this.notify(`Suplex desktop app ${info.version} is available.`, () => { void this.offerDownload(info); });
    });
    this.updater.on("update-not-available", () => { const show = this.manualCheck; this.manualCheck = false; if (show) void this.showCurrent(); });
    this.updater.on("update-downloaded", (info) => {
      this.downloaded = info;
      this.notify(`Suplex desktop app ${info.version} was downloaded.`, () => { void this.offerRestart(info); });
    });
    this.updater.on("error", (error) => { if (!this.activeAction) this.notifyFailure("install", error); });
  }

  menuItem(): DesktopUpdateMenuItem {
    return { label: "Check for updates", click: () => { void this.check(true); } };
  }

  async check(manual: boolean): Promise<void> {
    if (!manual && (this.offering || this.activeAction)) return;
    if (manual && this.downloaded) { await this.offerRestart(this.downloaded); return; }
    this.manualCheck = manual;
    if (!this.configured) {
      if (manual) await this.dialog.showMessageBox({ type: "info", title: "Desktop app update", message: "Desktop app updates are not configured.", detail: "Install a new Suplex.app build to update the desktop app.", buttons: ["Continue"] });
      return;
    }
    this.activeAction = "check";
    try { await this.updater.checkForUpdates(); } catch (error) { this.manualCheck = false; if (manual) await this.showError("check", error); } finally { this.activeAction = undefined; }
  }

  private async offerDownload(info: UpdateInfo): Promise<void> {
    if (this.offering) return;
    this.offering = true;
    try {
      const answer = await this.dialog.showMessageBox({ type: "info", title: "Desktop app update", message: `Suplex desktop app ${info.version} is available.`, buttons: ["Start download", "Continue"], defaultId: 0, cancelId: 1 });
      if (answer.response !== 0) return;
      this.activeAction = "download";
      try { await this.updater.downloadUpdate(); } catch (error) { this.notifyFailure("download", error); } finally { this.activeAction = undefined; }
    } finally {
      this.offering = false;
    }
  }

  private async offerRestart(info: UpdateInfo): Promise<void> {
    const answer = await this.dialog.showMessageBox({ type: "info", title: "Desktop app update", message: `Suplex desktop app ${info.version} was downloaded.`, detail: "Restart the desktop app to apply the update. A Suplex host started by this app restarts too; an independent host is not changed.", buttons: ["Restart Suplex", "Continue"], defaultId: 0, cancelId: 1 });
    if (answer.response === 0) this.updater.quitAndInstall(false, true);
  }

  private async showCurrent(): Promise<void> {
    await this.dialog.showMessageBox({ type: "info", title: "Desktop app update", message: "The Suplex desktop app is current.", buttons: ["Continue"] });
  }

  private notifyFailure(action: "download" | "install", error: unknown): void {
    this.notify(FAILURE[action], () => { void this.showError(action, error); });
  }

  private async showError(action: keyof typeof FAILURE, error: unknown): Promise<void> {
    await this.dialog.showMessageBox({ type: "error", title: "Desktop app update", message: FAILURE[action], detail: error instanceof Error ? error.message : String(error), buttons: ["Continue"] });
  }
}

export function createDesktopUpdater(options: { dialog: DialogPort; notify: NotifyPort; configured: boolean }): DesktopUpdater {
  return new DesktopUpdater({ updater: autoUpdater, ...options });
}
