import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { SuplexDatabase } from "../../src/platform/database.js";
import { createTestDatabase } from "./test-database.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function filename(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), "suplex-test-database-test-"));
  directories.push(directory);
  return join(directory, name, "suplex.sqlite");
}

test("creates current isolated databases that persist after reopening", () => {
  const firstFilename = filename("first");
  const secondFilename = filename("second");
  const first = createTestDatabase(firstFilename);
  const second = createTestDatabase(secondFilename);
  try {
    expect(first.schemaStatus()).toMatchObject({ state: "current", walMode: true });
    expect(second.schemaStatus()).toMatchObject({ state: "current", walMode: true });
    first.authTransaction(db => db.prepare("INSERT INTO suplex_companies (id, name, status, created_at) VALUES ('first', 'First', 'active', ?)").run(new Date().toISOString()));
    expect(second.authQuery(db => db.prepare("SELECT COUNT(*) AS count FROM suplex_companies").get())).toEqual({ count: 0 });
  } finally {
    first.close();
    second.close();
  }

  const reopened = new SuplexDatabase(firstFilename);
  try {
    expect(reopened.authQuery(db => db.prepare("SELECT name FROM suplex_companies WHERE id = 'first'").get())).toEqual({ name: "First" });
  } finally {
    reopened.close();
  }
});

test("refuses to overwrite an existing target", () => {
  const target = filename("existing");
  const database = createTestDatabase(target);
  database.close();
  expect(existsSync(target)).toBe(true);
  expect(() => createTestDatabase(target)).toThrow();
});
