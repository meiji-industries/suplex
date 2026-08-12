import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { isTailscaleDaemonUnavailable, upsertForgeEnvironment } from "../src/setup.js";

test("setup upserts Forge choices without duplicating or overwriting unrelated settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-setup-test-"));
  const filename = join(root, "forge.env");
  try {
    await upsertForgeEnvironment(filename, {
      FORGE_TAILSCALE_EXPOSURE: "serve",
      FORGE_TAILSCALE_ADDRESS: "meiji.tail1234.ts.net",
      FORGE_PORT: "4111",
      FORGE_TEMPORAL_TARGET: "cloud",
      FORGE_TEMPORAL_ADDRESS: "old.account.tmprl.cloud:7233",
      FORGE_TEMPORAL_NAMESPACE: "old.account",
      FORGE_TEMPORAL_API_KEY: "old-key",
    });
    await upsertForgeEnvironment(filename, {
      FORGE_TAILSCALE_EXPOSURE: "direct",
      FORGE_TAILSCALE_ADDRESS: "new-host.tail1234.ts.net",
      FORGE_PORT: "4222",
      FORGE_TEMPORAL_TARGET: "cloud",
      FORGE_TEMPORAL_ADDRESS: "new.account.tmprl.cloud:7233",
      FORGE_TEMPORAL_NAMESPACE: "new.account",
      FORGE_TEMPORAL_API_KEY: "new-key",
    });
    const contents = await readFile(filename, "utf8");

    expect(contents).toMatch(/FORGE_TAILSCALE_EXPOSURE=direct/);
    expect(contents).toMatch(/FORGE_TAILSCALE_ADDRESS=new-host\.tail1234\.ts\.net/);
    expect(contents).toMatch(/FORGE_PORT=4222/);
    expect(contents).toMatch(/FORGE_TEMPORAL_TARGET=cloud/);
    expect(contents).toMatch(/FORGE_TEMPORAL_ADDRESS=new\.account\.tmprl\.cloud:7233/);
    expect(contents).toMatch(/FORGE_TEMPORAL_NAMESPACE=new\.account/);
    expect(contents).toMatch(/FORGE_TEMPORAL_API_KEY=new-key/);
    expect((contents.match(/FORGE_PORT=/g) ?? []).length).toBe(1);
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes the actionable Tailscale daemon-not-running failure", () => {
  expect(isTailscaleDaemonUnavailable(new Error("dial unix /var/run/tailscaled.socket: connect: no such file or directory"))).toBe(true);
  expect(isTailscaleDaemonUnavailable(new Error("HTTPS capability is not enabled"))).toBe(false);
});
