import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createNetworkAccessController, NetworkAccessCleanupError, readNetworkAccess, writeNetworkAccess, type NetworkAccessPorts, type ResolvedNetworkAccess } from "../src/network-access";

const root = (): string => mkdtempSync(join(tmpdir(), "suplex-network-access-"));
const local: ResolvedNetworkAccess = { kind: "local" };
const all: ResolvedNetworkAccess = { kind: "all" };
const tailscale = (hostname = "mac.one.ts.net"): ResolvedNetworkAccess => ({ kind: "tailscale", hostname, command: "/tailscale" });

test("missing, corrupt, and unknown preferences default to local, and valid preferences round trip", async () => {
  const file = join(root(), "network-access.json");
  expect(await readNetworkAccess(file)).toBe("local");
  writeFileSync(file, "null");
  expect(await readNetworkAccess(file)).toBe("local");
  writeFileSync(file, "{broken");
  expect(await readNetworkAccess(file)).toBe("local");
  await writeNetworkAccess(file, "tailscale");
  expect(await readNetworkAccess(file)).toBe("tailscale");
  expect(readFileSync(file, "utf8")).toBe('"tailscale"');
});

const setup = (input: {
  readonly file?: string;
  readonly adopted?: boolean;
  readonly resolve?: NetworkAccessPorts["resolve"];
  readonly removeServeRoute?: NetworkAccessPorts["removeServeRoute"];
  readonly start?: NetworkAccessPorts["start"];
  readonly stop?: NetworkAccessPorts["stop"];
} = {}) => {
  const operations: string[] = [];
  const file = input.file ?? join(root(), "network-access.json");
  const resolve = input.resolve ?? (async (preference) => preference === "local" ? local : preference === "all" ? all : tailscale());
  const start = input.start ?? (async (access) => { operations.push(`start:${access.kind}`); return { port: 4111, adopted: input.adopted ?? false }; });
  const stop = input.stop ?? (async () => { operations.push("stop"); });
  const removeServeRoute = input.removeServeRoute ?? (async () => { operations.push("remove-route"); });
  const controller = createNetworkAccessController({ file, ports: { resolve, start, stop, removeServeRoute } });
  return { controller, file, operations };
};

test("saving a preference persists pending intent without touching the runtime", async () => {
  const resolve = vi.fn(async (preference: "local" | "tailscale" | "all") => preference === "local" ? local : preference === "all" ? all : tailscale());
  const start = vi.fn(async () => ({ port: 4111, adopted: false }));
  const stop = vi.fn(async () => undefined);
  const removeServeRoute = vi.fn(async () => undefined);
  const { controller, file } = setup({ resolve, start, stop, removeServeRoute });
  await controller.startPreferred();
  resolve.mockClear();
  start.mockClear();

  await controller.savePreference("tailscale");

  expect(await readNetworkAccess(file)).toBe("tailscale");
  expect(controller.state()).toMatchObject({ preference: "tailscale", active: { kind: "owned", access: local } });
  expect(resolve).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(stop).not.toHaveBeenCalled();
  expect(removeServeRoute).not.toHaveBeenCalled();
});

test("saving the active mode cancels a pending restart", async () => {
  const { controller, file, operations } = setup();
  await controller.startPreferred();
  await controller.savePreference("tailscale");
  await controller.savePreference("local");
  expect(controller.state()).toMatchObject({ preference: "local", active: { kind: "owned", access: local } });
  expect(await readNetworkAccess(file)).toBe("local");
  expect(operations).toEqual(["start:local"]);
});

test("apply uses only the latest saved preference", async () => {
  const resolve = vi.fn(async (preference: "local" | "tailscale" | "all") => preference === "local" ? local : preference === "all" ? all : tailscale());
  const { controller, file, operations } = setup({ resolve });
  await controller.startPreferred();
  await controller.savePreference("tailscale");
  await controller.savePreference("all");

  await expect(controller.applyPreference()).resolves.toMatchObject({ kind: "owned", access: all });

  expect(resolve).toHaveBeenCalledTimes(2);
  expect(resolve).toHaveBeenLastCalledWith("all");
  expect(operations).toEqual(["start:local", "stop", "start:all"]);
  expect(await readNetworkAccess(file)).toBe("all");
});

test("a failed resolution retains the running host and pending preference", async () => {
  const resolutions: string[] = [];
  const { controller, file, operations } = setup({ resolve: async (preference) => {
    resolutions.push(`resolve:${preference}`);
    if (preference === "tailscale") throw new Error("not connected");
    return local;
  } });
  await controller.startPreferred();
  await controller.savePreference("tailscale");
  await expect(controller.applyPreference()).rejects.toThrow("not connected");
  expect(resolutions).toEqual(["resolve:local", "resolve:tailscale"]);
  expect(operations).toEqual(["start:local"]);
  expect(controller.state()).toMatchObject({ preference: "tailscale", active: { kind: "owned", access: local } });
  expect(await readNetworkAccess(file)).toBe("tailscale");
});

test("a failed start restores the previous mode and retains pending preference", async () => {
  const operations: string[] = [];
  const { controller, file } = setup({
    start: async (access) => {
      operations.push(`start:${access.kind}`);
      if (access.kind === "all") throw new Error("all failed");
      return { port: 4111, adopted: false };
    },
    stop: async () => { operations.push("stop"); },
  });
  await controller.startPreferred();
  await controller.savePreference("all");

  await expect(controller.applyPreference()).rejects.toThrow("all failed");

  expect(operations).toEqual(["start:local", "stop", "start:all", "start:local"]);
  expect(controller.state()).toMatchObject({ preference: "all", active: { kind: "owned", access: local } });
  expect(await readNetworkAccess(file)).toBe("all");
});

test("a cleanup failure leaves the host stopped with Tailscale recovery intent instead of starting local behind a stale route", async () => {
  const file = join(root(), "network-access.json");
  await writeNetworkAccess(file, "tailscale");
  let hostname = "mac.one.ts.net";
  const cleanup: string[] = [];
  const { controller, operations } = setup({
    file,
    resolve: async (preference) => preference === "local" ? local : tailscale(hostname),
    removeServeRoute: async () => { cleanup.push("remove-route"); throw new Error("route remains"); },
  });
  await controller.startPreferred();
  hostname = "mac.two.ts.net";
  await controller.savePreference("local");
  await expect(controller.applyPreference()).rejects.toThrow("route remains");
  expect(operations).toEqual(["start:tailscale", "stop"]);
  expect(cleanup).toEqual(["remove-route"]);
  expect(controller.state().active).toBeNull();
  expect(await readNetworkAccess(file)).toBe("local");
});

test("a preference write failure leaves the old host running", async () => {
  const directory = root();
  const file = join(directory, "network-access.json");
  mkdirSync(file);
  const { controller, operations } = setup({ file });
  await controller.startPreferred();
  await expect(controller.savePreference("tailscale")).rejects.toThrow();
  expect(operations).toEqual(["start:local"]);
  expect(controller.state().active).toMatchObject({ kind: "owned", access: local });
});

test("a failed Tailscale start with unresolved cleanup never restores local, and retry observes cleanup before starting", async () => {
  const file = join(root(), "network-access.json");
  const operations: string[] = [];
  let tailscaleStarts = 0;
  const removeServeRoute = vi.fn(async () => undefined);
  const controller = createNetworkAccessController({
    file,
    ports: {
      resolve: async (preference) => preference === "local" ? local : tailscale(),
      start: async (access) => {
        operations.push(`start:${access.kind}`);
        if (access.kind === "tailscale" && tailscaleStarts++ === 0) {
          throw new NetworkAccessCleanupError("cleanup unresolved", access, 4222);
        }
        return { port: access.kind === "local" ? 4111 : 4222, adopted: false };
      },
      stop: async () => { operations.push("stop"); },
      removeServeRoute,
    },
  });
  await controller.startPreferred();
  await controller.savePreference("tailscale");
  await expect(controller.applyPreference()).rejects.toThrow("cleanup unresolved");
  expect(controller.state().active).toBeNull();
  expect(operations).toEqual(["start:local", "stop", "start:tailscale"]);
  expect(await readNetworkAccess(file)).toBe("tailscale");

  await controller.startPreferred();
  expect(removeServeRoute).toHaveBeenCalledWith(tailscale(), 4222);
  expect(controller.state().active).toMatchObject({ kind: "owned", access: tailscale(), port: 4222 });
  expect(operations).toEqual(["start:local", "stop", "start:tailscale", "start:tailscale"]);
});

test("a later local selection saves pending intent without touching unresolved cleanup", async () => {
  const file = join(root(), "network-access.json");
  const removeServeRoute = vi.fn(async () => undefined);
  let tailscaleStarts = 0;
  const controller = createNetworkAccessController({
    file,
    ports: {
      resolve: async (preference) => preference === "local" ? local : tailscale(),
      start: async (access) => {
        if (access.kind === "tailscale" && tailscaleStarts++ === 0) throw new NetworkAccessCleanupError("cleanup unresolved", access, 4222);
        return { port: 4111, adopted: false };
      },
      stop: async () => undefined,
      removeServeRoute,
    },
  });
  await controller.startPreferred();
  await controller.savePreference("tailscale");
  await expect(controller.applyPreference()).rejects.toThrow();
  await controller.savePreference("local");
  expect(removeServeRoute).not.toHaveBeenCalled();
  expect(await readNetworkAccess(file)).toBe("local");
  await controller.startPreferred();
  expect(removeServeRoute).toHaveBeenCalledWith(tailscale(), 4222);
});

test("a recreated controller recovers the live route before local selection and startup", async () => {
  const directory = root();
  const file = join(directory, "network-access.json");
  const first = createNetworkAccessController({
    file,
    ports: {
      resolve: async (preference) => preference === "local" ? local : tailscale("old-name.ts.net"),
      start: async (access) => {
        if (access.kind === "tailscale") throw new NetworkAccessCleanupError("cleanup unresolved", access, 4333);
        return { port: 4111, adopted: false };
      },
      stop: async () => undefined,
      removeServeRoute: async () => undefined,
    },
  });
  await first.startPreferred();
  await first.savePreference("tailscale");
  await expect(first.applyPreference()).rejects.toThrow("cleanup unresolved");
  expect(readFileSync(join(directory, "network-access-cleanup.json"), "utf8")).toBe('{"port":4333}');

  const observed: string[] = [];
  const second = createNetworkAccessController({
    file,
    ports: {
      resolve: async (preference) => preference === "local" ? local : tailscale("new-name.ts.net"),
      start: async (access) => { observed.push(`start:${access.kind}`); return { port: 4111, adopted: false }; },
      stop: async () => undefined,
      removeServeRoute: async (access, port) => { observed.push(`cleanup:${access.hostname}:${port}`); },
    },
  });
  await second.savePreference("local");
  expect(observed).toEqual([]);
  expect(await second.startPreferred()).toMatchObject({ kind: "owned", access: local, port: 4111 });
  expect(observed).toEqual(["cleanup:new-name.ts.net:4333", "start:local"]);
});

test("shutdown cleanup can fail and retry from authoritative Serve state while the host stays stopped", async () => {
  const file = join(root(), "network-access.json");
  await writeNetworkAccess(file, "tailscale");
  const removeServeRoute = vi.fn()
    .mockRejectedValueOnce(new Error("status unavailable"))
    .mockResolvedValueOnce(undefined);
  const { controller, operations } = setup({ file, removeServeRoute });
  await controller.startPreferred();
  await expect(controller.shutdown()).rejects.toThrow("status unavailable");
  expect(controller.state().active).toBeNull();
  await controller.shutdown();
  expect(removeServeRoute).toHaveBeenCalledTimes(2);
  expect(operations).toEqual(["start:tailscale", "stop"]);
});

test("an adopted host stays untouched and does not claim an active access mode", async () => {
  const { controller, operations, file } = setup({ adopted: true });
  expect(await controller.startPreferred()).toEqual({ kind: "adopted", port: 4111 });
  await controller.savePreference("tailscale");
  await expect(controller.applyPreference()).rejects.toThrow("does not own");
  expect(operations).toEqual(["start:local"]);
  expect(await readNetworkAccess(file)).toBe("tailscale");
  expect(controller.state().active).toEqual({ kind: "adopted", port: 4111 });
});

test("shutdown waits behind an in-progress apply and then stops the resulting owned host", async () => {
  let release: (() => void) | undefined;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const start = vi.fn(async (access: ResolvedNetworkAccess) => {
    if (access.kind === "tailscale") await delayed;
    return { port: 4111, adopted: false };
  });
  const stop = vi.fn(async () => undefined);
  const { controller } = setup({ start, stop });
  await controller.startPreferred();
  await controller.savePreference("tailscale");
  const changing = controller.applyPreference();
  const shutdown = controller.shutdown();
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  release?.();
  await changing;
  await shutdown;
  expect(stop).toHaveBeenCalledTimes(2);
  expect(controller.state().active).toBeNull();
});
