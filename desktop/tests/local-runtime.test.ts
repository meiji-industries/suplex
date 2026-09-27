import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, expect, test, vi } from "vitest";
import { runtimePaths } from "../src/boot";
import { createLocalRuntime, freePort, type LocalRuntimePorts } from "../src/local-runtime";

const FIXTURE = runtimePaths({}, join(__dirname, "fixtures"));

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
}

let child: FakeChild;
const spawn = vi.fn<LocalRuntimePorts["spawn"]>(() => child as unknown as ReturnType<LocalRuntimePorts["spawn"]>);
const kill = vi.fn();
const wait = vi.fn(async () => undefined);
const healthy = vi.fn(async () => false);

const subject = (ports: Partial<LocalRuntimePorts> = {}, port = 4111): ReturnType<typeof createLocalRuntime> =>
  createLocalRuntime({
    runtime: FIXTURE,
    userData: mkdtempSync(join(tmpdir(), "suplex-desktop-local-")),
    port,
    base: { HOME: "/Users/ada", USER: "ada", TMPDIR: "/tmp/x" },
    ports: { spawn, kill, wait, healthy, freePort: async (preferred) => preferred, ...ports },
  });

beforeEach(() => {
  child = new FakeChild();
  vi.clearAllMocks();
  healthy.mockResolvedValue(false);
});

const installed = (id: string): string => {
  const userData = mkdtempSync(join(tmpdir(), "suplex-desktop-local-"));
  writeFileSync(join(userData, "installation-id"), `${id}\n`);
  return userData;
};

test("a server of this installation already answering on the port is adopted, never spawned and never signalled", async () => {
  const runtime = createLocalRuntime({ runtime: FIXTURE, userData: installed("ours"), port: 4111, base: { HOME: "/Users/ada" }, ports: { spawn, kill, wait, healthy, servedInstallation: async () => "ours", freePort: async (preferred) => preferred } });
  expect(await runtime.start()).toEqual({ port: 4111, adopted: true });
  expect(spawn).not.toHaveBeenCalled();
  await runtime.stop();
  expect(kill).not.toHaveBeenCalled();
});

test("a server of another installation on the port is left alone and ours starts on a free port", async () => {
  const runtime = createLocalRuntime({ runtime: FIXTURE, userData: installed("ours"), port: 4111, base: { HOME: "/Users/ada" }, ports: { spawn, kill, wait, healthy: async (origin: string) => origin === "http://127.0.0.1:4222", servedInstallation: async () => "deleted-folder", freePort: async () => 4222 } });
  expect(await runtime.start()).toEqual({ port: 4222, adopted: false });
  expect(spawn.mock.lastCall?.[2].env.SUPLEX_PORT).toBe("4222");
});

test("the native server is spawned detached with its foreground command, cwd, and environment", async () => {
  healthy.mockResolvedValueOnce(false).mockResolvedValue(true);
  const userData = mkdtempSync(join(tmpdir(), "suplex-desktop-local-"));
  const runtime = createLocalRuntime({ runtime: FIXTURE, userData, port: 4111, base: { HOME: "/Users/ada" }, ports: { spawn, kill, wait, healthy, freePort: async (preferred) => preferred } });
  expect(await runtime.start()).toEqual({ port: 4111, adopted: false });
  expect(spawn).toHaveBeenCalledWith(
    FIXTURE.binary,
    ["start", "--foreground"],
    expect.objectContaining({ cwd: FIXTURE.directory, detached: true, stdio: ["ignore", "pipe", "pipe"] }),
  );
  expect(spawn.mock.lastCall?.[2].env).toMatchObject({ SUPLEX_PACKAGED: "1", SUPLEX_ACCESS_MODE: "local", SUPLEX_BIND_ADDRESS: "127.0.0.1", SUPLEX_PORT: "4111", SUPLEX_DATA_ROOT: join(userData, "data") });
  expect(wait).toHaveBeenCalledWith(500);
  child.stdout.write("listening\n");
  child.stderr.write("a warning\n");
  await vi.waitFor(() => expect(readFileSync(join(userData, "logs", "server.log"), "utf8")).toContain("a warning"));
  expect(readFileSync(join(userData, "logs", "server.log"), "utf8")).toContain("listening");
});

test("a busy port that does not answer health moves the server to a free one", async () => {
  const runtime = subject({ freePort: async () => 4222, healthy: vi.fn(async (origin: string) => origin === "http://127.0.0.1:4222") });
  expect(await runtime.start()).toEqual({ port: 4222, adopted: false });
  expect(spawn.mock.lastCall?.[2].env.SUPLEX_PORT).toBe("4222");
});

test("the preferred port is kept when it is free and given up when it is taken", async () => {
  const taken = createServer();
  await new Promise<void>((resolve) => { taken.listen({ port: 0, host: "127.0.0.1" }, resolve); });
  const address = taken.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  expect(await freePort(port)).not.toBe(port);
  await new Promise<void>((resolve) => { taken.close(() => { resolve(); }); });
  expect(await freePort(port)).toBe(port);
});

test("a server that never answers health fails after 60 seconds and its group is killed", async () => {
  const runtime = subject();
  await expect(runtime.start()).rejects.toThrow(/did not answer http:\/\/127\.0\.0\.1:4111\/health within 60 seconds/);
  expect(wait).toHaveBeenCalledTimes(120);
  expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
});

test("a server that exits while starting reports its exit code", async () => {
  healthy.mockImplementation(async () => { child.emit("exit", 3); return false; });
  await expect(subject().start()).rejects.toThrow(/stopped while starting \(exit 3\)/);
});

test("quitting signals the whole process group and stops waiting once it exits", async () => {
  healthy.mockResolvedValueOnce(false).mockResolvedValue(true);
  const runtime = subject();
  await runtime.start();
  const stopping = runtime.stop();
  child.emit("exit", 0);
  await stopping;
  expect(kill.mock.calls).toEqual([[-4242, "SIGTERM"]]);
});

test("a server that ignores SIGTERM for five seconds is killed", async () => {
  healthy.mockResolvedValueOnce(false).mockResolvedValue(true);
  const runtime = subject();
  await runtime.start();
  await runtime.stop();
  expect(kill.mock.calls).toEqual([[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
  expect(wait).toHaveBeenCalledWith(5_000);
});
