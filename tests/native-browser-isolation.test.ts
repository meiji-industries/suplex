import { existsSync } from "node:fs";
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
    vi.stubEnv("SUPLEX_RUST_BIN", join(root, "suplex"));
    vi.stubEnv("SUPLEX_RUST_ASSETS_DIR", root);
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
