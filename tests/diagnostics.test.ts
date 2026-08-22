import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";

import { formatDoctor } from "../src/diagnostics/doctor.js";
import { formatTaskDiagnostic } from "../src/diagnostics/task.js";
import { ForgeDatabase } from "../src/database.js";

describe("operator diagnostics formatting", () => {
  test("makes a projection/live disagreement conspicuous", () => {
    const output = formatTaskDiagnostic({
      taskId: "task-1",
      projection: { title: "Repair build", phase: "planning", revision: 3, owner: "human", pendingAction: "Approve", allowedCommands: ["approve"] },
      live: { phase: "development", revision: 4, allowedCommands: ["retry_development"], differences: [{ field: "phase" }] },
      workflow: { status: "RUNNING", buildId: "build-old", pendingWorkflowTaskAgeSeconds: 61, lastFailure: "worker lost" },
      executions: [], capacity: [], commands: [], history: [],
    });
    expect(output).toContain("DIFF");
    expect(output).toContain("build-old");
    expect(output).toContain("worker lost");
  });

  test("keeps doctor status at the front of every line", () => {
    expect(formatDoctor([{ status: "PASS", name: "sqlite WAL", detail: "wal" }, { status: "FAIL", name: "replay open workflows", detail: "task-1: nondeterministic" }])).toBe("PASS sqlite WAL: wal\nFAIL replay open workflows: task-1: nondeterministic\n");
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

test("doctor --fix refuses a database behind this build", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-diagnostics-fix-"));
  const filename = join(root, "forge.sqlite");
  try {
    const migrating = new ForgeDatabase(filename);
    migrating.authQuery((db) => db.prepare("DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)").run());
    migrating.close();

    const diagnostic = new ForgeDatabase(filename, { migrate: false });
    const { runDoctor } = await import("../src/diagnostics/doctor.js");
    await expect(runDoctor({} as never, diagnostic, { fix: true })).rejects.toThrow("database is behind this build — restart the stack to migrate");
    diagnostic.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
