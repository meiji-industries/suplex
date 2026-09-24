import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

const ARCH = process.env.SUPLEX_DESKTOP_ARCH ?? "arm64";
const APP = join(__dirname, "..", "release", ARCH, ARCH === "arm64" ? "mac-arm64" : "mac", "Suplex.app");
const BINARY = join(APP, "Contents", "MacOS", "Suplex");
const SMOKE_URL = process.env.SUPLEX_DESKTOP_SMOKE_URL;

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

describe("packaged Suplex.app", () => {
  beforeAll(() => {
    if (!existsSync(APP)) throw new Error(`Packaged application not found at ${APP}. Run pnpm desktop:dist before pnpm test:packaged.`);
  });
  test("bundles only the desktop app", () => {
    const paths = asarPaths(join(APP, "Contents", "Resources", "app.asar"));
    expect(paths).toEqual(expect.arrayContaining(["dist/src/boot.js", "dist/src/connect.html", "dist/src/desktop-updater.js", "dist/src/suplex-desktop.js", "dist/src/suplex-target.js", "dist/src/installer.js", "dist/src/local-runtime.js", "dist/src/main.js", "dist/src/pages/choice.html", "dist/src/pages/failed.html", "dist/src/pages/install.html", "dist/src/pages/pages.css", "dist/src/pages/ready.html", "dist/src/preload.js", "dist/src/target-store.js", "node_modules/electron-updater/package.json", "package.json"]));
    expect(paths.some((path) => path.startsWith("dist/src/") && /server|database|coordination|runtimes/.test(path))).toBe(false);
    expect(paths.some((path) => path.includes("better-sqlite3"))).toBe(false);
  });
  // The backend ships only in Resources/runtime (see scripts/bundle-runtime.sh); _CodeSignature lists that folder's files by name.
  test("keeps the Suplex backend, database, and better-sqlite3 inside Resources/runtime", () => {
    const result = spawnSync("grep", ["-rl", "--exclude-dir=runtime", "--exclude-dir=_CodeSignature", "-e", "better_sqlite3", "-e", "better-sqlite3", "-e", "suplex.sqlite", join(APP, "Contents")], { encoding: "utf8" });
    expect(result.stdout.trim()).toBe("");
  });
  test.skipIf(SMOKE_URL === undefined)("loads from the exact configured origin", () => {
    const stdout = execFileSync(BINARY, ["--url", SMOKE_URL ?? ""], { env: { ...process.env, SUPLEX_DESKTOP_PROBE: "1" }, encoding: "utf8", timeout: 60_000 });
    const line = stdout.split("\n").find((entry) => entry.startsWith("{"));
    const probe = JSON.parse(line ?? "{}") as { url: string; origin: string; navigatorCredentials: boolean };
    const expected = new URL(SMOKE_URL ?? "");
    expect(probe.origin).toBe(expected.origin);
    expect(probe.url.startsWith(expected.origin)).toBe(true);
    expect(probe.navigatorCredentials).toBe(true);
  });
  test.skipIf(SMOKE_URL === undefined)("fails visibly on an invalid explicit target", () => {
    const result = spawnSync(BINARY, ["--url", "http://suplex.example.com"], { env: { ...process.env, SUPLEX_DESKTOP_PROBE: "1" }, encoding: "utf8", timeout: 60_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--url is not valid/);
  });
});
