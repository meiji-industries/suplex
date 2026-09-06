import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const APP = join(__dirname, "..", "release", "mac-arm64", "Forge.app");
const BINARY = join(APP, "Contents", "MacOS", "Forge");
const SMOKE_URL = process.env.FORGE_DESKTOP_SMOKE_URL;

/** Lists the paths inside an asar archive by reading its JSON header (no dependency). */
function asarPaths(archive: string): string[] {
  const buffer = readFileSync(archive);
  const headerSize = buffer.readUInt32LE(12);
  const header = JSON.parse(buffer.subarray(16, 16 + headerSize).toString("utf8")) as { files: Record<string, unknown> };
  const paths: string[] = [];
  const walk = (files: Record<string, unknown>, prefix: string): void => {
    for (const [name, entry] of Object.entries(files)) {
      const children = (entry as { files?: Record<string, unknown> }).files;
      if (children) walk(children, `${prefix}${name}/`); else paths.push(`${prefix}${name}`);
    }
  };
  walk(header.files, "");
  return paths.sort();
}

describe.skipIf(!existsSync(APP))("packaged Forge.app", () => {
  test("bundles only the desktop shell", () => {
    const paths = asarPaths(join(APP, "Contents", "Resources", "app.asar"));
    expect(paths).toEqual(["dist/src/connect.html", "dist/src/forge-desktop.js", "dist/src/forge-target.js", "dist/src/main.js", "dist/src/target-store.js", "package.json"]);
  });
  test("contains no Forge backend, database, or better-sqlite3 binary", () => {
    const result = spawnSync("grep", ["-rl", "-e", "better_sqlite3", "-e", "better-sqlite3", "-e", "forge.sqlite", join(APP, "Contents")], { encoding: "utf8" });
    expect(result.stdout.trim()).toBe("");
  });
  test.skipIf(SMOKE_URL === undefined)("loads from the exact configured origin", () => {
    const stdout = execFileSync(BINARY, ["--url", SMOKE_URL ?? ""], { env: { ...process.env, FORGE_DESKTOP_PROBE: "1" }, encoding: "utf8", timeout: 60_000 });
    const line = stdout.split("\n").find((entry) => entry.startsWith("{"));
    const probe = JSON.parse(line ?? "{}") as { url: string; origin: string; navigatorCredentials: boolean };
    const expected = new URL(SMOKE_URL ?? "");
    expect(probe.origin).toBe(expected.origin);
    expect(probe.url.startsWith(expected.origin)).toBe(true);
    expect(probe.navigatorCredentials).toBe(true);
  });
  test.skipIf(SMOKE_URL === undefined)("fails visibly on an invalid explicit target", () => {
    const result = spawnSync(BINARY, ["--url", "http://forge.example.com"], { env: { ...process.env, FORGE_DESKTOP_PROBE: "1" }, encoding: "utf8", timeout: 60_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--url is not valid/);
  });
});
