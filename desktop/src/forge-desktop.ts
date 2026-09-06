import { app, BrowserWindow, dialog, Menu, screen, shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyNavigation, parseForgeTarget, resolveForgeTarget, type ForgeTarget } from "./forge-target";
import { forgetTarget, readTargets, rememberTarget, type TargetRegistry } from "./target-store";

const KEYCHAIN_ACCESS_GROUP = "6KY6743H52.dev.forge.desktop.webauthn"; // must match build/entitlements.mac.plist
const INVALID_TITLE = "The Forge URL is not valid";

type Bounds = { width: number; height: number; x?: number; y?: number };
type Preventable = { preventDefault(): void };

const retryPage = (origin: string): string =>
  `data:text/html,${encodeURIComponent(`<style>body{-webkit-app-region:drag;padding-top:env(titlebar-area-height,0px)}a{-webkit-app-region:no-drag}</style><h1>Forge is not available at ${origin}</h1><p><a href="${origin}">Retry</a></p><script>setTimeout(() => { location.href = ${JSON.stringify(origin)}; }, 5000);</script>`)}`;

/**
 * The whole desktop shell: one sandboxed window that attaches to an existing Forge origin.
 * It never starts, stops, or signals anything; quitting only closes the window.
 */
export async function runForgeDesktop(input: { readonly argv: readonly string[]; readonly environment: NodeJS.ProcessEnv }): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.exit(0); // the running Forge.app received our argv through the lock; leave at once, no teardown to run
    return;
  }
  const probe = input.environment.FORGE_DESKTOP_PROBE === "1";
  const connectPage = join(__dirname, "connect.html");
  const targetFile = (): string => join(app.getPath("userData"), "desktop.json");
  const stateFile = (): string => join(app.getPath("userData"), "window-state.json");
  let window: BrowserWindow | undefined;
  let origin: string | null = null;
  let registry: TargetRegistry = { current: null, targets: [] };

  const fail = (message: string): void => {
    if (probe) process.stderr.write(`${INVALID_TITLE}: ${message}\n`);
    else dialog.showErrorBox(INVALID_TITLE, message);
  };
  /** Same message without blocking the main thread; a second launch is waiting on this process to acknowledge it. */
  const warn = (message: string): void => {
    process.stderr.write(`${INVALID_TITLE}: ${message}\n`);
    if (!probe) void dialog.showMessageBox({ type: "error", title: INVALID_TITLE, message });
  };
  const bounds = async (): Promise<Bounds> => {
    let saved: Partial<Bounds> = {};
    try { saved = JSON.parse(await readFile(stateFile(), "utf8")) as Partial<Bounds>; } catch { /* first launch */ }
    const area = screen.getPrimaryDisplay().workArea;
    return {
      width: Math.max(900, Math.min(saved.width ?? 1200, area.width)),
      height: Math.max(600, Math.min(saved.height ?? 800, area.height)),
      ...(saved.x !== undefined ? { x: Math.max(area.x, Math.min(saved.x, area.x + area.width - 100)) } : {}),
      ...(saved.y !== undefined ? { y: Math.max(area.y, Math.min(saved.y, area.y + area.height - 100)) } : {}),
    };
  };
  const persistBounds = (): void => {
    if (window && !window.isDestroyed()) void writeFile(stateFile(), JSON.stringify(window.getBounds())).catch(() => undefined);
  };
  const load = async (win: BrowserWindow, target: ForgeTarget): Promise<void> => {
    origin = target.origin;
    await win.loadURL(target.url).catch(() => undefined); // did-fail-load shows the retry page
  };
  const showConnectPage = async (win: BrowserWindow): Promise<void> => {
    origin = null;
    rebuildMenu();
    await win.loadFile(connectPage);
  };
  /** Remembers the target's origin as current and loads the target. */
  const switchTo = async (win: BrowserWindow, target: ForgeTarget): Promise<void> => {
    if (!probe) registry = await rememberTarget(targetFile(), target);
    origin = target.origin;
    rebuildMenu();
    await load(win, target);
  };
  const forgetCurrent = async (): Promise<void> => {
    if (origin) registry = await forgetTarget(targetFile(), origin);
    if (window) await showConnectPage(window);
  };
  const rebuildMenu = (): void => {
    const targets: Electron.MenuItemConstructorOptions[] = registry.targets.map((target) => ({
      label: new URL(target.origin).host,
      type: "radio",
      checked: target.origin === origin,
      click: () => { if (window) void switchTo(window, target); },
    }));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      { label: "Navigate", submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+[", click: () => window?.webContents.goBack() },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => window?.webContents.goForward() },
        { type: "separator" },
        ...targets,
        ...(targets.length > 0 ? [{ type: "separator" as const }] : []),
        { label: "Add a Forge URL", click: () => { if (window) void showConnectPage(window); } },
        { label: "Forget this Forge", enabled: origin !== null, click: () => { void forgetCurrent(); } },
      ] },
    ]));
  };
  const runProbe = async (win: BrowserWindow): Promise<void> => {
    const [navigatorCredentials, platformAuthenticator] = (await win.webContents.executeJavaScript(
      "Promise.all([Boolean(navigator.credentials), typeof PublicKeyCredential === 'undefined' ? false : PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()])",
    )) as [boolean, boolean];
    const cookies = origin ? await win.webContents.session.cookies.get({ url: origin }) : [];
    process.stdout.write(`${JSON.stringify({ url: win.webContents.getURL(), origin, navigatorCredentials, platformAuthenticator, cookieCount: cookies.length })}\n`);
    app.quit();
  };

  const createWindow = async (): Promise<BrowserWindow> => {
    const win = new BrowserWindow({
      ...(await bounds()),
      minWidth: 900,
      minHeight: 600,
      backgroundColor: "#0a0a0a",
      titleBarStyle: "hidden", // the page keeps clear of the traffic lights through env(titlebar-area-x)
      titleBarOverlay: true,
      trafficLightPosition: { x: 16, y: 12 },
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    window = win;
    let debounce: NodeJS.Timeout | undefined;
    const later = (): void => { if (debounce) clearTimeout(debounce); debounce = setTimeout(persistBounds, 300); };
    win.on("resize", later);
    win.on("move", later);
    win.on("close", persistBounds);
    win.on("closed", () => { if (window === win) window = undefined; });
    win.webContents.setWindowOpenHandler(({ url }) => {
      const decision = classifyNavigation(url, origin);
      if (decision.kind === "internal") void win.loadURL(decision.url);
      if (decision.kind === "external") void shell.openExternal(decision.url);
      return { action: "deny" };
    });
    const guard = (event: Preventable, url: string): void => {
      if (url.startsWith("file:") && win.webContents.getURL().startsWith("file:")) {
        const submitted = new URL(url).searchParams.get("url");
        if (submitted === null) return;
        event.preventDefault();
        try {
          void switchTo(win, parseForgeTarget(submitted));
        } catch (error) {
          fail((error as Error).message);
        }
        return;
      }
      const decision = classifyNavigation(url, origin);
      if (decision.kind === "internal") return;
      event.preventDefault();
      if (decision.kind === "external") void shell.openExternal(decision.url);
    };
    win.webContents.on("will-navigate", guard);
    win.webContents.on("will-redirect", guard);
    win.webContents.on("did-fail-load", (_event, _code, _description, validatedUrl, mainFrame) => {
      if (mainFrame && origin && !validatedUrl.startsWith("data:") && !validatedUrl.startsWith("file:")) void win.loadURL(retryPage(origin));
    });
    return win;
  };

  /** Idempotent: focuses the live window, or resolves the target and creates one. */
  const open = async (): Promise<void> => {
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.focus();
      return;
    }
    let resolved: ReturnType<typeof resolveForgeTarget>;
    try {
      registry = await readTargets(targetFile());
      resolved = resolveForgeTarget({ argv: input.argv, environment: input.environment, persisted: registry.current?.url ?? null });
    } catch (error) {
      fail((error as Error).message);
      app.exit(1);
      return;
    }
    const win = await createWindow();
    if (resolved) await switchTo(win, resolved.target); else await showConnectPage(win);
    if (probe) await runProbe(win);
  };
  /** A second launch (for example `open -a Forge --args --url …`) may carry a target; otherwise it just focuses the window. */
  const openWith = async (argv: readonly string[]): Promise<void> => {
    let requested: ForgeTarget | null;
    try {
      requested = resolveForgeTarget({ argv, environment: {}, persisted: null })?.target ?? null;
    } catch (error) {
      warn((error as Error).message);
      return;
    }
    await open();
    if (requested && window) await switchTo(window, requested);
  };

  app.on("second-instance", (_event, argv) => { void openWith(argv); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("activate", () => { void open(); });
  app.setAboutPanelOptions({ applicationName: "Forge", applicationVersion: app.getVersion() });
  await app.whenReady();
  app.configureWebAuthn({ touchID: { keychainAccessGroup: KEYCHAIN_ACCESS_GROUP, promptReason: "verify your identity on $1" } });
  rebuildMenu();
  await open();
}
