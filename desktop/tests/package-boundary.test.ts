import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const sourceDirectory = join(__dirname, "..", "src");
const sources = readdirSync(sourceDirectory).filter((name) => name.endsWith(".ts"));
const read = (file: string): string => readFileSync(join(sourceDirectory, file), "utf8");

test("desktop source never reaches the server's code, the engine, or the database", () => {
  const forbidden = /better-sqlite3|better_sqlite3|ELECTRON_RUN_AS_NODE|<webview>|from "\.\.\/\.\.\/|drizzle|\.sqlite/i;
  for (const file of sources) expect(read(file), file).not.toMatch(forbidden);
});

test("child processes, the bridge, and the main-process channel each live in one module", () => {
  for (const file of sources) {
    expect(/child_process/.test(read(file)), file).toBe(file === "local-runtime.ts" || file === "installer.ts");
    expect(/contextBridge|ipcRenderer/.test(read(file)), file).toBe(file === "preload.ts");
    expect(/ipcMain/.test(read(file)), file).toBe(file === "suplex-desktop.ts");
  }
});

test("only the orchestration module and the preload import electron", () => {
  for (const file of sources) {
    expect(/from "electron"/.test(read(file)), file).toBe(file === "suplex-desktop.ts" || file === "preload.ts");
  }
});

test("the desktop package owns only its updater runtime dependency and the server graph has no Electron", () => {
  const desktop = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  expect(desktop.dependencies).toEqual({ "electron-updater": "6.8.9" });
  const root = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  expect(Object.keys({ ...root.dependencies, ...root.devDependencies }).filter((name) => /electron/i.test(name))).toEqual([]);
});
