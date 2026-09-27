import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, session, shell } from "electron";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyNavigation, parseSuplexTarget, resolveSuplexTarget, type SuplexTarget } from "./suplex-target";
import { forgetTarget, readTargets, rememberTarget, type TargetRegistry } from "./target-store";
import { createDesktopUpdater } from "./desktop-updater";
import { DEFAULT_PORT, next, readInstallRecord, resolveBoot, runtimePaths, runtimeStamp, writeInstallRecord, type BootEvent, type BootState } from "./boot";
import { createInstaller, type InstallEvent, type InstallStage, type Installer } from "./installer";
import { createLocalRuntime, healthy, type LocalRuntime } from "./local-runtime";
import { openTailscale, tailscaleStatus, turnOnTailscale } from "./tailscale";
import type { DesktopMessage, DesktopSnapshot } from "./preload";

const KEYCHAIN_ACCESS_GROUP = "6KY6743H52.dev.suplex.desktop.webauthn"; // inert until build/entitlements.mac.plist grants it via a provisioning profile
const INVALID_TITLE = "The Suplex URL is not valid";
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** The CONNECTING page (pages/connecting.html) as an overlay on a Suplex page that has not finished loading. */
const CONNECTING_COVER = "html::after { content: \"CONNECTING\"; position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; background: #0a0a0a; color: #737373; font: 500 12px/1.5 -apple-system, system-ui, sans-serif; letter-spacing: 0.32em; animation: suplex-connecting 1.6s ease-in-out infinite; } @keyframes suplex-connecting { 50% { color: #e5e5e5; } }";

type Bounds = { width: number; height: number; x?: number; y?: number };
type Preventable = { preventDefault(): void };

export function retryPage(origin: string): string {
  const address = origin.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  return `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Suplex</title>
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
  <div class="connection" role="img" aria-label="This Suplex window cannot reach the Suplex host">
    <div class="node"><div class="icon"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/></svg></div><strong>This window</strong><small>Suplex.app</small></div>
    <div class="broken"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/></svg></div>
    <div class="node"><div class="icon"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/></svg></div><strong>Suplex host</strong><small>${address}</small></div>
  </div>
  <section class="notice" aria-labelledby="connection-title"><svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg><div><h1 id="connection-title">Suplex is not available</h1><p>This window cannot reach the Suplex host.</p></div></section>
  <h2>Start Suplex on the host</h2><p>Open the Terminal on the server host. Run this command from the Suplex folder, then retry.</p>
  <div class="command"><code id="command" tabindex="0">pnpm run suplex start</code><button id="copy" type="button">Copy</button></div>
  <p id="copy-status" role="status" aria-live="polite"></p>
  <div class="actions"><a class="retry" id="retry" href="${address}">Retry</a><p>Suplex retries every 5 seconds.</p></div>
  <footer><a href="https://github.com/meiji-industries/suplex#set-up-an-installation">Open the install guide</a><p>To use another host, select Navigate &gt; Add a Suplex URL.</p></footer>
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
 * The desktop app is one sandboxed window. It either supervises the packaged Suplex on this Mac,
 * or attaches to a Suplex origin somebody else runs, which it never starts, stops, or signals.
 */
export async function runSuplexDesktop(input: { readonly argv: readonly string[]; readonly environment: NodeJS.ProcessEnv }): Promise<void> {
  // `pnpm dev` sets these so a dev run never shares the installed app's data, single-instance lock, or server port.
  if (input.environment.SUPLEX_DESKTOP_USER_DATA) app.setPath("userData", input.environment.SUPLEX_DESKTOP_USER_DATA);
  const defaultPort = Number(input.environment.SUPLEX_DESKTOP_PORT) || DEFAULT_PORT;
  if (!app.requestSingleInstanceLock()) {
    app.exit(0); // the running Suplex.app received our argv through the lock; leave at once, no teardown to run
    return;
  }
  const probe = input.environment.SUPLEX_DESKTOP_PROBE === "1";
  const packagedFeed = app.isPackaged && typeof process.resourcesPath === "string" && existsSync(join(process.resourcesPath, "app-update.yml"));
  const desktopUpdater = createDesktopUpdater({ dialog, configured: packagedFeed });
  const connectPage = join(__dirname, "connect.html");
  const targetFile = (): string => join(app.getPath("userData"), "desktop.json");
  const stateFile = (): string => join(app.getPath("userData"), "window-state.json");
  const installFile = (): string => join(app.getPath("userData"), "install.json");
  const logsDirectory = (): string => join(app.getPath("userData"), "logs");
  const runtime = runtimePaths(input.environment, typeof process.resourcesPath === "string" ? process.resourcesPath : "");
  let window: BrowserWindow | undefined;
  let origin: string | null = null;
  let registry: TargetRegistry = { current: null, targets: [] };
  let state: BootState = { name: "resolve" };
  /** The origin of the server this app supervises, so its failures never show the remote host's retry page. */
  let localOrigin: string | null = null;
  let server: LocalRuntime | undefined;
  let adopted = false;
  let installer: Installer | undefined;
  let quitting = false;
  const progress: { stages: readonly InstallStage[]; finished: { stage: string; skipped: boolean; elapsedMs: number }[]; current: string | null; log: string[] } =
    { stages: [], finished: [], current: null, log: [] };

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
  const load = async (win: BrowserWindow, target: SuplexTarget): Promise<void> => {
    origin = target.origin;
    await win.loadFile(join(__dirname, "pages", "connecting.html")).catch(() => undefined); // shown while the target answers
    await win.loadURL(target.url).catch(() => undefined); // did-fail-load shows the retry page
  };
  const showConnectPage = async (win: BrowserWindow): Promise<void> => {
    origin = null;
    rebuildMenu();
    await win.loadFile(connectPage);
  };
  /** Remembers the target's origin as current and loads the target. */
  const switchTo = async (win: BrowserWindow, target: SuplexTarget): Promise<void> => {
    if (!probe) registry = await rememberTarget(targetFile(), target);
    origin = target.origin;
    rebuildMenu();
    await load(win, target);
  };
  const forgetCurrent = async (): Promise<void> => {
    if (origin) registry = await forgetTarget(targetFile(), origin);
    state = { name: "choosing" }; // back to the first screen, where you can run Suplex here or add another
    await enter();
    rebuildMenu();
  };
  const showPage = async (win: BrowserWindow, page: string): Promise<void> => {
    origin = null;
    await win.loadFile(join(__dirname, "pages", page));
  };
  const tail = async (file: string): Promise<string[]> =>
    (await readFile(file, "utf8").catch(() => "")).split("\n").filter((line) => line.trim() !== "").slice(-200);
  const snapshot = (): DesktopSnapshot => ({
    state: state.name,
    stages: progress.stages,
    finished: progress.finished,
    current: progress.current,
    log: progress.log,
    failure: state.name === "failed" ? state.failure : null,
  });
  const go = (event: BootEvent): void => {
    const previous = state;
    state = next(state, event);
    if (state !== previous) void enter();
  };
  const emit = (event: InstallEvent): void => {
    if (event.name === "stages") progress.stages = event.stages;
    if (event.name === "stage-started") progress.current = event.stage;
    if (event.name === "stage-finished") { progress.finished.push({ stage: event.stage, skipped: event.skipped, elapsedMs: event.elapsedMs }); progress.current = null; }
    if (event.name === "log") { progress.log.push(event.line); if (progress.log.length > 500) progress.log.splice(0, progress.log.length - 500); }
    if (event.name === "failed") go({ name: "failed", failure: { from: "installing", title: event.title, reason: event.reason, remedy: event.remedy, stage: event.stage, log: [...progress.log] } });
    if (window && !window.isDestroyed()) window.webContents.send("suplex:event", event);
  };
  const runInstall = async (from: string | null): Promise<void> => {
    progress.stages = [];
    progress.finished = [];
    progress.current = null;
    progress.log = [];
    const record = await readInstallRecord(installFile());
    installer = createInstaller({ runtime, userData: app.getPath("userData"), base: input.environment, port: record?.port ?? defaultPort });
    const outcome = await installer.run(from, emit);
    if (outcome === "cancelled") { state = { name: "choosing" }; await enter(); return; }
    if (outcome !== "complete") return;
    await writeInstallRecord(installFile(), { completedAt: new Date().toISOString(), runtimeStamp: (await runtimeStamp(runtime.directory)) ?? "", port: record?.port ?? defaultPort });
    go({ name: "installed" });
  };
  const startLocal = async (): Promise<void> => {
    const record = await readInstallRecord(installFile());
    const port = record?.port ?? defaultPort;
    server = createLocalRuntime({ runtime, userData: app.getPath("userData"), port, base: input.environment });
    try {
      const started = await server.start();
      adopted = started.adopted;
      if (record && started.port !== record.port) await writeInstallRecord(installFile(), { ...record, port: started.port });
      go({ name: "connected", url: `http://127.0.0.1:${started.port}/` });
    } catch (error) {
      go({ name: "failed", failure: { from: "starting", title: "Start Suplex on this Mac", reason: (error as Error).message, remedy: "Open the logs for the server's own words, then retry.", stage: null, log: await tail(join(logsDirectory(), "server.log")) } });
    }
  };
  const connectRemote = async (win: BrowserWindow, value: string, report: boolean): Promise<void> => {
    let target: SuplexTarget;
    try {
      target = parseSuplexTarget(value);
    } catch (error) {
      if (report) fail((error as Error).message);
      else await showConnectPage(win);
      return;
    }
    localOrigin = null;
    await switchTo(win, target);
    state = { name: "connected", url: target.url };
  };
  /** Performs the state it was given; every page load in the boot sequence happens here. */
  const enter = async (): Promise<void> => {
    const win = window;
    if (!win || win.isDestroyed()) return;
    switch (state.name) {
      case "bootstrap-needed":
        await showPage(win, "choice.html");
        state = next(state, { name: "shown" });
        return;
      case "choosing":
        await showPage(win, "choice.html");
        return;
      case "installing": {
        const from = state.from;
        await showPage(win, "install.html");
        void runInstall(from);
        return;
      }
      case "ready":
        await showPage(win, "ready.html");
        return;
      case "starting":
        await showPage(win, "connecting.html");
        void startLocal();
        return;
      case "connecting-remote": {
        const url = state.url;
        if (url === null) await showConnectPage(win); else await connectRemote(win, url, false);
        return;
      }
      case "connected": {
        localOrigin = new URL(state.url).origin;
        rebuildMenu();
        await load(win, parseSuplexTarget(state.url));
        return;
      }
      case "failed":
        await showPage(win, "failed.html");
        return;
      default:
        return;
    }
  };
  const rebuildMenu = (): void => {
    const targets: Electron.MenuItemConstructorOptions[] = registry.targets.map((target) => ({
      label: new URL(target.origin).host,
      type: "radio",
      checked: target.origin === origin,
      click: () => { if (window) void switchTo(window, target); },
    }));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "Suplex", submenu: [{ role: "about" }, { type: "separator" },
        { label: "Settings", submenu: [
          ...targets,
          ...(targets.length > 0 ? [{ type: "separator" as const }] : []),
          { label: "Add a Suplex URL", click: () => { if (window) void showConnectPage(window); } },
          { label: "Forget this Suplex", enabled: origin !== null && origin !== localOrigin, click: () => { void forgetCurrent(); } },
        ] },
        { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, desktopUpdater.menuItem(), { type: "separator" }, { role: "quit" }] },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
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
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, preload: join(__dirname, "preload.js") },
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
        void connectRemote(win, submitted, true);
        return;
      }
      const decision = classifyNavigation(url, origin);
      if (decision.kind === "internal") return;
      event.preventDefault();
      if (decision.kind === "external") void shell.openExternal(decision.url);
    };
    win.webContents.on("will-navigate", guard);
    win.webContents.on("will-redirect", guard);
    // A Suplex page draws nothing until its scripts finish loading, which is slow for a dev stack over the tailnet.
    // Keep CONNECTING over it from commit to the load event.
    let cover: Promise<string> | null = null;
    win.webContents.on("did-navigate", (_event, url) => {
      cover = url.startsWith("http:") || url.startsWith("https:") ? win.webContents.insertCSS(CONNECTING_COVER) : null;
    });
    win.webContents.on("did-finish-load", () => {
      const inserted = cover;
      cover = null;
      if (inserted) void inserted.then((key) => win.webContents.removeInsertedCSS(key)).catch(() => undefined);
    });
    win.webContents.on("did-fail-load", (_event, _code, description, validatedUrl, mainFrame) => {
      if (!mainFrame || !origin || validatedUrl.startsWith("data:") || validatedUrl.startsWith("file:")) return;
      if (origin === localOrigin) {
        void tail(join(logsDirectory(), "server.log")).then((log) => {
          go({ name: "failed", failure: { from: "starting", title: "Start Suplex on this Mac", reason: `Suplex on this Mac stopped answering (${description}).`, remedy: "Retry starts it again.", stage: null, log } });
        });
        return;
      }
      void win.loadURL(retryPage(origin));
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
    let resolved: ReturnType<typeof resolveSuplexTarget>;
    try {
      registry = await readTargets(targetFile());
      resolved = resolveSuplexTarget({ argv: input.argv, environment: input.environment, persisted: null });
    } catch (error) {
      fail((error as Error).message);
      app.exit(1);
      return;
    }
    const win = await createWindow();
    if (resolved) {
      await switchTo(win, resolved.target);
      state = { name: "connected", url: resolved.target.url };
    } else if (probe) {
      await showConnectPage(win);
    } else {
      state = resolveBoot({ record: await readInstallRecord(installFile()), stamp: await runtimeStamp(runtime.directory), remote: registry.current?.url ?? null });
      await enter();
    }
    if (probe) await runProbe(win);
  };
  /** A second launch (for example `open -a Suplex --args --url …`) may carry a target; otherwise it just focuses the window. */
  const openWith = async (argv: readonly string[]): Promise<void> => {
    let requested: SuplexTarget | null;
    try {
      requested = resolveSuplexTarget({ argv, environment: {}, persisted: null })?.target ?? null;
    } catch (error) {
      warn((error as Error).message);
      return;
    }
    await open();
    if (requested && window) await switchTo(window, requested);
  };

  ipcMain.removeHandler("suplex:desktop");
  ipcMain.handle("suplex:desktop", async (event: Electron.IpcMainInvokeEvent, message: DesktopMessage): Promise<unknown> => {
    if (event.senderFrame?.url.startsWith("file:") !== true) return null; // only this app's own pages drive the boot sequence
    switch (message.action) {
      case "snapshot": return snapshot();
      case "choose": go({ name: "choose", mode: message.mode }); return null;
      case "cancel": installer?.cancel(); return null;
      case "retry": go({ name: "retry" }); return null;
      case "launch": go({ name: "launch" }); return null;
      case "back": go({ name: "back" }); return null;
      case "open-logs": await shell.openPath(logsDirectory()); return null;
      case "copy-output": {
        const failure = state.name === "failed" ? state.failure : null;
        clipboard.writeText(failure ? [failure.title, failure.reason, failure.remedy ?? "", ...failure.log].join("\n") : progress.log.join("\n"));
        return null;
      }
      case "test-connection": {
        let target: SuplexTarget;
        try {
          target = parseSuplexTarget(message.url);
        } catch (error) {
          return { ok: false, reason: (error as Error).message };
        }
        return (await healthy(target.origin)) ? { ok: true, reason: null } : { ok: false, reason: `No Suplex answered at ${target.origin}/health.` };
      }
      case "tailscale-status": return tailscaleStatus();
      case "turn-on-tailscale": return turnOnTailscale();
      case "open-tailscale": await openTailscale(); return null;
      default: return null;
    }
  });
  ipcMain.removeHandler("suplex:account-cleared");
  ipcMain.handle("suplex:account-cleared", async (event: Electron.IpcMainInvokeEvent): Promise<void> => {
    const url = event.senderFrame?.url;
    if (!url || origin === null || new URL(url).origin !== origin) return; // only the loaded Suplex, never a frame it embeds
    // This Mac's Suplex was cleared, so the next launch starts at the choice screen. A remote Suplex leaves the local install alone.
    if (origin === localOrigin) await rm(installFile(), { force: true });
    app.quit();
  });
  app.on("before-quit", (event) => {
    if (quitting || server === undefined || adopted) return; // an adopted server outlives this window
    quitting = true;
    event.preventDefault();
    void server.stop().finally(() => { app.quit(); });
  });
  app.on("second-instance", (_event, argv) => { void openWith(argv); });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("activate", () => { void open(); });
  app.setAboutPanelOptions({ applicationName: "Suplex", applicationVersion: app.getVersion() });
  await app.whenReady();
  // Packaged builds get build/icon.png via electron-builder; `pnpm dev` would otherwise show the stock Electron icon.
  if (!app.isPackaged) app.dock?.setIcon(join(__dirname, "../../build/icon.png"));
  app.configureWebAuthn({ touchID: { keychainAccessGroup: KEYCHAIN_ACCESS_GROUP, promptReason: "verify your identity on $1" } });
  rebuildMenu();
  // Electron has no download bar, so save without a dialog and reveal the file as confirmation.
  session.defaultSession.on("will-download", (_event, item) => {
    item.setSavePath(join(app.getPath(process.platform === "darwin" ? "desktop" : "downloads"), item.getFilename()));
    item.once("done", (_doneEvent, state) => { if (state === "completed") shell.showItemInFolder(item.getSavePath()); });
  });
  void desktopUpdater.check(false);
  setInterval(() => { void desktopUpdater.check(false); }, UPDATE_CHECK_INTERVAL_MS); // an app left open still sees new releases
  await open();
}
