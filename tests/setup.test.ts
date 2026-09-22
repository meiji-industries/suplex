import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

import { isTailscaleDaemonUnavailable, runSetup, upsertSuplexEnvironment } from "../src/platform/setup.js";

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("setup upserts Suplex choices without duplicating or overwriting unrelated settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-setup-test-"));
  const filename = join(root, "suplex.env");
  try {
    await upsertSuplexEnvironment(filename, {
      SUPLEX_TAILSCALE_EXPOSURE: "serve",
      SUPLEX_TAILSCALE_ADDRESS: "meiji.tail1234.ts.net",
      SUPLEX_PORT: "4111",
    });
    await upsertSuplexEnvironment(filename, {
      SUPLEX_TAILSCALE_EXPOSURE: "direct",
      SUPLEX_TAILSCALE_ADDRESS: "new-host.tail1234.ts.net",
      SUPLEX_PORT: "4222",
    });
    const contents = await readFile(filename, "utf8");

    expect(contents).toMatch(/SUPLEX_TAILSCALE_EXPOSURE=direct/);
    expect(contents).toMatch(/SUPLEX_TAILSCALE_ADDRESS=new-host\.tail1234\.ts\.net/);
    expect(contents).toMatch(/SUPLEX_PORT=4222/);
    expect((contents.match(/SUPLEX_PORT=/g) ?? []).length).toBe(1);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local setup writes the loopback configuration without asking anything", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-setup-local-"));
  const filename = join(root, "suplex.env");
  const previous = { envFile: process.env.SUPLEX_ENV_FILE, port: process.env.SUPLEX_PORT };
  const written: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { written.push(String(chunk)); return true; });
  try {
    process.env.SUPLEX_ENV_FILE = filename;
    process.env.SUPLEX_PORT = "4333";
    await runSetup({ local: true });
    const contents = await readFile(filename, "utf8");

    expect(contents).toMatch(/SUPLEX_ACCESS_MODE=local/);
    expect(contents).toMatch(/SUPLEX_BIND_ADDRESS=127\.0\.0\.1/);
    expect(contents).toMatch(/SUPLEX_PORT=4333/);
    expect(written.join("")).toMatch(/http:\/\/127\.0\.0\.1:4333\/health/);
  } finally {
    write.mockRestore();
    restoreEnvironment("SUPLEX_ENV_FILE", previous.envFile);
    restoreEnvironment("SUPLEX_PORT", previous.port);
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes the actionable Tailscale daemon-not-running failure", () => {
  expect(isTailscaleDaemonUnavailable(new Error("dial unix /var/run/tailscaled.socket: connect: no such file or directory"))).toBe(true);
  expect(isTailscaleDaemonUnavailable(new Error("HTTPS capability is not enabled"))).toBe(false);
});
