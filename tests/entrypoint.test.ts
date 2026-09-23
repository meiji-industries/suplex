import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { isEntrypoint } from "../src/shared/entrypoint.js";

describe("isEntrypoint", () => {
  const argv = process.argv;
  afterEach(() => { process.argv = argv; });

  test("matches a script started through a symlinked directory", () => {
    const root = mkdtempSync(join(tmpdir(), "entrypoint-"));
    writeFileSync(join(root, "cli.js"), "");
    symlinkSync(root, join(root, "..", `${root.split("/").pop()}-link`));
    process.argv = [argv[0]!, `${root}-link/cli.js`];
    expect(isEntrypoint(pathToFileURL(join(root, "cli.js")).href)).toBe(true);
  });

  test("rejects another script and a missing argv[1]", () => {
    const root = mkdtempSync(join(tmpdir(), "entrypoint-"));
    writeFileSync(join(root, "cli.js"), "");
    writeFileSync(join(root, "other.js"), "");
    process.argv = [argv[0]!, join(root, "other.js")];
    expect(isEntrypoint(pathToFileURL(join(root, "cli.js")).href)).toBe(false);
    process.argv = [argv[0]!];
    expect(isEntrypoint(pathToFileURL(join(root, "cli.js")).href)).toBe(false);
  });
});
