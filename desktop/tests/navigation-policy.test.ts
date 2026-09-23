import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { healthy } from "../src/local-runtime";
import type { DesktopMessage, DesktopSnapshot } from "../src/preload";

const userData = mkdtempSync(join(tmpdir(), "suplex-desktop-shell-"));
class FakeWebContents extends EventEmitter {
  url = "";
  windowOpenHandler: ((details: { url: string }) => { action: string }) | undefined;
  session = { cookies: { get: async (): Promise<unknown[]> => [] } };
  sent: unknown[] = [];
  send(_channel: string, payload: unknown): void { this.sent.push(payload); }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void { this.windowOpenHandler = handler; }
  async loadURL(url: string): Promise<void> { this.url = url; }
  getURL(): string { return this.url; }
  async executeJavaScript(): Promise<[boolean, boolean]> { return [true, false]; }
  goBack(): void {}
  goForward(): void {}
}
class FakeWindow extends EventEmitter {
  static all: FakeWindow[] = [];
  webContents = new FakeWebContents();
  destroyed = false;
  minimized = false;
  focused = 0;
  constructor(public options: Record<string, unknown> & { webPreferences: Record<string, unknown> }) { super(); FakeWindow.all.push(this); }
  isDestroyed(): boolean { return this.destroyed; }
  isMinimized(): boolean { return this.minimized; }
  restore(): void { this.minimized = false; }
  focus(): void { this.focused += 1; }
  getBounds(): { width: number; height: number; x: number; y: number } { return { width: 1200, height: 800, x: 0, y: 0 }; }
  loadURL(url: string): Promise<void> { return this.webContents.loadURL(url); }
  async loadFile(file: string): Promise<void> { this.webContents.url = `file://${file}`; this.webContents.emit("did-finish-load"); }
  close(): void { this.destroyed = true; this.emit("closed"); }
}
const app = Object.assign(new EventEmitter(), {
  isPackaged: false,
  lock: true,
  requestSingleInstanceLock: (): boolean => app.lock,
  whenReady: async (): Promise<void> => undefined,
  getPath: (): string => userData,
  getVersion: (): string => "0.0.0",
  quit: (): void => undefined,
  exit: (_code: number): void => undefined,
  configureWebAuthn: (): void => undefined,
  setAboutPanelOptions: (): void => undefined,
});
const ipcMain = {
  handlers: new Map<string, (event: unknown, message: DesktopMessage) => Promise<unknown>>(),
  handle(channel: string, handler: (event: unknown, message: DesktopMessage) => Promise<unknown>): void { ipcMain.handlers.set(channel, handler); },
  removeHandler(channel: string): void { ipcMain.handlers.delete(channel); },
};
/** Drives one of the onboarding pages the way the preload does. */
const desktop = async (message: DesktopMessage): Promise<unknown> => ipcMain.handlers.get("suplex:desktop")!({ senderFrame: { url: "file:///pages/choice.html" } }, message);
const fake = {
  userData,
  FakeWindow,
  app,
  BrowserWindow: FakeWindow,
  Menu: { buildFromTemplate: (template: unknown): unknown => template, setApplicationMenu: (_menu: unknown): void => undefined },
  ipcMain,
  clipboard: { writeText: (_text: string): void => undefined },
  shell: { openExternal: async (_url: string): Promise<void> => undefined, openPath: async (_path: string): Promise<string> => "" },
  dialog: { showErrorBox: (_title: string, _content: string): void => undefined, showMessageBox: async (_options: unknown): Promise<unknown> => undefined },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
};
const autoUpdater = Object.assign(new EventEmitter(), {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  checkForUpdates: async (): Promise<null> => null,
  downloadUpdate: async (): Promise<string[]> => [],
  quitAndInstall: (): void => undefined,
});

vi.mock("electron", () => fake);
vi.mock("electron-updater", () => ({ autoUpdater }));

let runSuplexDesktop: typeof import("../src/suplex-desktop")["runSuplexDesktop"];
beforeAll(async () => { ({ runSuplexDesktop } = await import("../src/suplex-desktop")); });

const targetFile = join(fake.userData, "desktop.json");
const openExternal = vi.spyOn(fake.shell, "openExternal");
const showErrorBox = vi.spyOn(fake.dialog, "showErrorBox");
const showMessageBox = vi.spyOn(fake.dialog, "showMessageBox");
const exit = vi.spyOn(fake.app, "exit");
const preventable = (): { preventDefault: ReturnType<typeof vi.fn> } => ({ preventDefault: vi.fn() });
type MenuEntry = { label?: string; type?: string; checked?: boolean; enabled?: boolean; click?: () => void; submenu?: MenuEntry[] };
const setApplicationMenu = vi.spyOn(fake.Menu, "setApplicationMenu");
const navigateMenu = (): MenuEntry[] => (setApplicationMenu.mock.lastCall?.[0] as unknown as MenuEntry[]).find((entry) => entry.label === "Navigate")!.submenu!;
const menuItem = (label: string): MenuEntry => navigateMenu().find((entry) => entry.label === label)!;
const ORIGIN = "https://suplex.tail1234.ts.net";

beforeEach(() => {
  fake.app.removeAllListeners();
  autoUpdater.removeAllListeners();
  fake.app.isPackaged = false;
  fake.FakeWindow.all = [];
  rmSync(targetFile, { force: true });
  vi.clearAllMocks();
});

describe("window", () => {
  test("is sandboxed, isolated, without Node integration, and loads the exact target", async () => {
    await runSuplexDesktop({ argv: ["--url", `${ORIGIN}/auth?invite=abc`], environment: {} });
    const [win] = fake.FakeWindow.all;
    expect(fake.FakeWindow.all).toHaveLength(1);
    expect(win?.options.webPreferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, preload: expect.stringMatching(/preload\.js$/) });
    expect(win?.options).toMatchObject({ titleBarStyle: "hidden", titleBarOverlay: true, trafficLightPosition: { x: 16, y: 12 } });
    expect(win?.webContents.url).toBe(`${ORIGIN}/auth?invite=abc`);
    expect(JSON.parse(readFileSync(targetFile, "utf8")), "an argument launch is remembered as an origin").toEqual({ current: `${ORIGIN}/`, targets: [`${ORIGIN}/`] });
  });

  test("navigation fails closed: same origin stays, http(s) opens outside, the rest is dropped", async () => {
    await runSuplexDesktop({ argv: [], environment: { SUPLEX_DESKTOP_URL: ORIGIN } });
    const contents = fake.FakeWindow.all[0]!.webContents;
    for (const eventName of ["will-navigate", "will-redirect"] as const) {
      const internal = preventable();
      contents.emit(eventName, internal, `${ORIGIN}/tasks/1`);
      expect(internal.preventDefault, eventName).not.toHaveBeenCalled();
      const external = preventable();
      contents.emit(eventName, external, "https://github.com/meiji-industries/suplex");
      expect(external.preventDefault, eventName).toHaveBeenCalled();
      expect(openExternal, eventName).toHaveBeenLastCalledWith("https://github.com/meiji-industries/suplex");
      const otherPort = preventable();
      contents.emit(eventName, otherPort, `${ORIGIN}:8443/`);
      expect(otherPort.preventDefault, eventName).toHaveBeenCalled();
      openExternal.mockClear();
      for (const url of ["javascript:alert(1)", "file:///etc/passwd", "suplex-desktop://x", "data:text/html,hi"]) {
        const blocked = preventable();
        contents.emit(eventName, blocked, url);
        expect(blocked.preventDefault, url).toHaveBeenCalled();
      }
      expect(openExternal, eventName).not.toHaveBeenCalled();
    }
  });

  test("popups never open a second window", async () => {
    await runSuplexDesktop({ argv: [], environment: { SUPLEX_DESKTOP_URL: ORIGIN } });
    const win = fake.FakeWindow.all[0]!;
    const handler = win.webContents.windowOpenHandler!;
    expect(handler({ url: "https://github.com/x" })).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://github.com/x");
    expect(handler({ url: `${ORIGIN}/tasks/2` })).toEqual({ action: "deny" });
    await vi.waitFor(() => expect(win.webContents.url).toBe(`${ORIGIN}/tasks/2`));
    openExternal.mockClear();
    expect(handler({ url: "javascript:alert(1)" })).toEqual({ action: "deny" });
    expect(openExternal).not.toHaveBeenCalled();
    expect(fake.FakeWindow.all).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  test("activation and second launches focus the one window; a closed window is recreated", async () => {
    await runSuplexDesktop({ argv: [], environment: { SUPLEX_DESKTOP_URL: ORIGIN } });
    const first = fake.FakeWindow.all[0]!;
    fake.app.emit("activate");
    fake.app.emit("activate");
    first.minimized = true;
    fake.app.emit("second-instance", {}, []);
    await vi.waitFor(() => expect(first.focused).toBe(3));
    expect(fake.FakeWindow.all).toHaveLength(1);
    expect(first.minimized).toBe(false);
    first.close();
    fake.app.emit("activate");
    await vi.waitFor(() => expect(fake.FakeWindow.all).toHaveLength(2));
    await vi.waitFor(() => expect(fake.FakeWindow.all[1]!.webContents.url).toBe(`${ORIGIN}/`));
  });

  test("a second instance quits without touching anything", async () => {
    fake.app.lock = false;
    await runSuplexDesktop({ argv: [], environment: { SUPLEX_DESKTOP_URL: ORIGIN } });
    fake.app.lock = true;
    expect(exit).toHaveBeenCalledWith(0);
    expect(fake.FakeWindow.all).toHaveLength(0);
  });
});

describe("remembered targets", () => {
  const OTHER = "https://meiji.tail1234.ts.net:4111";
  test("the Navigate menu lists every remembered Suplex, checks the current one, and switches on click", async () => {
    writeFileSync(targetFile, JSON.stringify({ current: `${OTHER}/`, targets: [`${OTHER}/`, "http://localhost:4211/"] }));
    await runSuplexDesktop({ argv: [], environment: {} });
    const win = fake.FakeWindow.all[0]!;
    expect(win.webContents.url).toBe(`${OTHER}/`);
    expect(navigateMenu().filter((entry) => entry.type === "radio").map((entry) => [entry.label, entry.checked])).toEqual([["meiji.tail1234.ts.net:4111", true], ["localhost:4211", false]]);
    menuItem("localhost:4211").click!();
    await vi.waitFor(() => expect(win.webContents.url).toBe("http://localhost:4211/"));
    expect(menuItem("localhost:4211").checked).toBe(true);
    expect(JSON.parse(readFileSync(targetFile, "utf8")).current).toBe("http://localhost:4211/");
    const external = preventable();
    win.webContents.emit("will-navigate", external, `${OTHER}/tasks`);
    expect(external.preventDefault, "the previous Suplex is now external").toHaveBeenCalled();
  });

  test("Add a Suplex URL shows the connection page without forgetting; Forget this Suplex drops the current one", async () => {
    writeFileSync(targetFile, JSON.stringify({ current: `${OTHER}/`, targets: [`${OTHER}/`, "http://localhost:4211/"] }));
    await runSuplexDesktop({ argv: [], environment: {} });
    const win = fake.FakeWindow.all[0]!;
    menuItem("Add a Suplex URL").click!();
    await vi.waitFor(() => expect(win.webContents.url).toMatch(/connect\.html$/));
    expect(JSON.parse(readFileSync(targetFile, "utf8")).targets).toHaveLength(2);
    expect(menuItem("Forget this Suplex").enabled).toBe(false);
    menuItem("meiji.tail1234.ts.net:4111").click!();
    await vi.waitFor(() => expect(win.webContents.url).toBe(`${OTHER}/`));
    menuItem("Forget this Suplex").click!();
    await vi.waitFor(() => expect(win.webContents.url).toMatch(/connect\.html$/));
    expect(JSON.parse(readFileSync(targetFile, "utf8"))).toEqual({ current: null, targets: ["http://localhost:4211/"] });
  });

  test("a second launch with --url switches the open window; without one it only focuses", async () => {
    await runSuplexDesktop({ argv: [], environment: { SUPLEX_DESKTOP_URL: ORIGIN } });
    const win = fake.FakeWindow.all[0]!;
    fake.app.emit("second-instance", {}, ["/Applications/Suplex.app/Contents/MacOS/Suplex", "--url", "--allow-file-access-from-files", "--enable-avfoundation", "http://localhost:4211"]);
    await vi.waitFor(() => expect(win.webContents.url).toBe("http://localhost:4211/"));
    fake.app.emit("second-instance", {}, ["/Applications/Suplex.app/Contents/MacOS/Suplex"]);
    await vi.waitFor(() => expect(win.focused).toBe(2));
    expect(win.webContents.url).toBe("http://localhost:4211/");
    fake.app.emit("second-instance", {}, ["Suplex", "--url=http://suplex.example.com"]);
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalled());
    expect(showErrorBox, "a second launch must never block the main thread with a modal").not.toHaveBeenCalled();
    expect(fake.FakeWindow.all).toHaveLength(1);
  });
});

describe("target sources", () => {
  test("an invalid explicit target fails visibly and does not fall through", async () => {
    writeFileSync(targetFile, JSON.stringify({ url: `${ORIGIN}/` }));
    await runSuplexDesktop({ argv: ["--url", "http://suplex.example.com"], environment: {} });
    expect(showErrorBox).toHaveBeenCalledWith("The Suplex URL is not valid", expect.stringMatching(/^--url is not valid/));
    expect(exit).toHaveBeenCalledWith(1);
    expect(fake.FakeWindow.all).toHaveLength(0);
  });

  test("a packaged build accepts loopback http and rejects http elsewhere", async () => {
    fake.app.isPackaged = true;
    await runSuplexDesktop({ argv: [], environment: { SUPLEX_DESKTOP_URL: "http://localhost:4111" } });
    expect(fake.FakeWindow.all[0]!.webContents.url).toBe("http://localhost:4111/");
    fake.app.removeAllListeners();
    await runSuplexDesktop({ argv: [], environment: { SUPLEX_DESKTOP_URL: "http://suplex.example.com" } });
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a corrupt persisted target is deleted and the choice screen appears", async () => {
    writeFileSync(targetFile, "{corrupt");
    await runSuplexDesktop({ argv: [], environment: {} });
    expect(fake.FakeWindow.all[0]!.webContents.url).toMatch(/^file:.*pages\/choice\.html$/);
    expect(existsSync(targetFile)).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  test("the connection page submission is validated, persisted as an origin, and loaded", async () => {
    await runSuplexDesktop({ argv: [], environment: {} });
    const win = fake.FakeWindow.all[0]!;
    await desktop({ action: "choose", mode: "remote" });
    await vi.waitFor(() => expect(win.webContents.url).toMatch(/connect\.html$/));
    const page = win.webContents.url;
    expect(existsSync(targetFile)).toBe(false);
    const bad = preventable();
    win.webContents.emit("will-navigate", bad, `${page}?url=${encodeURIComponent("http://suplex.example.com")}`);
    expect(bad.preventDefault).toHaveBeenCalled();
    expect(showErrorBox).toHaveBeenCalledWith("The Suplex URL is not valid", expect.stringMatching(/localhost/));
    expect(win.webContents.url).toBe(page);
    const good = preventable();
    win.webContents.emit("will-navigate", good, `${page}?url=${encodeURIComponent(`${ORIGIN}/auth?invite=abc`)}`);
    expect(good.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(win.webContents.url).toBe(`${ORIGIN}/auth?invite=abc`));
    expect(JSON.parse(readFileSync(targetFile, "utf8"))).toEqual({ current: `${ORIGIN}/`, targets: [`${ORIGIN}/`] });
    const later = preventable();
    win.webContents.emit("will-navigate", later, "https://github.com/x");
    expect(later.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://github.com/x");
  });
});

describe("local install", () => {
  const FIXTURE = join(__dirname, "fixtures", "runtime");
  const installFile = join(fake.userData, "install.json");
  const settings = (value: Record<string, unknown>): void => {
    mkdirSync(join(fake.userData, "data"), { recursive: true });
    writeFileSync(join(fake.userData, "data", "fixture.json"), JSON.stringify(value));
  };
  const start = async (): Promise<FakeWindow> => {
    await runSuplexDesktop({ argv: [], environment: { SUPLEX_DESKTOP_NODE: join(FIXTURE, "node", "bin", "node"), SUPLEX_DESKTOP_APP: join(FIXTURE, "app"), HOME: process.env.HOME, USER: process.env.USER } });
    return fake.FakeWindow.all[0]!;
  };
  const onPage = async (win: FakeWindow, page: string, timeout = 20_000): Promise<void> => {
    await vi.waitFor(() => expect(win.webContents.url).toMatch(new RegExp(`pages/${page}\\.html$`)), { timeout });
  };

  beforeEach(() => {
    rmSync(installFile, { force: true });
    rmSync(join(fake.userData, "data"), { recursive: true, force: true });
    rmSync(join(fake.userData, "logs"), { recursive: true, force: true });
  });

  test("choice, install, ready, launch, then the window is on the server this app started", async () => {
    const win = await start();
    await onPage(win, "choice");
    expect(((await desktop({ action: "snapshot" })) as DesktopSnapshot).state).toBe("choosing");
    await desktop({ action: "choose", mode: "local" });
    await onPage(win, "install");
    await onPage(win, "ready");
    const record = JSON.parse(readFileSync(installFile, "utf8")) as { runtimeStamp: string; port: number };
    expect(record).toMatchObject({ runtimeStamp: "0.0.0-fixture", port: 4111 });
    writeFileSync(installFile, JSON.stringify({ ...record, port: 0 })); // port 0 takes a free one, so the walk never adopts a Suplex this machine is already running
    await desktop({ action: "launch" });
    await onPage(win, "connecting");
    await vi.waitFor(() => expect(win.webContents.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/), { timeout: 20_000 });
    const origin = new URL(win.webContents.url).origin;
    expect(await healthy(origin)).toBe(true);
    expect(JSON.parse(readFileSync(installFile, "utf8")).port, "the chosen port is remembered").toBe(Number(new URL(origin).port));
    expect(readFileSync(join(fake.userData, "logs", "server.log"), "utf8")).toContain("fixture supervisor listening");
    const quit = preventable();
    fake.app.emit("before-quit", quit);
    expect(quit.preventDefault).toHaveBeenCalled();
    await vi.waitFor(async () => { expect(await healthy(origin)).toBe(false); }, { timeout: 10_000 });
  });

  test("a failed stage latches until Retry, which reruns from that stage", async () => {
    settings({ failStage: "herdr", reason: "curl exited 22", remedy: "Check the network connection and retry." });
    const win = await start();
    await desktop({ action: "choose", mode: "local" });
    await onPage(win, "failed");
    const snapshot = (await desktop({ action: "snapshot" })) as DesktopSnapshot;
    expect(snapshot.failure).toMatchObject({ from: "installing", stage: "herdr", title: "Install Herdr terminals", reason: "curl exited 22", remedy: "Check the network connection and retry." });
    expect(snapshot.failure?.log).toContain("herdr could not finish");
    await desktop({ action: "launch" });
    expect(((await desktop({ action: "snapshot" })) as DesktopSnapshot).state, "the failure is latched").toBe("failed");
    settings({});
    await desktop({ action: "retry" });
    await onPage(win, "ready");
    expect(existsSync(installFile)).toBe(true);
  });
});
