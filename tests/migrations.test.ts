import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";

import { applyMigrations, readMigrations } from "../src/database.js";

describe("timestamp migrations", () => {
  test("recognizes migrations applied by the legacy Drizzle journal runner", () => {
    const folder = mkdtempSync(join(tmpdir(), "forge-migrations-"));
    const database = new Database(":memory:");
    try {
      const sql = "CREATE TABLE existing (id text PRIMARY KEY);\n";
      writeFileSync(join(folder, "20260812120000000_create_existing.sql"), sql);
      const [migration] = readMigrations(folder);
      database.exec("CREATE TABLE existing (id text PRIMARY KEY); CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)");
      database.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(migration!.hash, migration!.createdAt);

      expect(() => applyMigrations(database, folder)).not.toThrow();
      expect(database.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: 1 });
    } finally {
      database.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("applies a missing older migration after a newer migration", () => {
    const folder = mkdtempSync(join(tmpdir(), "forge-migrations-"));
    const database = new Database(":memory:");
    try {
      writeFileSync(join(folder, "20260812120000000_create_newer.sql"), "CREATE TABLE newer (id text PRIMARY KEY);\n");
      applyMigrations(database, folder);

      writeFileSync(join(folder, "20260812110000000_create_older.sql"), "CREATE TABLE older (id text PRIMARY KEY);\n");
      applyMigrations(database, folder);

      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('older', 'newer') ORDER BY name").all();
      expect(tables).toEqual([{ name: "newer" }, { name: "older" }]);
      expect(database.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: 2 });
    } finally {
      database.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("rejects sequential and duplicate timestamp names", () => {
    const folder = mkdtempSync(join(tmpdir(), "forge-migrations-"));
    try {
      writeFileSync(join(folder, "0022_sequential.sql"), "SELECT 1;\n");
      expect(() => readMigrations(folder)).toThrow("must start with a UTC timestamp");
      rmSync(join(folder, "0022_sequential.sql"));
      writeFileSync(join(folder, "20260812120000_one.sql"), "SELECT 1;\n");
      writeFileSync(join(folder, "20260812120000_two.sql"), "SELECT 2;\n");
      expect(() => readMigrations(folder)).toThrow("timestamps must be unique");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
