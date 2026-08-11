import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import Database from "better-sqlite3";

import { ForgeDatabase } from "../src/database.js";

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
    expect(first.health().walMode).toBe(true);
    first.close();

    const reopened = new ForgeDatabase(filename);
    expect(reopened.getProbe("probe-1")).toEqual({
      workflowId: "probe-workflow-1",
      probeId: "probe-1",
      companyId: "company-1",
      status: "running",
    });
    expect(reopened.health().migrationVersion).toBe(9);
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
    expect(adopted.health()).toMatchObject({ walMode: true, migrationVersion: 9 });
    adopted.close();

    const reopened = new ForgeDatabase(filename);
    expect(reopened.workerHealth("legacy-tasks")).toMatchObject({ workerId: "legacy-worker", buildId: "legacy-build" });
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
