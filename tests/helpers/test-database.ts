import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ForgeDatabase } from "../../src/platform/database.js";

let pristineDatabase: Buffer | undefined;

function pristineBytes(): Buffer {
  if (pristineDatabase) return pristineDatabase;

  const directory = mkdtempSync(join(tmpdir(), "forge-test-database-"));
  const filename = join(directory, "forge.sqlite");
  let database: ForgeDatabase | undefined;
  try {
    database = new ForgeDatabase(filename);
    database.close();
    database = undefined;
    pristineDatabase = readFileSync(filename);
    return pristineDatabase;
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

export function createTestDatabase(filename: string): ForgeDatabase {
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, pristineBytes(), { flag: "wx" });
  return new ForgeDatabase(filename, { migrate: false });
}
