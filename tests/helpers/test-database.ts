import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { SuplexDatabase } from "../../src/platform/database.js";

let pristineDatabase: Buffer | undefined;

function pristineBytes(): Buffer {
  if (pristineDatabase) return pristineDatabase;

  const directory = mkdtempSync(join(tmpdir(), "suplex-test-database-"));
  const filename = join(directory, "suplex.sqlite");
  let database: SuplexDatabase | undefined;
  try {
    database = new SuplexDatabase(filename);
    database.close();
    database = undefined;
    pristineDatabase = readFileSync(filename);
    return pristineDatabase;
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

export function createTestDatabase(filename: string): SuplexDatabase {
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, pristineBytes(), { flag: "wx" });
  return new SuplexDatabase(filename, { migrate: false });
}
