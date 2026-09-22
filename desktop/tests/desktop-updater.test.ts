import { EventEmitter } from "node:events";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkForUpdates = vi.fn(async (): Promise<null> => null);
  downloadUpdate = vi.fn(async (): Promise<string[]> => []);
  quitAndInstall = vi.fn();
}

const updater = new FakeUpdater();
vi.mock("electron-updater", () => ({ autoUpdater: updater }));

let DesktopUpdater: typeof import("../src/desktop-updater")["DesktopUpdater"];
beforeAll(async () => { ({ DesktopUpdater } = await import("../src/desktop-updater")); });

const showMessageBox = vi.fn(async (): Promise<{ response: number }> => ({ response: 0 }));

beforeEach(() => {
  updater.removeAllListeners();
  updater.checkForUpdates.mockReset().mockResolvedValue(null);
  updater.downloadUpdate.mockReset().mockResolvedValue([]);
  updater.quitAndInstall.mockReset();
  showMessageBox.mockReset().mockResolvedValue({ response: 0 });
});

test("an unconfigured build explains that desktop app updates are not configured", async () => {
  const subject = new DesktopUpdater({ updater, dialog: { showMessageBox }, configured: false });
  await subject.check(false);
  expect(showMessageBox).not.toHaveBeenCalled();
  await subject.check(true);
  expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: "Desktop app updates are not configured." }));
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
});

test("manual check offers download and explicit restart", async () => {
  const subject = new DesktopUpdater({ updater, dialog: { showMessageBox }, configured: true });
  await subject.check(true);
  updater.emit("update-available", { version: "1.2.3" });
  await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce());
  updater.emit("update-downloaded", { version: "1.2.3" });
  await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true));
  expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ detail: "Restart the desktop app to apply the update. A Suplex host started by this app restarts too; an independent host is not changed." }));
});

test("an emitted and rejected error produces one accurate dialog", async () => {
  const subject = new DesktopUpdater({ updater, dialog: { showMessageBox }, configured: true });
  updater.checkForUpdates.mockImplementationOnce(async () => { const error = new Error("offline"); updater.emit("error", error); throw error; });
  await subject.check(true);
  expect(showMessageBox).toHaveBeenCalledTimes(1);
  expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: "Suplex could not check the desktop app update.", detail: "offline" }));

  showMessageBox.mockReset().mockResolvedValue({ response: 0 });
  updater.emit("update-available", { version: "1.2.4" });
  updater.downloadUpdate.mockImplementationOnce(async () => { const error = new Error("disk full"); updater.emit("error", error); throw error; });
  await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: "Suplex could not download the desktop app update.", detail: "disk full" })));
  expect(showMessageBox).toHaveBeenCalledTimes(2);
});

test("an install-time error is reported once", async () => {
  new DesktopUpdater({ updater, dialog: { showMessageBox }, configured: true });
  updater.emit("error", new Error("signature rejected"));
  await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce());
  expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: "Suplex could not install the desktop app update.", detail: "signature rejected" }));
});
