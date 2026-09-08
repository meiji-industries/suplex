import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";

import { formatDoctor } from "../src/platform/diagnostics/doctor.js";
import { inspectTask, formatTaskDiagnostic } from "../src/platform/diagnostics/task.js";
import { ForgeDatabase } from "../src/platform/database.js";
import { nativeApp } from "./helpers/native-app.js";
import { createTestConfig } from "../src/platform/config.js";

describe("operator diagnostics formatting", () => {
  test("reports the native task intent and question without a phase projection", async () => {
    const value = await nativeApp();
    try {
      const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, idempotencyKey: "diagnostic-task", title: "Repair build", description: "Repair the build", startImmediately: false });
      const diagnostic = await inspectTask(value.config, value.database, task.id);
      const output = formatTaskDiagnostic(diagnostic);
      expect(output).toContain("Repair build");
      expect(output).toContain("backlog");
      expect(diagnostic.sessions).toEqual([]);
      expect(diagnostic).not.toHaveProperty("projection");
    } finally { await value.close(); }
  });

  test("keeps doctor status at the front of every line", () => {
    expect(formatDoctor([{ status: "PASS", name: "sqlite WAL", detail: "wal" }, { status: "FAIL", name: "database references", detail: "1 invalid reference" }])).toBe("PASS sqlite WAL: wal\nFAIL database references: 1 invalid reference\n");
  });
});

test("read-only diagnostics open never creates or migrates the database", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-diagnostics-readonly-"));
  const filename = join(root, "forge.sqlite");
  try {
    const seed = new Database(filename);
    seed.exec("CREATE TABLE existing_data (id INTEGER PRIMARY KEY)");
    seed.close();

    const database = new ForgeDatabase(filename, { readOnly: true });
    expect(database.openMode()).toBe("read-only");
    expect(database.schemaStatus().state).toBe("behind");
    database.close();

    const inspected = new Database(filename, { readonly: true });
    expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get()).toBeUndefined();
    inspected.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor reports a database behind this build without migrating it", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-diagnostics-fix-"));
  const filename = join(root, "forge.sqlite");
  try {
    const migrating = new ForgeDatabase(filename);
    migrating.authQuery((db) => db.prepare("DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)").run());
    migrating.close();

    const diagnostic = new ForgeDatabase(filename, { migrate: false });
    const { runDoctor } = await import("../src/platform/diagnostics/doctor.js");
    expect(await runDoctor(createTestConfig(root), diagnostic)).toEqual([expect.objectContaining({ status: "FAIL", name: "database schema" })]);
    expect(diagnostic.schemaStatus().state).toBe("behind");
    diagnostic.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
