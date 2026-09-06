import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const sourceDirectory = join(__dirname, "..", "src");
const sources = readdirSync(sourceDirectory).filter((name) => name.endsWith(".ts"));

test("desktop source never reaches the server, the engine, the database, or child processes", () => {
  const forbidden = /child_process|better-sqlite3|better_sqlite3|ELECTRON_RUN_AS_NODE|ipcMain|ipcRenderer|contextBridge|preload|<webview>|from "\.\.\/\.\.\/|\/src\/|drizzle|\.sqlite|process\.kill|\bpid\b/i;
  for (const file of sources) expect(readFileSync(join(sourceDirectory, file), "utf8"), file).not.toMatch(forbidden);
});

test("only the orchestration module imports electron", () => {
  for (const file of sources) {
    const importsElectron = /from "electron"/.test(readFileSync(join(sourceDirectory, file), "utf8"));
    expect(importsElectron, file).toBe(file === "forge-desktop.ts");
  }
});

test("the desktop package bundles no runtime dependencies and the server graph has no Electron", () => {
  const desktop = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { dependencies?: unknown };
  expect(desktop.dependencies).toBeUndefined();
  const root = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  expect(Object.keys({ ...root.dependencies, ...root.devDependencies }).filter((name) => /electron/i.test(name))).toEqual([]);
});
