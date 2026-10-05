import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { nativeFixture } from "./helpers/native-browser.js";

afterEach(() => vi.unstubAllEnvs());

test("native fixtures block Herdr even when provider commands are inherited", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-herdr-isolation-"));
  const marker = join(root, "installed-herdr-called");
  const output = join(root, "environment");
  try {
    await writeFile(join(root, "herdr"), '#!/bin/sh\nprintf called > "$SUPLEX_TEST_HERDR_MARKER"\n', { mode: 0o700 });
    await writeFile(join(root, "suplex"), '#!/bin/sh\nherdr workspace list\nprintf "%s\\n" "$?" "$SUPLEX_CODEX_COMMAND" > "$SUPLEX_TEST_PROBE_OUTPUT"\nexit 73\n', { mode: 0o700 });
    await writeFile(join(root, "suplex-ui.js"), "");
    vi.stubEnv("PATH", `${root}:${process.env.PATH ?? "/usr/bin:/bin"}`);
    vi.stubEnv("SUPLEX_BIN", join(root, "suplex"));
    vi.stubEnv("SUPLEX_ASSETS_DIR", root);
    vi.stubEnv("SUPLEX_CODEX_COMMAND", "inherited-codex");
    vi.stubEnv("SUPLEX_TEST_HERDR_MARKER", marker);
    vi.stubEnv("SUPLEX_TEST_PROBE_OUTPUT", output);

    for (const providerMode of ["isolated", "inherited"] as const) {
      await expect(nativeFixture("127.0.0.1", undefined, { providerMode })).rejects.toThrow("Rust fixture exited");
      expect(existsSync(marker), providerMode).toBe(false);
      expect(await readFile(output, "utf8")).toBe(`127\n${providerMode === "isolated" ? "/usr/bin/false" : "inherited-codex"}\n`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native fixtures do not adopt another server on their port", async () => {
  const root = await mkdtemp(join(tmpdir(), "suplex-port-ownership-"));
  const other = createServer((_request, response) => response.end("other fixture"));
  try {
    await new Promise<void>(accept => other.listen(0, "127.0.0.1", accept));
    const { port } = other.address() as AddressInfo;
    await writeFile(join(root, "suplex"), '#!/bin/sh\nsleep 1\necho "Error: AddrInUse" >&2\nexit 1\n', { mode: 0o700 });
    await writeFile(join(root, "suplex-ui.js"), "");
    vi.stubEnv("SUPLEX_BIN", join(root, "suplex"));
    vi.stubEnv("SUPLEX_ASSETS_DIR", root);
    await expect(nativeFixture("127.0.0.1", `http://127.0.0.1:${port}`)).rejects.toThrow(/Rust fixture exited: .*AddrInUse/s);
  } finally {
    await new Promise(accept => other.close(accept));
    await rm(root, { recursive: true, force: true });
  }
});
