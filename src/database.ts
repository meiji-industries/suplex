import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

export type ProbeStatus = "running" | "completed";

export interface ProbeRecord {
  workflowId: string;
  probeId: string;
  companyId: string;
  status: ProbeStatus;
}

export interface WorkerRegistration {
  workerId: string;
  taskQueue: string;
  buildId: string;
}

export interface DatabaseHealth {
  walMode: boolean;
  migrationVersion: number;
  readable: boolean;
  writable: boolean;
}

interface ProbeRow extends ProbeRecord {
  status: ProbeStatus;
}

export class ForgeDatabase {
  private readonly db: Database.Database;

  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  recordProbe(record: ProbeRecord): void {
    this.db
      .prepare(
        `INSERT INTO probe_workflows (probe_id, workflow_id, company_id, status)
         VALUES (@probeId, @workflowId, @companyId, @status)
         ON CONFLICT(probe_id) DO UPDATE SET
           workflow_id = excluded.workflow_id,
           company_id = excluded.company_id,
           status = excluded.status`,
      )
      .run(record);
  }

  getProbe(probeId: string): ProbeRecord | undefined {
    const row = this.db.prepare("SELECT workflow_id AS workflowId, probe_id AS probeId, company_id AS companyId, status FROM probe_workflows WHERE probe_id = ?").get(probeId) as ProbeRow | undefined;
    return row;
  }

  registerWorker(registration: WorkerRegistration): void {
    this.db
      .prepare(
        `INSERT INTO worker_registrations (worker_id, task_queue, build_id, heartbeat_at)
         VALUES (@workerId, @taskQueue, @buildId, @heartbeatAt)
         ON CONFLICT(worker_id) DO UPDATE SET
           task_queue = excluded.task_queue,
           build_id = excluded.build_id,
           heartbeat_at = excluded.heartbeat_at`,
      )
      .run({ ...registration, heartbeatAt: new Date().toISOString() });
  }

  unregisterWorker(workerId: string): void {
    this.db.prepare("DELETE FROM worker_registrations WHERE worker_id = ?").run(workerId);
  }

  workerIsHealthy(taskQueue: string, maxAgeMs = 30_000): boolean {
    const row = this.db
      .prepare("SELECT heartbeat_at AS heartbeatAt FROM worker_registrations WHERE task_queue = ? ORDER BY heartbeat_at DESC LIMIT 1")
      .get(taskQueue) as { heartbeatAt: string } | undefined;
    return row !== undefined && Date.now() - Date.parse(row.heartbeatAt) <= maxAgeMs;
  }

  health(): DatabaseHealth {
    const migrationVersion = Number(this.db.pragma("user_version", { simple: true }));
    const journalMode = String(this.db.pragma("journal_mode", { simple: true })).toLowerCase();
    this.db.prepare("SELECT 1").get();
    this.db.prepare("CREATE TABLE IF NOT EXISTS health_write_probe (id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL)").run();
    this.db.prepare("DROP TABLE health_write_probe").run();
    return {
      walMode: journalMode === "wal",
      migrationVersion,
      readable: true,
      writable: true,
    };
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = Number(this.db.pragma("user_version", { simple: true }));
    if (version >= 1) {
      return;
    }
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS probe_workflows (
          probe_id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL UNIQUE,
          company_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('running', 'completed'))
        );
        CREATE TABLE IF NOT EXISTS worker_registrations (
          worker_id TEXT PRIMARY KEY,
          task_queue TEXT NOT NULL,
          build_id TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL
        );
        PRAGMA user_version = 1;
      `);
    });
    migrate();
  }
}
