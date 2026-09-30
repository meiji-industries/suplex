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
  runtimeStamp,
  writeInstallRecord,
  type BootFailure,
  type BootState,
} from "../src/boot";

const FIXTURE = join(__dirname, "fixtures", "runtime");
const userData = (): string => mkdtempSync(join(tmpdir(), "suplex-desktop-boot-"));
const record = { completedAt: "2026-09-16T00:00:00.000Z", runtimeStamp: "0.0.0-fixture", port: DEFAULT_PORT };
const failure = (from: "installing" | "starting", stage: string | null): BootFailure =>
  ({ from, title: "Install Herdr terminals", reason: "curl exited 22", remedy: "Check the network connection and retry.", stage, log: ["herdr: checking"] });

describe("resolve", () => {
  test("a matching install record starts the local server, ahead of any remembered remote", () => {
    expect(resolveBoot({ record, stamp: "0.0.0-fixture", remote: "https://suplex.tail1234.ts.net/" })).toEqual({ name: "starting" });
  });
  test("a new runtime reruns install automatically; a missing stamp still starts the installed binary", () => {
    expect(resolveBoot({ record, stamp: "1.0.0", remote: "https://suplex.tail1234.ts.net/" })).toEqual({ name: "installing", from: null });
    expect(resolveBoot({ record, stamp: null, remote: null })).toEqual({ name: "starting" });
    expect(resolveBoot({ record: null, stamp: "0.0.0-fixture", remote: null })).toEqual({ name: "bootstrap-needed" });
    expect(resolveBoot({ record: null, stamp: null, remote: "https://suplex.tail1234.ts.net/" })).toEqual({ name: "connecting-remote", url: "https://suplex.tail1234.ts.net/" });
  });
});

describe("transitions", () => {
  test("the local path runs choice, install, ready, start, connected", () => {
    let state: BootState = { name: "bootstrap-needed" };
    state = next(state, { name: "shown" });
    expect(state).toEqual({ name: "choosing" });
    state = next(state, { name: "choose", mode: "local" });
    expect(state).toEqual({ name: "installing", from: null });
    state = next(state, { name: "installed", upgrade: false });
    expect(state).toEqual({ name: "ready" });
    state = next(state, { name: "launch" });
    expect(state).toEqual({ name: "starting" });
    state = next(state, { name: "connected", url: "http://127.0.0.1:4111/" });
    expect(state).toEqual({ name: "connected", url: "http://127.0.0.1:4111/" });
  });
  test("an upgrade starts the server after its install stages, without the welcome", () => {
    const upgrading = resolveBoot({ record, stamp: "1.0.0", remote: null });
    expect(next(upgrading, { name: "installed", upgrade: true })).toEqual({ name: "starting" });
    const retried = next(next(upgrading, { name: "failed", failure: failure("installing", "herdr") }), { name: "retry" });
    expect(next(retried, { name: "installed", upgrade: true })).toEqual({ name: "starting" });
  });
  test("the remote path opens the form and comes back to the choice screen", () => {
    const remote = next({ name: "choosing" }, { name: "choose", mode: "remote" });
    expect(remote).toEqual({ name: "connecting-remote", url: null });
    expect(next(remote, { name: "back" })).toEqual({ name: "choosing" });
    expect(next(remote, { name: "connected", url: "https://suplex.tail1234.ts.net/" })).toEqual({ name: "connected", url: "https://suplex.tail1234.ts.net/" });
  });
  test("failure is latched until a retry, which reruns from the failed stage", () => {
    const failed = next({ name: "installing", from: null }, { name: "failed", failure: failure("installing", "herdr") });
    expect(failed).toEqual({ name: "failed", failure: failure("installing", "herdr") });
    for (const event of [{ name: "shown" }, { name: "launch" }, { name: "installed", upgrade: false }, { name: "back" }, { name: "choose", mode: "local" }] as const) {
      expect(next(failed, event), event.name).toBe(failed);
    }
    expect(next(failed, { name: "retry" })).toEqual({ name: "installing", from: "herdr" });
    expect(next(next({ name: "starting" }, { name: "failed", failure: failure("starting", null) }), { name: "retry" })).toEqual({ name: "starting" });
  });
  test("events that do not belong to the current state change nothing", () => {
    expect(next({ name: "choosing" }, { name: "launch" })).toEqual({ name: "choosing" });
    expect(next({ name: "ready" }, { name: "installed", upgrade: false })).toEqual({ name: "ready" });
    expect(next({ name: "starting" }, { name: "shown" })).toEqual({ name: "starting" });
  });
});

describe("runtime location", () => {
  test("the native binary is under the bundle's resources", () => {
    expect(runtimePaths({}, "/r")).toEqual({ binary: "/r/runtime/bin/suplex", directory: "/r/runtime" });
  });
  test("the environment points dev at a Rust build and manifest", () => {
    expect(runtimePaths({ SUPLEX_DESKTOP_BINARY: "/checkout/rust/target/debug/suplex", SUPLEX_DESKTOP_RUNTIME: "/checkout/desktop/runtime" }, "/r")).toEqual({ binary: "/checkout/rust/target/debug/suplex", directory: "/checkout/desktop/runtime" });
  });
  test("the stamp is the packaged runtime's version, and absent when there is no runtime", async () => {
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

test("the local runtime environment is C2's, with the PATH exactly as written", () => {
  expect(runtimeEnvironment({ userData: "/data/Suplex", port: 4222, base: { HOME: "/Users/ada", USER: "ada", TMPDIR: "/tmp/x" }, access: { kind: "local" } })).toEqual({
    SUPLEX_PACKAGED: "1",
    SUPLEX_ACCESS_MODE: "local",
    SUPLEX_BIND_ADDRESS: "127.0.0.1",
    SUPLEX_PORT: "4222",
    SUPLEX_DATA_ROOT: "/data/Suplex/data",
    SUPLEX_ENV_FILE: "/data/Suplex/suplex.env",
    SUPLEX_REPOSITORY_ROOT: "/Users/ada/suplex/repos",
    SUPLEX_WORKTREE_ROOT: "/Users/ada/suplex/worktrees",
    HOME: "/Users/ada",
    USER: "ada",
    TMPDIR: "/tmp/x",
    PATH: "/Users/ada/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  });
});

test("the Tailscale runtime keeps loopback binding and receives the fresh hostname and executable", () => {
  expect(runtimeEnvironment({ userData: "/data/Suplex", port: 4333, base: { HOME: "/Users/ada" }, access: { kind: "tailscale", hostname: "mac.example.ts.net", command: "/Applications/Tailscale.app/Contents/MacOS/Tailscale" } })).toMatchObject({
    SUPLEX_ACCESS_MODE: "tailscale",
    SUPLEX_BIND_ADDRESS: "127.0.0.1",
    SUPLEX_PORT: "4333",
    SUPLEX_TAILSCALE_EXPOSURE: "serve",
    SUPLEX_TAILSCALE_ADDRESS: "mac.example.ts.net",
    SUPLEX_TAILSCALE_COMMAND: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  });
});
