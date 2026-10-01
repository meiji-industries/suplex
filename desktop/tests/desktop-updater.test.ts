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
const notify = vi.fn<(message: string, open: () => void) => void>();
/** Clicks the most recent notification. */
const click = (): void => { notify.mock.lastCall?.[1](); };
const options = { updater, dialog: { showMessageBox }, notify, configured: true };

beforeEach(() => {
  updater.removeAllListeners();
  updater.checkForUpdates.mockReset().mockResolvedValue(null);
  updater.downloadUpdate.mockReset().mockResolvedValue([]);
  updater.quitAndInstall.mockReset();
  showMessageBox.mockReset().mockResolvedValue({ response: 0 });
  notify.mockReset();
});

test("an unconfigured build explains that desktop app updates are not configured", async () => {
  const subject = new DesktopUpdater({ ...options, configured: false });
  await subject.check(false);
  expect(showMessageBox).not.toHaveBeenCalled();
  await subject.check(true);
  expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: "Desktop app updates are not configured." }));
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
});

test("manual check offers download, and a finished download offers restart from its notification", async () => {
  const subject = new DesktopUpdater(options);
  await subject.check(true);
  updater.emit("update-available", { version: "1.2.3" });
  await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce());
  showMessageBox.mockClear();
  updater.emit("update-downloaded", { version: "1.2.3" });
  expect(notify).toHaveBeenCalledWith("Suplex desktop app 1.2.3 was downloaded.", expect.any(Function));
  expect(showMessageBox).not.toHaveBeenCalled();
  click();
  await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true));
  expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ detail: "Restart the desktop app to apply the update. A Suplex host started by this app restarts too; an independent host is not changed." }));
});

test("a manual check after a download offers the restart again", async () => {
  const subject = new DesktopUpdater(options);
  updater.emit("update-downloaded", { version: "1.2.3" });
  await subject.check(true);
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
  expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: "Suplex desktop app 1.2.3 was downloaded." }));
  expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
});

// macOS refuses a quit request while a dialog is open, and a dialog takes the window to the front.
test("events that arrive on their own never open a dialog", async () => {
  const subject = new DesktopUpdater(options);
  updater.checkForUpdates.mockImplementation(async () => { updater.emit("update-available", { version: "0.2.0" }); return null; });
  await subject.check(false);
  updater.emit("update-downloaded", { version: "0.2.0" });
  updater.emit("error", new Error("signature rejected"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(showMessageBox).not.toHaveBeenCalled();
  expect(notify.mock.calls.map(([message]) => message)).toEqual([
    "Suplex desktop app 0.2.0 is available.",
    "Suplex desktop app 0.2.0 was downloaded.",
    "Suplex could not install the desktop app update.",
  ]);
  click();
  await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: "Suplex could not install the desktop app update.", detail: "signature rejected" })));
});

test("an emitted and rejected error is reported once", async () => {
  const subject = new DesktopUpdater(options);
  updater.checkForUpdates.mockImplementationOnce(async () => { const error = new Error("offline"); updater.emit("error", error); throw error; });
  await subject.check(true);
  expect(showMessageBox).toHaveBeenCalledTimes(1);
  expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: "Suplex could not check the desktop app update.", detail: "offline" }));

  updater.checkForUpdates.mockResolvedValue(null);
  await subject.check(true);
  updater.downloadUpdate.mockImplementationOnce(async () => { const error = new Error("disk full"); updater.emit("error", error); throw error; });
  updater.emit("update-available", { version: "1.2.4" });
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Suplex could not download the desktop app update.", expect.any(Function)));
  expect(notify).toHaveBeenCalledOnce();
  click();
  await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: "Suplex could not download the desktop app update.", detail: "disk full" })));
});

test("automatic checks announce a version once, but a manual check offers it again", async () => {
  const subject = new DesktopUpdater(options);
  updater.checkForUpdates.mockImplementation(async () => { updater.emit("update-available", { version: "0.2.0" }); return null; });
  await subject.check(false);
  await subject.check(false);
  expect(notify).toHaveBeenCalledOnce();
  await subject.check(true);
  await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledOnce());
});

test("an automatic check waits while an offer is open", async () => {
  const subject = new DesktopUpdater(options);
  updater.checkForUpdates.mockImplementation(async () => { updater.emit("update-available", { version: "0.2.0" }); return null; });
  let answer: (value: { response: number }) => void = () => undefined;
  showMessageBox.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  await subject.check(false);
  click();
  await subject.check(false);
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  answer({ response: 1 });
});
