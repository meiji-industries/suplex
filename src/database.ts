import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { desc, eq, sql } from "drizzle-orm";

import { probeWorkflows, workerRegistrations } from "./database-schema.js";

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
  heartbeatAt?: string;
}

export interface WorkerHealth {
  workerId: string;
  taskQueue: string;
  buildId: string;
  heartbeatAt: string;
  heartbeatAgeMs: number;
}

export interface IssueProjectionRecord {
  taskId: string;
  companyId: string;
  projectId: string;
  workflowId: string;
  revision: number;
  phase: "backlog" | "planning" | "approval" | "ready_for_development" | "development" | "delivery_ready" | "reviewing_delivery" | "repair_required" | "delivery_reviewed" | "releasing" | "merge_conflict_reviewing" | "merge_conflict_required" | "merge_conflict_resolving" | "ci_waiting" | "ci_repair_required" | "final_review" | "accepted" | "manual_merge" | "done" | "delivery_blocked" | "cancelled" | "failed";
  owner: "human" | "lead";
  allowedCommands: string[];
  pendingAction: string | null;
  lastEventId: string;
  planRevision?: number | null;
  planMaterial?: boolean | null;
  materialCategories?: string[];
  supplementalReviewUsed?: boolean;
  supplementalReviewArtifactId?: string | null;
  decisionId?: string | null;
  state?: Record<string, unknown>;
}

export interface DatabaseHealth {
  walMode: boolean;
  migrationVersion: number;
  readable: boolean;
  writable: boolean;
}

interface MigrationCountRow {
  count: number;
}

function migrationFolder(): string {
  const candidates = [
    resolve(process.cwd(), "drizzle"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle"),
  ];
  const folder = candidates.find((candidate) => {
    try {
      return existsSync(`${candidate}/meta/_journal.json`);
    } catch {
      return false;
    }
  });
  if (!folder) {
    throw new Error("Forge database migrations are not installed");
  }
  return folder;
}

export class ForgeDatabase {
  private readonly db: Database.Database;
  private readonly orm: BetterSQLite3Database;

  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.orm = drizzle(this.db);
    migrate(this.orm, { migrationsFolder: migrationFolder() });
  }

  recordProbe(record: ProbeRecord): void {
    this.orm
      .insert(probeWorkflows)
      .values(record)
      .onConflictDoUpdate({
        target: probeWorkflows.probeId,
        set: {
          workflowId: record.workflowId,
          companyId: record.companyId,
          status: record.status,
        },
      })
      .run();
  }

  getProbe(probeId: string): ProbeRecord | undefined {
    const row = this.orm
      .select({
        workflowId: probeWorkflows.workflowId,
        probeId: probeWorkflows.probeId,
        companyId: probeWorkflows.companyId,
        status: probeWorkflows.status,
      })
      .from(probeWorkflows)
      .where(eq(probeWorkflows.probeId, probeId))
      .get();
    return row as ProbeRecord | undefined;
  }

  registerWorker(registration: WorkerRegistration): void {
    const heartbeatAt = registration.heartbeatAt ?? new Date().toISOString();
    this.orm
      .insert(workerRegistrations)
      .values({ ...registration, heartbeatAt })
      .onConflictDoUpdate({
        target: workerRegistrations.workerId,
        set: {
          taskQueue: registration.taskQueue,
          buildId: registration.buildId,
          heartbeatAt,
        },
      })
      .run();
  }

  unregisterWorker(workerId: string): void {
    this.orm.delete(workerRegistrations).where(eq(workerRegistrations.workerId, workerId)).run();
  }

  workerHealth(taskQueue: string): WorkerHealth | undefined {
    const row = this.orm
      .select({
        workerId: workerRegistrations.workerId,
        taskQueue: workerRegistrations.taskQueue,
        buildId: workerRegistrations.buildId,
        heartbeatAt: workerRegistrations.heartbeatAt,
      })
      .from(workerRegistrations)
      .where(eq(workerRegistrations.taskQueue, taskQueue))
      .orderBy(desc(workerRegistrations.heartbeatAt))
      .get();
    if (!row) {
      return undefined;
    }
    const heartbeatAgeMs = Date.now() - Date.parse(row.heartbeatAt);
    return { ...row, heartbeatAgeMs };
  }

  workerIsHealthy(taskQueue: string, maxAgeMs = 30_000): boolean {
    const worker = this.workerHealth(taskQueue);
    return worker !== undefined && worker.heartbeatAgeMs <= maxAgeMs;
  }

  authTransaction<T>(operation: (database: Database.Database) => T): T {
    return this.db.transaction(() => operation(this.db))();
  }

  authQuery<T>(operation: (database: Database.Database) => T): T {
    return operation(this.db);
  }

  projectIssueState(state: IssueProjectionRecord): void {
    this.db.transaction(() => {
      const updatedAt = new Date().toISOString();
      this.db.prepare(`INSERT OR IGNORE INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, event_type, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        state.lastEventId,
        state.taskId,
        state.companyId,
        state.workflowId,
        state.revision,
        state.phase === "backlog" ? "task_created" : state.phase === "planning" ? "planning_started" : `phase_${state.phase}`,
        JSON.stringify({ revision: state.revision, phase: state.phase }),
        updatedAt,
      );
      const current = this.db.prepare("SELECT revision FROM forge_issue_projections WHERE task_id = ?").get(state.taskId) as { revision: number } | undefined;
      if (current && current.revision > state.revision) return;
      this.db.prepare(`INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET company_id = excluded.company_id, project_id = excluded.project_id, workflow_id = excluded.workflow_id, revision = excluded.revision, phase = excluded.phase, owner = excluded.owner, allowed_commands_json = excluded.allowed_commands_json, pending_action = excluded.pending_action, updated_at = excluded.updated_at, last_event_id = excluded.last_event_id
        WHERE forge_issue_projections.revision <= excluded.revision`).run(
        state.taskId,
        state.companyId,
        state.projectId,
        state.workflowId,
        state.revision,
        state.phase,
        state.owner,
        JSON.stringify(state.allowedCommands),
        state.pendingAction,
        updatedAt,
        state.lastEventId,
      );
      this.db.prepare(`INSERT INTO forge_issue_governance (task_id, company_id, plan_revision, plan_material, material_categories_json, supplemental_review_used, supplemental_review_artifact_id, decision_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET company_id = excluded.company_id, plan_revision = excluded.plan_revision, plan_material = excluded.plan_material, material_categories_json = excluded.material_categories_json, supplemental_review_used = excluded.supplemental_review_used, supplemental_review_artifact_id = excluded.supplemental_review_artifact_id, decision_id = excluded.decision_id`).run(
        state.taskId,
        state.companyId,
        state.planRevision ?? null,
        state.planMaterial === undefined || state.planMaterial === null ? null : state.planMaterial ? 1 : 0,
        JSON.stringify(state.materialCategories ?? []),
        state.supplementalReviewUsed ? 1 : 0,
        state.supplementalReviewArtifactId ?? null,
        state.decisionId ?? null,
      );
      this.db.prepare(`INSERT OR IGNORE INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
        state.taskId,
        state.companyId,
        state.workflowId,
        state.revision,
        JSON.stringify(state.state ?? {
          taskId: state.taskId,
          companyId: state.companyId,
          projectId: state.projectId,
          workflowId: state.workflowId,
          revision: state.revision,
          phase: state.phase,
          owner: state.owner,
          allowedCommands: state.allowedCommands,
          pendingAction: state.pendingAction,
          lastEventId: state.lastEventId,
          planRevision: state.planRevision ?? null,
          planMaterial: state.planMaterial ?? null,
          materialCategories: state.materialCategories ?? [],
          supplementalReviewUsed: state.supplementalReviewUsed ?? false,
          supplementalReviewArtifactId: state.supplementalReviewArtifactId ?? null,
          decisionId: state.decisionId ?? null,
        }),
        updatedAt,
      );
    })();
  }

  rebuildIssueProjections(taskId?: string): number {
    return this.db.transaction(() => {
      const snapshots = (taskId
        ? this.db.prepare("SELECT task_id, company_id, workflow_id, revision, state_json FROM forge_workflow_snapshots WHERE task_id = ? ORDER BY task_id, revision").all(taskId)
        : this.db.prepare("SELECT task_id, company_id, workflow_id, revision, state_json FROM forge_workflow_snapshots ORDER BY task_id, revision").all()) as Array<{ task_id: string; company_id: string; workflow_id: string; revision: number; state_json: string }>;
      const taskIds = [...new Set(snapshots.map((snapshot) => snapshot.task_id))];
      for (const id of taskIds) {
        this.db.prepare("DELETE FROM forge_issue_projections WHERE task_id = ?").run(id);
        this.db.prepare("DELETE FROM forge_issue_governance WHERE task_id = ?").run(id);
      }
      for (const snapshot of snapshots) {
        let state: Record<string, unknown>;
        try { state = JSON.parse(snapshot.state_json) as Record<string, unknown>; } catch { continue; }
        this.db.prepare(`INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET revision = excluded.revision, phase = excluded.phase, owner = excluded.owner, allowed_commands_json = excluded.allowed_commands_json, pending_action = excluded.pending_action, updated_at = excluded.updated_at, last_event_id = excluded.last_event_id
          WHERE forge_issue_projections.revision <= excluded.revision`).run(
          snapshot.task_id,
          snapshot.company_id,
          String(state.projectId ?? ""),
          snapshot.workflow_id,
          snapshot.revision,
          String(state.phase ?? "failed"),
          String(state.owner ?? "human"),
          JSON.stringify(Array.isArray(state.allowedCommands) ? state.allowedCommands : []),
          typeof state.pendingAction === "string" ? state.pendingAction : null,
          new Date().toISOString(),
          String(state.lastEventId ?? `${snapshot.workflow_id}:${snapshot.revision}`),
        );
        this.db.prepare(`INSERT INTO forge_issue_governance (task_id, company_id, plan_revision, plan_material, material_categories_json, supplemental_review_used, supplemental_review_artifact_id, decision_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET plan_revision = excluded.plan_revision, plan_material = excluded.plan_material, material_categories_json = excluded.material_categories_json, supplemental_review_used = excluded.supplemental_review_used, supplemental_review_artifact_id = excluded.supplemental_review_artifact_id, decision_id = excluded.decision_id`).run(
          snapshot.task_id,
          snapshot.company_id,
          typeof state.planRevision === "number" ? state.planRevision : null,
          state.planMaterial === true ? 1 : state.planMaterial === false ? 0 : null,
          JSON.stringify(Array.isArray(state.materialCategories) ? state.materialCategories : []),
          state.supplementalReviewUsed === true ? 1 : 0,
          typeof state.supplementalReviewArtifactId === "string" ? state.supplementalReviewArtifactId : null,
          typeof state.decisionId === "string" ? state.decisionId : null,
        );
      }
      return taskIds.length;
    })();
  }

  health(): DatabaseHealth {
    const migrationRow = this.orm.all(sql`SELECT COUNT(*) AS count FROM __drizzle_migrations`)[0] as MigrationCountRow | undefined;
    const journalMode = String(this.db.pragma("journal_mode", { simple: true })).toLowerCase();
    this.orm.all(sql`SELECT 1`);
    this.orm.run(sql`CREATE TABLE IF NOT EXISTS health_write_probe (id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL)`);
    this.orm.run(sql`DROP TABLE health_write_probe`);
    return {
      walMode: journalMode === "wal",
      migrationVersion: Number(migrationRow?.count ?? 0),
      readable: true,
      writable: true,
    };
  }

  close(): void {
    this.db.close();
  }
}
