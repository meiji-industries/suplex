import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import Database from "better-sqlite3";

import { DatabaseMigrationFailure, ForgeDatabase } from "../src/database.js";

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
    expect(reopenedHealth.appliedMigrations).toBe(reopenedHealth.expectedMigrations);
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
    expect(adoptedHealth).toMatchObject({ walMode: true, schemaState: "current" });
    expect(adoptedHealth.appliedMigrations).toBe(adoptedHealth.expectedMigrations);
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

test("schema health distinguishes empty, current, behind, ahead, partial, and corrupt migration states", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-db-schema-test-"));
  const filename = join(root, "forge.sqlite");

  try {
    const database = new ForgeDatabase(filename);
    expect(database.health().schemaState).toBe("current");
    const baselineMigrations = database.authQuery((db) => db.prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC, hash ASC").all() as Array<{ hash: string; created_at: number }>);

    database.authQuery((db) => {
      db.prepare("DELETE FROM __drizzle_migrations").run();
    });
    expect(database.health()).toMatchObject({ schemaState: "behind", appliedMigrations: 0 });

    database.authQuery((db) => {
      const restore = db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
      for (const migration of baselineMigrations) restore.run(migration.hash, migration.created_at);
    });
    const expectedMigrationCount = database.health().expectedMigrations;

    const originalLastHash = lastAppliedHash(database);
    database.authQuery((db) => {
      db.prepare("DELETE FROM __drizzle_migrations WHERE hash = ?").run(originalLastHash);
    });
    expect(database.health()).toMatchObject({ schemaState: "behind", expectedMigrations: expectedMigrationCount, appliedMigrations: expectedMigrationCount - 1 });

    database.authQuery((db) => {
      db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(originalLastHash, Date.now() + 1);
      db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run("unknown-ahead-hash", Date.now() + 2);
    });
    expect(database.health().schemaState).toBe("ahead");

    database.authQuery((db) => {
      db.prepare("DELETE FROM __drizzle_migrations").run();
      const restore = db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
      for (const migration of baselineMigrations) restore.run(migration.hash, migration.created_at);
    });
    database.authQuery((db) => {
      const secondMigration = db.prepare("SELECT hash FROM __drizzle_migrations ORDER BY created_at ASC, hash ASC LIMIT 1 OFFSET 1").get() as { hash: string };
      db.prepare("DELETE FROM __drizzle_migrations WHERE hash = ?").run(secondMigration.hash);
    });
    expect(database.health().schemaState).toBe("partial");

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

test("reports a write lock without discarding readable schema health", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-db-lock-test-"));
  const filename = join(root, "forge.sqlite");

  try {
    const database = new ForgeDatabase(filename);
    const expectedMigrations = database.health().expectedMigrations;
    database.authQuery((db) => db.pragma("busy_timeout = 1"));
    const lockHolder = new Database(filename);
    lockHolder.pragma("busy_timeout = 1");
    lockHolder.exec("BEGIN IMMEDIATE");
    try {
      expect(database.health()).toMatchObject({
        schemaState: "locked",
        expectedMigrations,
        appliedMigrations: expectedMigrations,
        readable: true,
        writable: false,
      });
    } finally {
      lockHolder.exec("ROLLBACK");
      lockHolder.close();
    }
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains exact readable schema health when writes are disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "forge-db-readonly-test-"));
  const filename = join(root, "forge.sqlite");

  try {
    const database = new ForgeDatabase(filename);
    database.authQuery((db) => db.pragma("query_only = ON"));

    expect(database.health()).toMatchObject({
      schemaState: "current",
      readable: true,
      writable: false,
    });
    database.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports normalized repository identity collisions before the unique index migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-db-collision-test-"));
  const filename = join(root, "forge.sqlite");

  try {
    const database = new ForgeDatabase(filename);
    database.close();

    const legacy = new Database(filename);
    legacy.exec("DROP INDEX forge_projects_repository_identity_unique");
    legacy.exec("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company-a', 'Company A', 'active', '2026-08-11T00:00:00.000Z'), ('company-b', 'Company B', 'active', '2026-08-11T00:00:00.000Z')");
    const insert = legacy.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'main', 'main', 'pnpm install', 'pnpm test', '[]', '[]', '{}', 'draft', NULL, ?, ?)");
    insert.run("project-a", "company-a", "Project A", "/repositories/a", "/worktrees/a", " Acme/Forge ", "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z");
    insert.run("project-b", "company-b", "Project B", "/repositories/b", "/worktrees/b", "acme/forge", "2026-08-11T00:00:00.000Z", "2026-08-11T00:00:00.000Z");
    legacy.close();

    expect(() => new ForgeDatabase(filename)).toThrowError(expect.objectContaining({
      name: "DatabaseMigrationFailure",
      code: "repository_identity_collision",
      collisions: [
        { projectId: "project-a", companyId: "company-a", repositoryIdentity: "acme/forge" },
        { projectId: "project-b", companyId: "company-b", repositoryIdentity: "acme/forge" },
      ],
    } satisfies Partial<DatabaseMigrationFailure>));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
