import { app, BrowserWindow, dialog, Menu, screen, shell } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyNavigation, parseForgeTarget, resolveForgeTarget, type ForgeTarget } from "./forge-target";
import { forgetTarget, readTargets, rememberTarget, type TargetRegistry } from "./target-store";

const KEYCHAIN_ACCESS_GROUP = "6KY6743H52.dev.forge.desktop.webauthn"; // must match build/entitlements.mac.plist
const INVALID_TITLE = "The Forge URL is not valid";

type Bounds = { width: number; height: number; x?: number; y?: number };
type Preventable = { preventDefault(): void };

export function retryPage(origin: string): string {
  const address = origin.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Forge</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: max(48px, env(titlebar-area-height, 0px)) 24px 32px; background: #0a0a0a; color: #e5e5e5; font: 13px/1.5 -apple-system, system-ui, sans-serif; -webkit-app-region: drag; }
  main { width: min(100%, 560px); }
  h1, h2, p { margin: 0; }
  h1 { font-size: 14px; font-weight: 600; }
  h2 { margin-top: 24px; font-size: 13px; font-weight: 600; }
  p, small { color: #a3a3a3; font-size: 12px; }
  h2 + p { margin-top: 6px; }
  svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .connection { display: grid; grid-template-columns: minmax(0, 1fr) 72px minmax(0, 1fr); align-items: center; text-align: center; margin-bottom: 28px; }
  .node { display: grid; justify-items: center; gap: 6px; min-width: 0; }
  .node strong { font-size: 12px; font-weight: 500; }
  .node small { font-size: 11px; overflow-wrap: anywhere; -webkit-app-region: no-drag; user-select: text; }
  .icon { display: grid; place-items: center; width: 64px; height: 52px; border: 1px solid #303030; border-radius: 6px; background: #171717; margin-bottom: 2px; }
  .broken { display: flex; align-items: center; gap: 5px; color: #fb7185; }
  .broken::before, .broken::after { content: ""; flex: 1; border-top: 1px dashed currentColor; }
  .broken svg { width: 18px; height: 18px; }
  .notice { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border: 1px solid #4c2630; border-radius: 6px; color: #fda4af; }
  .notice svg { flex: none; width: 16px; height: 16px; margin-top: 2px; }
  .notice p { margin-top: 2px; color: #fda4af; }
  .command { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding: 10px 12px; background: #171717; border: 1px solid #303030; border-radius: 6px; }
  code { flex: 1; min-width: 0; font: 12px/1.5 ui-monospace, SFMono-Regular, monospace; overflow-wrap: anywhere; user-select: text; -webkit-app-region: no-drag; }
  button, a { -webkit-app-region: no-drag; }
  button, .retry { font: inherit; display: inline-flex; align-items: center; justify-content: center; min-height: 28px; padding: 0 10px; border: 1px solid #404040; border-radius: 5px; background: #171717; color: #e5e5e5; cursor: pointer; text-decoration: none; }
  button:hover { background: #262626; }
  button:focus-visible, a:focus-visible, code:focus-visible { outline: 2px solid #a3a3a3; outline-offset: 3px; }
  #copy-status { min-height: 24px; padding-top: 4px; }
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 6px; }
  .retry { background: #e5e5e5; border-color: #e5e5e5; color: #171717; height: 32px; padding: 0 12px; }
  .retry:hover { background: #d4d4d4; }
  footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #262626; }
  footer a { color: #d4d4d4; text-underline-offset: 3px; }
  footer p { margin-top: 8px; }
  @media (max-width: 480px) { body { padding-left: 18px; padding-right: 18px; } .connection { grid-template-columns: minmax(0, 1fr) 36px minmax(0, 1fr); } }
</style></head><body><main>
  <div class="connection" role="img" aria-label="This Forge window cannot reach the Forge host">
    <div class="node"><div class="icon"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/></svg></div><strong>This window</strong><small>Forge.app</small></div>
    <div class="broken"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/></svg></div>
    <div class="node"><div class="icon"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/></svg></div><strong>Forge host</strong><small>${address}</small></div>
  </div>
  <section class="notice" aria-labelledby="connection-title"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg><div><h1 id="connection-title">Forge is not available</h1><p>This window cannot reach the Forge host.</p></div></section>
  <h2>Start Forge on the host</h2><p>Open the Terminal on the server host. Run this command from the Forge folder, then retry.</p>
  <div class="command"><code id="command" tabindex="0">pnpm run forge start</code><button id="copy" type="button">Copy</button></div>
  <p id="copy-status" role="status" aria-live="polite"></p>
  <div class="actions"><a class="retry" id="retry" href="${address}">Retry</a><p>Forge retries every 5 seconds.</p></div>
  <footer><a href="https://github.com/meiji-industries/forge#set-up-an-installation">Open the install guide</a><p>To use another host, select Navigate &gt; Add a Forge URL.</p></footer>
</main><script>
  const command = document.getElementById("command");
  const copy = document.getElementById("copy");
  const feedback = document.getElementById("copy-status");
  copy.addEventListener("click", async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(command.textContent);
      else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(command);
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand("copy")) throw new Error("Copy failed");
        selection.removeAllRanges();
      }
      copy.textContent = "Copied";
      feedback.textContent = "Command copied.";
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    } catch {
      copy.textContent = "Copy";
      feedback.textContent = "Copy failed. Select the command and copy it.";
    }
  });
  setTimeout(() => { location.href = document.getElementById("retry").href; }, 5000);
</script></body></html>`)}`;
}

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
