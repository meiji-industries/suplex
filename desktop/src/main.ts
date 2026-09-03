import { app, BrowserWindow, Menu, shell, screen } from "electron";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

type Bounds = { width: number; height: number; x?: number; y?: number };
let window: BrowserWindow | undefined;
let configuredUrl: string | null = null;
const dataFile = (): string => join(app.getPath("userData"), "desktop.json");
const stateFile = (): string => join(app.getPath("userData"), "window-state.json");
const readJson = async <T,>(file: string): Promise<T | undefined> => { try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return undefined; } };
const save = async (file: string, data: unknown): Promise<void> => { await writeFile(file, JSON.stringify(data)); };
const validUrl = (value: string): string | null => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.toString() : null; } catch { return null; } };
const sameOrigin = (value: string): boolean => { try { return Boolean(configuredUrl) && new URL(value).origin === new URL(configuredUrl!).origin; } catch { return false; } };
const bounds = async (): Promise<Bounds> => {
  const saved = await readJson<Bounds>(stateFile());
  const area = screen.getPrimaryDisplay().workArea;
  return { width: Math.max(900, Math.min(saved?.width ?? 1200, area.width)), height: Math.max(600, Math.min(saved?.height ?? 800, area.height)), ...(saved?.x !== undefined ? { x: Math.max(area.x, Math.min(saved.x, area.x + area.width - 100)) } : {}), ...(saved?.y !== undefined ? { y: Math.max(area.y, Math.min(saved.y, area.y + area.height - 100)) } : {}) };
};
const persistBounds = (): void => { if (window) void save(stateFile(), window.getBounds()); };
const retryPage = (): string => `data:text/html,${encodeURIComponent("<h1>Cannot reach Forge</h1><p><a href='#' onclick='location.reload()'>Retry</a></p>")}`;

async function createWindow(): Promise<void> {
  configuredUrl = process.env.FORGE_DESKTOP_URL ?? (await readJson<{ url?: string }>(dataFile()))?.url ?? null;
  const win = window = new BrowserWindow({ ...(await bounds()), minWidth: 900, minHeight: 600, backgroundColor: "#0a0a0a", webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  let debounce: NodeJS.Timeout | undefined;
  const later = (): void => { if (debounce) clearTimeout(debounce); debounce = setTimeout(persistBounds, 300); };
  win.on("resize", later); win.on("move", later); win.on("close", persistBounds);
  win.webContents.setWindowOpenHandler(({ url }) => { if (!sameOrigin(url)) void shell.openExternal(url); return { action: sameOrigin(url) ? "allow" : "deny" }; });
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("forge-desktop:")) { event.preventDefault(); const target = validUrl(new URL(url).searchParams.get("url") ?? ""); if (target) { configuredUrl = target; void save(dataFile(), { url: target }).then(() => win.loadURL(target)); } return; }
    if (!sameOrigin(url)) { event.preventDefault(); void shell.openExternal(url); }
  });
  win.webContents.on("page-title-updated", (_event, title) => app.dock?.setBadge(/^\((\d+)\)/.exec(title)?.[1] ?? ""));
  win.webContents.on("did-fail-load", (_event, _code, _description, validatedUrl, mainFrame) => { if (mainFrame && !validatedUrl.startsWith("data:")) void win.loadURL(retryPage()); });
  if (configuredUrl) await win.loadURL(configuredUrl); else await win.loadFile(join(__dirname, "connect.html"));
  if (process.env.FORGE_DESKTOP_SPIKE === "1") { const result = await win.webContents.executeJavaScript("Promise.all([Boolean(navigator.credentials), PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()])"); console.log("FORGE_DESKTOP_SPIKE", JSON.stringify(result)); app.quit(); }
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!window) void createWindow(); });
app.setAboutPanelOptions({ applicationName: "Forge", applicationVersion: app.getVersion() });
app.whenReady().then(async () => {
  app.configureWebAuthn({ touchID: { keychainAccessGroup: "dev.forge.desktop.webauthn", promptReason: "verify your identity on $1" } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }, { label: "Navigate", submenu: [{ label: "Back", accelerator: "CmdOrCtrl+[", click: () => window?.webContents.goBack() }, { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => window?.webContents.goForward() }, { label: "Change Forge URL…", click: () => { void unlink(dataFile()).catch(() => undefined).then(() => window?.loadFile(join(__dirname, "connect.html"))); } }] } ]));
  await createWindow();
});
