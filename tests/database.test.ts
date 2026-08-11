import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import Database from "better-sqlite3";

import { ForgeDatabase } from "../src/database.js";

const expectedMigrationCount = 15;

test("initializes migrations in WAL mode and preserves probe state after reopening", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-db-test-"));
  const filename = join(root, "forge.sqlite");

  try {
    const first = new ForgeDatabase(filename);
    first.recordProbe({
      workflowId: "probe-workflow-1",
      probeId: "probe-1",
      companyId: "company-1",
      status: "running",
    });
    const firstHealth = first.health();
    expect(firstHealth.walMode).toBe(true);
    expect(firstHealth.schemaState).toBe("current");
    first.close();

    const reopened = new ForgeDatabase(filename);
    expect(reopened.getProbe("probe-1")).toEqual({
      workflowId: "probe-workflow-1",
      probeId: "probe-1",
      companyId: "company-1",
      status: "running",
    });
    const reopenedHealth = reopened.health();
    expect(reopenedHealth.schemaState).toBe("current");
    expect(reopenedHealth.expectedMigrations).toBe(expectedMigrationCount);
    expect(reopenedHealth.appliedMigrations).toBe(expectedMigrationCount);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adopts a pre-Drizzle database without rewriting existing probe state", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-db-compatibility-test-"));
  const filename = join(root, "forge.sqlite");

  try {
    const legacy = new Database(filename);
    legacy.pragma("journal_mode = WAL");
    legacy.exec(`
      CREATE TABLE probe_workflows (
        probe_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL UNIQUE,
        company_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed'))
      );
      CREATE TABLE worker_registrations (
        worker_id TEXT PRIMARY KEY,
        task_queue TEXT NOT NULL,
        build_id TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );
      INSERT INTO probe_workflows (probe_id, workflow_id, company_id, status)
      VALUES ('legacy-probe', 'legacy-workflow', 'legacy-company', 'running');
      INSERT INTO worker_registrations (worker_id, task_queue, build_id, heartbeat_at)
      VALUES ('legacy-worker', 'legacy-tasks', 'legacy-build', '${new Date().toISOString()}');
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const adopted = new ForgeDatabase(filename);
    expect(adopted.getProbe("legacy-probe")).toEqual({
      probeId: "legacy-probe",
      workflowId: "legacy-workflow",
      companyId: "legacy-company",
      status: "running",
    });
    const adoptedHealth = adopted.health();
    expect(adoptedHealth).toMatchObject({ walMode: true, schemaState: "current", expectedMigrations: expectedMigrationCount, appliedMigrations: expectedMigrationCount });
    adopted.close();

    const reopened = new ForgeDatabase(filename);
    expect(reopened.workerHealth("legacy-tasks")).toMatchObject({ workerId: "legacy-worker", buildId: "legacy-build" });
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function lastAppliedHash(database: ForgeDatabase): string {
  return database.authQuery((db) => (db.prepare("SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1").get() as { hash: string }).hash);
}

test("schema health distinguishes current, behind, partial, and corrupt migration states", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-db-schema-test-"));
  const filename = join(root, "forge.sqlite");

  try {
    const database = new ForgeDatabase(filename);
    expect(database.health().schemaState).toBe("current");

    const originalLastHash = lastAppliedHash(database);
    database.authQuery((db) => {
      db.prepare("DELETE FROM __drizzle_migrations WHERE hash = ?").run(originalLastHash);
    });
    expect(database.health()).toMatchObject({ schemaState: "behind", expectedMigrations: expectedMigrationCount, appliedMigrations: expectedMigrationCount - 1 });

    database.authQuery((db) => {
      db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(originalLastHash, Date.now() + 1);
      db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(originalLastHash, Date.now() + 2);
    });
    expect(database.health().schemaState).toBe("ahead");

    database.authQuery((db) => {
      db.prepare("DELETE FROM __drizzle_migrations").run();
      db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run("corrupt-hash", 1);
    });
    expect(database.health().schemaState).toBe("corrupt");

    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema health is current but unhealthy when WAL is disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-db-wal-test-"));
  const filename = join(root, "forge.sqlite");

  try {
    const database = new ForgeDatabase(filename);
    database.authQuery((db) => db.pragma("journal_mode = DELETE"));
    const health = database.health();
    expect(health.schemaState).toBe("current");
    expect(health.walMode).toBe(false);
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
