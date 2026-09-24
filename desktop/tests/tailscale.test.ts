import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseTailscaleStatus, tailscaleStatus, turnOnTailscale } from "../src/tailscale";

const status = (backend: string, peers: Record<string, unknown>): string =>
  JSON.stringify({ BackendState: backend, CurrentTailnet: { Name: "example.com" }, Self: { HostName: "this-mac", DNSName: "this-mac.tail1.ts.net." }, Peer: peers });

const script = (body: string): string => {
  const file = join(mkdtempSync(join(tmpdir(), "tailscale-")), "tailscale");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
};

test("lists other machines by MagicDNS name, online first, without phones or Mullvad exit nodes", () => {
  expect(parseTailscaleStatus(status("Running", {
    a: { DNSName: "zed.tail1.ts.net.", OS: "linux", Online: true },
    b: { DNSName: "alpha.tail1.ts.net.", OS: "macOS", Online: false },
    c: { DNSName: "devbox.tail1.ts.net.", OS: "linux", Online: true },
    d: { DNSName: "phone.tail1.ts.net.", OS: "iOS", Online: true },
    e: { DNSName: "", OS: "linux", Online: true },
    f: { DNSName: "al-tia-wg-001.mullvad.ts.net.", OS: "", Online: true, Location: { Country: "Albania" } },
  }))).toEqual({
    state: "on",
    tailnet: "example.com",
    machines: [
      { name: "devbox", host: "devbox.tail1.ts.net", online: true },
      { name: "zed", host: "zed.tail1.ts.net", online: true },
      { name: "alpha", host: "alpha.tail1.ts.net", online: false },
    ],
  });
});

test("tells off, signed out, approval, and starting apart, and lists machines only when on", () => {
  const peer = { a: { DNSName: "devbox.tail1.ts.net.", OS: "linux", Online: true } };
  expect(parseTailscaleStatus(status("Stopped", peer))).toEqual({ state: "off", tailnet: "example.com", machines: [] });
  expect(parseTailscaleStatus(status("NeedsLogin", peer))).toEqual({ state: "signed-out", tailnet: null, machines: [] });
  expect(parseTailscaleStatus(status("NeedsMachineAuth", {}))?.state).toBe("approval");
  expect(parseTailscaleStatus(status("Starting", {}))?.state).toBe("starting");
  expect(parseTailscaleStatus("not json")).toBeNull();
});

test("reports missing when no CLI exists, and not running when a CLI exists but gives no status", async () => {
  expect((await tailscaleStatus(["/nonexistent/tailscale"])).state).toBe("missing");
  expect((await tailscaleStatus(["/nonexistent/tailscale", script("echo 'failed to connect to local Tailscale service' >&2; exit 1")])).state).toBe("not-running");
});

test("moves on when a CLI exits 0 without status JSON", async () => {
  const working = script(`echo '${status("Running", { a: { DNSName: "devbox.tail1.ts.net.", OS: "linux", Online: true } })}'`);
  expect((await tailscaleStatus(["/bin/echo", working])).machines).toEqual([{ name: "devbox", host: "devbox.tail1.ts.net", online: true }]);
});

test("runs the App Store binary as a CLI", async () => {
  const cli = script(`[ "$TAILSCALE_BE_CLI" = 1 ] && echo '${status("Stopped", {})}'`);
  expect((await tailscaleStatus([cli])).state).toBe("off");
});

test("turns Tailscale on with a bare `tailscale up`, and reports why it did not", async () => {
  // Any flag makes `up` a settings change, which fails on a Mac with non-default settings.
  expect(await turnOnTailscale([script(`[ "$*" = "up" ]`)])).toBeNull();
  expect(await turnOnTailscale([script("printf 'Error: changing settings requires\\nall flags\\n' >&2; exit 1")])).toBe("Error: changing settings requires all flags");
  expect(await turnOnTailscale(["/nonexistent/tailscale"])).toBe("Tailscale is not installed on this Mac.");
});
