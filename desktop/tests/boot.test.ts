import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_PORT,
  next,
  readInstallRecord,
  resolveBoot,
  runtimeEnvironment,
  runtimePaths,
  runtimeRoot,
  runtimeStamp,
  writeInstallRecord,
  type BootFailure,
  type BootState,
} from "../src/boot";

const FIXTURE = join(__dirname, "fixtures", "runtime");
const userData = (): string => mkdtempSync(join(tmpdir(), "forge-desktop-boot-"));
const record = { completedAt: "2026-09-16T00:00:00.000Z", runtimeStamp: "0.0.0-fixture", port: DEFAULT_PORT };
const failure = (from: "installing" | "starting", stage: string | null): BootFailure =>
  ({ from, title: "Install Herdr terminals", reason: "curl exited 22", remedy: "Check the network connection and retry.", stage, log: ["herdr: checking"] });

describe("resolve", () => {
  test("a matching install record starts the local server, ahead of any remembered remote", () => {
    expect(resolveBoot({ record, stamp: "0.0.0-fixture", remote: "https://forge.tail1234.ts.net/" })).toEqual({ name: "starting" });
  });
  test("a runtime that no longer matches the record falls back to the remote, then to the choice screen", () => {
    expect(resolveBoot({ record, stamp: "1.0.0", remote: "https://forge.tail1234.ts.net/" })).toEqual({ name: "connecting-remote", url: "https://forge.tail1234.ts.net/" });
    expect(resolveBoot({ record, stamp: null, remote: null })).toEqual({ name: "bootstrap-needed" });
    expect(resolveBoot({ record: null, stamp: "0.0.0-fixture", remote: null })).toEqual({ name: "bootstrap-needed" });
  });
});

describe("transitions", () => {
  test("the local path runs choice, install, ready, start, connected", () => {
    let state: BootState = { name: "bootstrap-needed" };
    state = next(state, { name: "shown" });
    expect(state).toEqual({ name: "choosing" });
    state = next(state, { name: "choose", mode: "local" });
    expect(state).toEqual({ name: "installing", from: null });
    state = next(state, { name: "installed" });
    expect(state).toEqual({ name: "ready" });
    state = next(state, { name: "launch" });
    expect(state).toEqual({ name: "starting" });
    state = next(state, { name: "connected", url: "http://127.0.0.1:4111/" });
    expect(state).toEqual({ name: "connected", url: "http://127.0.0.1:4111/" });
  });
  test("the remote path opens the form and comes back to the choice screen", () => {
    const remote = next({ name: "choosing" }, { name: "choose", mode: "remote" });
    expect(remote).toEqual({ name: "connecting-remote", url: null });
    expect(next(remote, { name: "back" })).toEqual({ name: "choosing" });
    expect(next(remote, { name: "connected", url: "https://forge.tail1234.ts.net/" })).toEqual({ name: "connected", url: "https://forge.tail1234.ts.net/" });
  });
  test("failure is latched until a retry, which reruns from the failed stage", () => {
    const failed = next({ name: "installing", from: null }, { name: "failed", failure: failure("installing", "herdr") });
    expect(failed).toEqual({ name: "failed", failure: failure("installing", "herdr") });
    for (const event of [{ name: "shown" }, { name: "launch" }, { name: "installed" }, { name: "back" }, { name: "choose", mode: "local" }] as const) {
      expect(next(failed, event), event.name).toBe(failed);
    }
    expect(next(failed, { name: "retry" })).toEqual({ name: "installing", from: "herdr" });
    expect(next(next({ name: "starting" }, { name: "failed", failure: failure("starting", null) }), { name: "retry" })).toEqual({ name: "starting" });
  });
  test("events that do not belong to the current state change nothing", () => {
    expect(next({ name: "choosing" }, { name: "launch" })).toEqual({ name: "choosing" });
    expect(next({ name: "ready" }, { name: "installed" })).toEqual({ name: "ready" });
    expect(next({ name: "starting" }, { name: "shown" })).toEqual({ name: "starting" });
  });
});

describe("runtime location", () => {
  test("the environment override wins over the bundle's resources", () => {
    expect(runtimeRoot({ FORGE_DESKTOP_RUNTIME_ROOT: FIXTURE }, "/Applications/Forge.app/Contents/Resources")).toBe(FIXTURE);
    expect(runtimeRoot({}, "/Applications/Forge.app/Contents/Resources")).toBe("/Applications/Forge.app/Contents/Resources/runtime");
  });
  test("the entry points are C2's", () => {
    expect(runtimePaths("/r")).toEqual({ node: "/r/node/bin/node", app: "/r/app", cli: "/r/app/dist/src/cli.js", supervisor: "/r/app/dist/src/platform/updates/supervisor.js" });
  });
  test("the stamp is the packaged app's version, and absent when there is no runtime", async () => {
    expect(await runtimeStamp(FIXTURE)).toBe("0.0.0-fixture");
    expect(await runtimeStamp(join(FIXTURE, "missing"))).toBeNull();
  });
});

describe("install record", () => {
  test("round trips and rejects anything incomplete", async () => {
    const file = join(userData(), "install.json");
    expect(await readInstallRecord(file)).toBeNull();
    await writeInstallRecord(file, record);
    expect(await readInstallRecord(file)).toEqual(record);
    writeFileSync(file, JSON.stringify({ completedAt: "2026-09-16T00:00:00.000Z" }));
    expect(await readInstallRecord(file)).toBeNull();
    writeFileSync(file, "{corrupt");
    expect(await readInstallRecord(file)).toBeNull();
  });
});

test("the runtime environment is C2's, with the PATH exactly as written", () => {
  expect(runtimeEnvironment({ userData: "/data/Forge", port: 4222, base: { HOME: "/Users/ada", USER: "ada", TMPDIR: "/tmp/x" } })).toEqual({
    FORGE_PACKAGED: "1",
    FORGE_ACCESS_MODE: "local",
    FORGE_BIND_ADDRESS: "127.0.0.1",
    FORGE_PORT: "4222",
    FORGE_DATA_ROOT: "/data/Forge/data",
    FORGE_ENV_FILE: "/data/Forge/forge.env",
    FORGE_REPOSITORY_ROOT: "/Users/ada/forge/repos",
    FORGE_WORKTREE_ROOT: "/Users/ada/forge/worktrees",
    HOME: "/Users/ada",
    USER: "ada",
    TMPDIR: "/tmp/x",
    PATH: "/Users/ada/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  });
});
