import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const userData = mkdtempSync(join(tmpdir(), "forge-desktop-shell-"));
class FakeWebContents extends EventEmitter {
  url = "";
  windowOpenHandler: ((details: { url: string }) => { action: string }) | undefined;
  session = { cookies: { get: async (): Promise<unknown[]> => [] } };
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
  constructor(public options: { webPreferences: Record<string, unknown> }) { super(); FakeWindow.all.push(this); }
  isDestroyed(): boolean { return this.destroyed; }
  isMinimized(): boolean { return this.minimized; }
  restore(): void { this.minimized = false; }
  focus(): void { this.focused += 1; }
  getBounds(): { width: number; height: number; x: number; y: number } { return { width: 1200, height: 800, x: 0, y: 0 }; }
  loadURL(url: string): Promise<void> { return this.webContents.loadURL(url); }
  async loadFile(file: string): Promise<void> { this.webContents.url = `file://${file}`; }
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
const fake = {
  userData,
  FakeWindow,
  app,
  BrowserWindow: FakeWindow,
  Menu: { buildFromTemplate: (template: unknown): unknown => template, setApplicationMenu: (_menu: unknown): void => undefined },
  shell: { openExternal: async (_url: string): Promise<void> => undefined },
  dialog: { showErrorBox: (_title: string, _content: string): void => undefined, showMessageBox: async (_options: unknown): Promise<unknown> => undefined },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
};

vi.mock("electron", () => fake);

let runForgeDesktop: typeof import("../src/forge-desktop")["runForgeDesktop"];
beforeAll(async () => { ({ runForgeDesktop } = await import("../src/forge-desktop")); }); // lazy so the mock factory sees the fakes above

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
const ORIGIN = "https://forge.tail1234.ts.net";

beforeEach(() => {
  fake.app.removeAllListeners();
  fake.app.isPackaged = false;
  fake.FakeWindow.all = [];
  rmSync(targetFile, { force: true });
  vi.clearAllMocks();
});

describe("window", () => {
  test("is sandboxed, isolated, without Node or a preload, and loads the exact target", async () => {
    await runForgeDesktop({ argv: ["--url", `${ORIGIN}/auth?invite=abc`], environment: {} });
    const [win] = fake.FakeWindow.all;
    expect(fake.FakeWindow.all).toHaveLength(1);
    expect(win?.options.webPreferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false });
    expect(win?.webContents.url).toBe(`${ORIGIN}/auth?invite=abc`);
    expect(JSON.parse(readFileSync(targetFile, "utf8")), "an argument launch is remembered as an origin").toEqual({ current: `${ORIGIN}/`, targets: [`${ORIGIN}/`] });
  });

  test("navigation fails closed: same origin stays, http(s) opens outside, the rest is dropped", async () => {
    await runForgeDesktop({ argv: [], environment: { FORGE_DESKTOP_URL: ORIGIN } });
    const contents = fake.FakeWindow.all[0]!.webContents;
    for (const eventName of ["will-navigate", "will-redirect"] as const) {
      const internal = preventable();
      contents.emit(eventName, internal, `${ORIGIN}/tasks/1`);
      expect(internal.preventDefault, eventName).not.toHaveBeenCalled();
      const external = preventable();
      contents.emit(eventName, external, "https://github.com/meiji-industries/forge");
      expect(external.preventDefault, eventName).toHaveBeenCalled();
      expect(openExternal, eventName).toHaveBeenLastCalledWith("https://github.com/meiji-industries/forge");
      const otherPort = preventable();
      contents.emit(eventName, otherPort, `${ORIGIN}:8443/`);
      expect(otherPort.preventDefault, eventName).toHaveBeenCalled();
      openExternal.mockClear();
      for (const url of ["javascript:alert(1)", "file:///etc/passwd", "forge-desktop://x", "data:text/html,hi"]) {
        const blocked = preventable();
        contents.emit(eventName, blocked, url);
        expect(blocked.preventDefault, url).toHaveBeenCalled();
      }
      expect(openExternal, eventName).not.toHaveBeenCalled();
    }
  });

  test("popups never open a second window", async () => {
    await runForgeDesktop({ argv: [], environment: { FORGE_DESKTOP_URL: ORIGIN } });
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
    await runForgeDesktop({ argv: [], environment: { FORGE_DESKTOP_URL: ORIGIN } });
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
    await runForgeDesktop({ argv: [], environment: { FORGE_DESKTOP_URL: ORIGIN } });
    fake.app.lock = true;
    expect(exit).toHaveBeenCalledWith(0);
    expect(fake.FakeWindow.all).toHaveLength(0);
  });
});

describe("remembered targets", () => {
  const OTHER = "https://meiji.tail1234.ts.net:4111";
  test("the Navigate menu lists every remembered Forge, checks the current one, and switches on click", async () => {
    writeFileSync(targetFile, JSON.stringify({ current: `${OTHER}/`, targets: [`${OTHER}/`, "http://localhost:4211/"] }));
    await runForgeDesktop({ argv: [], environment: {} });
    const win = fake.FakeWindow.all[0]!;
    expect(win.webContents.url).toBe(`${OTHER}/`);
    expect(navigateMenu().filter((entry) => entry.type === "radio").map((entry) => [entry.label, entry.checked])).toEqual([["meiji.tail1234.ts.net:4111", true], ["localhost:4211", false]]);
    menuItem("localhost:4211").click!();
    await vi.waitFor(() => expect(win.webContents.url).toBe("http://localhost:4211/"));
    expect(menuItem("localhost:4211").checked).toBe(true);
    expect(JSON.parse(readFileSync(targetFile, "utf8")).current).toBe("http://localhost:4211/");
    const external = preventable();
    win.webContents.emit("will-navigate", external, `${OTHER}/tasks`);
    expect(external.preventDefault, "the previous Forge is now external").toHaveBeenCalled();
  });

  test("Add a Forge URL shows the connection page without forgetting; Forget this Forge drops the current one", async () => {
    writeFileSync(targetFile, JSON.stringify({ current: `${OTHER}/`, targets: [`${OTHER}/`, "http://localhost:4211/"] }));
    await runForgeDesktop({ argv: [], environment: {} });
    const win = fake.FakeWindow.all[0]!;
    menuItem("Add a Forge URL").click!();
    await vi.waitFor(() => expect(win.webContents.url).toMatch(/connect\.html$/));
    expect(JSON.parse(readFileSync(targetFile, "utf8")).targets).toHaveLength(2);
    expect(menuItem("Forget this Forge").enabled).toBe(false);
    menuItem("meiji.tail1234.ts.net:4111").click!();
    await vi.waitFor(() => expect(win.webContents.url).toBe(`${OTHER}/`));
    menuItem("Forget this Forge").click!();
    await vi.waitFor(() => expect(win.webContents.url).toMatch(/connect\.html$/));
    expect(JSON.parse(readFileSync(targetFile, "utf8"))).toEqual({ current: null, targets: ["http://localhost:4211/"] });
  });

  test("a second launch with --url switches the open window; without one it only focuses", async () => {
    await runForgeDesktop({ argv: [], environment: { FORGE_DESKTOP_URL: ORIGIN } });
    const win = fake.FakeWindow.all[0]!;
    fake.app.emit("second-instance", {}, ["/Applications/Forge.app/Contents/MacOS/Forge", "--url", "--allow-file-access-from-files", "--enable-avfoundation", "http://localhost:4211"]);
    await vi.waitFor(() => expect(win.webContents.url).toBe("http://localhost:4211/"));
    fake.app.emit("second-instance", {}, ["/Applications/Forge.app/Contents/MacOS/Forge"]);
    await vi.waitFor(() => expect(win.focused).toBe(2));
    expect(win.webContents.url).toBe("http://localhost:4211/");
    fake.app.emit("second-instance", {}, ["Forge", "--url=http://forge.example.com"]);
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalled());
    expect(showErrorBox, "a second launch must never block the main thread with a modal").not.toHaveBeenCalled();
    expect(fake.FakeWindow.all).toHaveLength(1);
  });
});

describe("target sources", () => {
  test("an invalid explicit target fails visibly and does not fall through", async () => {
    writeFileSync(targetFile, JSON.stringify({ url: `${ORIGIN}/` }));
    await runForgeDesktop({ argv: ["--url", "http://forge.example.com"], environment: {} });
    expect(showErrorBox).toHaveBeenCalledWith("The Forge URL is not valid", expect.stringMatching(/^--url is not valid/));
    expect(exit).toHaveBeenCalledWith(1);
    expect(fake.FakeWindow.all).toHaveLength(0);
  });

  test("a packaged build accepts loopback http and rejects http elsewhere", async () => {
    fake.app.isPackaged = true;
    await runForgeDesktop({ argv: [], environment: { FORGE_DESKTOP_URL: "http://localhost:4111" } });
    expect(fake.FakeWindow.all[0]!.webContents.url).toBe("http://localhost:4111/");
    fake.app.removeAllListeners();
    await runForgeDesktop({ argv: [], environment: { FORGE_DESKTOP_URL: "http://forge.example.com" } });
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a corrupt persisted target is deleted and the connection page appears", async () => {
    writeFileSync(targetFile, "{corrupt");
    await runForgeDesktop({ argv: [], environment: {} });
    expect(fake.FakeWindow.all[0]!.webContents.url).toMatch(/^file:.*connect\.html$/);
    expect(existsSync(targetFile)).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  test("the connection page submission is validated, persisted as an origin, and loaded", async () => {
    await runForgeDesktop({ argv: [], environment: {} });
    const win = fake.FakeWindow.all[0]!;
    const page = win.webContents.url;
    expect(existsSync(targetFile)).toBe(false);
    const bad = preventable();
    win.webContents.emit("will-navigate", bad, `${page}?url=${encodeURIComponent("http://forge.example.com")}`);
    expect(bad.preventDefault).toHaveBeenCalled();
    expect(showErrorBox).toHaveBeenCalledWith("The Forge URL is not valid", expect.stringMatching(/localhost/));
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
