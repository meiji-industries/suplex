import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseTailnetMachines, tailnetMachines } from "../src/tailscale";

const status = (backend: string, peers: Record<string, unknown>): string => JSON.stringify({ BackendState: backend, Self: { DNSName: "this-mac.tail1.ts.net." }, Peer: peers });

test("lists other machines by MagicDNS name, online first, without phones or Mullvad exit nodes", () => {
  expect(parseTailnetMachines(status("Running", {
    a: { DNSName: "zed.tail1.ts.net.", OS: "linux", Online: true },
    b: { DNSName: "alpha.tail1.ts.net.", OS: "macOS", Online: false },
    c: { DNSName: "devbox.tail1.ts.net.", OS: "linux", Online: true },
    d: { DNSName: "phone.tail1.ts.net.", OS: "iOS", Online: true },
    e: { DNSName: "", OS: "linux", Online: true },
    f: { DNSName: "al-tia-wg-001.mullvad.ts.net.", OS: "", Online: true, Location: { Country: "Albania" } },
  }))).toEqual([
    { name: "devbox", host: "devbox.tail1.ts.net", online: true },
    { name: "zed", host: "zed.tail1.ts.net", online: true },
    { name: "alpha", host: "alpha.tail1.ts.net", online: false },
  ]);
});

test("reports no Tailscale when it is logged out, stopped, or absent", async () => {
  expect(parseTailnetMachines(status("NeedsLogin", {}))).toBeNull();
  expect(parseTailnetMachines("not json")).toBeNull();
  expect(await tailnetMachines(["/nonexistent/tailscale"])).toBeNull();
});

test("moves on when a CLI exits 0 without status JSON", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tailscale-"));
  const working = join(directory, "tailscale");
  writeFileSync(working, `#!/bin/sh\necho '${status("Running", { a: { DNSName: "devbox.tail1.ts.net.", OS: "linux", Online: true } })}'\n`);
  chmodSync(working, 0o755);
  expect(await tailnetMachines(["/bin/echo", working])).toEqual([{ name: "devbox", host: "devbox.tail1.ts.net", online: true }]);
});
