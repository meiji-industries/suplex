import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isTailscaleDaemonUnavailable, upsertForgeEnvironment } from "../src/setup.js";

test("setup upserts Forge choices without duplicating or overwriting unrelated settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-setup-test-"));
  const filename = join(root, "forge.env");
  try {
    await upsertForgeEnvironment(filename, {
      FORGE_TAILSCALE_EXPOSURE: "serve",
      FORGE_TAILSCALE_ADDRESS: "meiji.tail1234.ts.net",
      FORGE_PORT: "4111",
    });
    await upsertForgeEnvironment(filename, {
      FORGE_TAILSCALE_EXPOSURE: "direct",
      FORGE_TAILSCALE_ADDRESS: "new-host.tail1234.ts.net",
      FORGE_PORT: "4222",
    });
    const contents = await readFile(filename, "utf8");

    assert.match(contents, /FORGE_TAILSCALE_EXPOSURE=direct/);
    assert.match(contents, /FORGE_TAILSCALE_ADDRESS=new-host\.tail1234\.ts\.net/);
    assert.match(contents, /FORGE_PORT=4222/);
    assert.equal((contents.match(/FORGE_PORT=/g) ?? []).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes the actionable Tailscale daemon-not-running failure", () => {
  assert.equal(isTailscaleDaemonUnavailable(new Error("dial unix /var/run/tailscaled.socket: connect: no such file or directory")), true);
  assert.equal(isTailscaleDaemonUnavailable(new Error("HTTPS capability is not enabled")), false);
});
