import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { desc, eq } from "drizzle-orm";

import { probeWorkflows, workerRegistrations } from "./database-schema.js";
import { authSchema, type AuthSchema } from "./auth-schema.js";
import { IssueWorkflowStateSchema, type IssueWorkflowState } from "./temporal/issue-contracts.js";

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
  projectRevisionId?: string;
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

export class ProjectionIntegrityFailure extends Error {
  readonly code = "projection_integrity_failure" as const;
  readonly taskId: string | undefined;
  readonly revision: number | undefined;

  constructor(message: string, details: { taskId?: string; revision?: number } = {}) {
    super(message);
    this.name = "ProjectionIntegrityFailure";
    this.taskId = details.taskId;
    this.revision = details.revision;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function projectionStateHash(state: unknown): string {
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}

export type SchemaState = "current" | "behind" | "ahead" | "partial" | "corrupt" | "locked" | "unavailable";

export interface ExpectedMigration {
  index: number;
  tag: string;
  hash: string;
}

export interface AppliedMigration {
  hash: string;
  createdAt: number;
}

export interface SchemaStatus {
  state: SchemaState;
  expected: ExpectedMigration[];
  applied: AppliedMigration[];
  walMode: boolean;
  reason?: string;
}

export interface DatabaseHealth {
  walMode: boolean;
  schemaState: SchemaState;
  expectedMigrations: number;
  appliedMigrations: number;
  readable: boolean;
  writable: boolean;
}

export interface RepositoryIdentityCollision {
  projectId: string;
  companyId: string;
  repositoryIdentity: string;
}

export class DatabaseMigrationFailure extends Error {
  readonly code = "repository_identity_collision" as const;
  readonly collisions: RepositoryIdentityCollision[];

  constructor(collisions: RepositoryIdentityCollision[]) {
    super("Project repository identities must be unique before migrations can continue");
    this.name = "DatabaseMigrationFailure";
    this.collisions = collisions;
  }
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

interface JournalFile {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; tag: string }>;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function expectedMigrationsFromJournal(folder: string): ExpectedMigration[] {
  const journal: JournalFile = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as JournalFile;
  return journal.entries.map((entry) => ({
    index: entry.idx,
    tag: entry.tag,
    hash: fileSha256(`${folder}/${entry.tag}.sql`),
  }));
}

function isCleanPrefix(expected: ExpectedMigration[], applied: AppliedMigration[]): boolean {
  const limit = Math.min(expected.length, applied.length);
  for (let i = 0; i < limit; i += 1) {
    if (applied[i]!.hash !== expected[i]!.hash) {
      return false;
    }
  }
  return true;
}

function determineSchemaState(expected: ExpectedMigration[], applied: AppliedMigration[]): SchemaState {
  if (applied.length === 0 && expected.length > 0) {
    return "behind";
  }
  if (isCleanPrefix(expected, applied)) {
    if (applied.length === expected.length) return "current";
    if (applied.length < expected.length) return "behind";
    return "ahead";
  }

  const expectedHashes = new Set(expected.map((migration) => migration.hash));
  const allAppliedKnown = applied.every((migration) => expectedHashes.has(migration.hash));
  if (allAppliedKnown) {
    return "partial";
  }

  return applied.length > expected.length ? "ahead" : "corrupt";
}

export class ForgeDatabase {
  private readonly db: Database.Database;
  private readonly orm: BetterSQLite3Database<AuthSchema & { probeWorkflows: typeof probeWorkflows; workerRegistrations: typeof workerRegistrations }>;

  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.orm = drizzle(this.db, { schema: { ...authSchema, probeWorkflows, workerRegistrations } });
    try {
      this.preflightProjectRepositoryIdentities();
      migrate(this.orm, { migrationsFolder: migrationFolder() });
      this.ensureModelCatalog();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private ensureModelCatalog(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS forge_models (
      model_id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS forge_models_status_order_idx ON forge_models (status, sort_order, model_id);`);
    const seed = this.db.prepare("INSERT OR IGNORE INTO forge_models (model_id, display_name, description, status, sort_order, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)");
    const timestamp = "2026-08-11T00:00:00.000Z";
    this.db.transaction(() => {
      seed.run("gpt-5.6-sol", "GPT-5.6 Sol", "Frontier model for complex coding and agentic work.", 10, timestamp, timestamp);
      seed.run("gpt-5.6-terra", "GPT-5.6 Terra", "Balanced model for everyday coding work.", 20, timestamp, timestamp);
      seed.run("gpt-5.6-luna", "GPT-5.6 Luna", "Fast, cost-efficient model for routine coding work.", 30, timestamp, timestamp);
      seed.run("gpt-5.3-codex", "GPT-5.3 Codex", "Previous-generation Codex model retained for compatibility.", 40, timestamp, timestamp);
    })();
  }

  private preflightProjectRepositoryIdentities(): void {
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'forge_projects'").get() as { name: string } | undefined;
    if (!table) return;

    const rows = this.db.prepare("SELECT id, company_id, repository_identity FROM forge_projects WHERE repository_identity IS NOT NULL").all() as Array<{ id: string; company_id: string; repository_identity: string }>;
    const normalized = rows.map((row) => ({ ...row, repository_identity: row.repository_identity.trim().toLowerCase() }));
    const byIdentity = new Map<string, RepositoryIdentityCollision[]>();
    for (const row of normalized) {
      const collision = { projectId: row.id, companyId: row.company_id, repositoryIdentity: row.repository_identity } satisfies RepositoryIdentityCollision;
      const entries = byIdentity.get(row.repository_identity) ?? [];
      entries.push(collision);
      byIdentity.set(row.repository_identity, entries);
    }
    const collisions = [...byIdentity.values()].filter((entries) => entries.length > 1).flat().sort((left, right) => left.repositoryIdentity.localeCompare(right.repositoryIdentity) || left.projectId.localeCompare(right.projectId));
    if (collisions.length) throw new DatabaseMigrationFailure(collisions);

    this.db.transaction(() => {
      for (const row of normalized) {
        this.db.prepare("UPDATE forge_projects SET repository_identity = ? WHERE id = ? AND repository_identity IS NOT NULL").run(row.repository_identity, row.id);
      }
    })();
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

  authOrm(): BetterSQLite3Database<AuthSchema> {
    return this.orm;
  }

  authQuery<T>(operation: (database: Database.Database) => T): T {
    return operation(this.db);
  }

  private validatedProjectionState(state: IssueProjectionRecord): IssueWorkflowState {
    const candidate = state.state ? {
      ...(state.state as Record<string, unknown>),
      issueId: (state.state as Record<string, unknown>).issueId ?? state.taskId,
      taskId: undefined,
      companyId: (state.state as Record<string, unknown>).companyId ?? state.companyId,
      projectId: (state.state as Record<string, unknown>).projectId ?? state.projectId,
      workflowId: (state.state as Record<string, unknown>).workflowId ?? state.workflowId,
      projectRevisionId: (state.state as Record<string, unknown>).projectRevisionId ?? state.projectRevisionId ?? "projection-legacy",
      continuationCount: (state.state as Record<string, unknown>).continuationCount ?? 0,
      lastSummaryHash: (state.state as Record<string, unknown>).lastSummaryHash ?? null,
    } : {
      workflowId: state.workflowId,
      companyId: state.companyId,
      projectId: state.projectId,
      issueId: state.taskId,
      projectRevisionId: state.projectRevisionId ?? "projection-legacy",
      revision: state.revision,
      phase: state.phase,
      owner: state.owner,
      allowedCommands: state.allowedCommands,
      pendingAction: state.pendingAction,
      lastEventId: state.lastEventId,
      continuationCount: 0,
      lastSummaryHash: null,
      ...(state.planRevision !== undefined ? { planRevision: state.planRevision } : {}),
      ...(state.planMaterial !== undefined ? { planMaterial: state.planMaterial } : {}),
      ...(state.materialCategories !== undefined ? { materialCategories: state.materialCategories } : {}),
      ...(state.supplementalReviewUsed !== undefined ? { supplementalReviewUsed: state.supplementalReviewUsed } : {}),
      ...(state.supplementalReviewArtifactId !== undefined ? { supplementalReviewArtifactId: state.supplementalReviewArtifactId } : {}),
      ...(state.decisionId !== undefined ? { decisionId: state.decisionId } : {}),
    };
    let parsed: IssueWorkflowState;
    try {
      parsed = IssueWorkflowStateSchema.parse(candidate);
    } catch {
      throw new ProjectionIntegrityFailure("Workflow projection state failed schema validation", { taskId: state.taskId, revision: state.revision });
    }
    if (parsed.workflowId !== state.workflowId || parsed.companyId !== state.companyId || parsed.projectId !== state.projectId || parsed.issueId !== state.taskId || parsed.revision !== state.revision || parsed.lastEventId !== state.lastEventId) {
      throw new ProjectionIntegrityFailure("Workflow projection identity does not match its envelope", { taskId: state.taskId, revision: state.revision });
    }
    return parsed;
  }

  private applyIssueProjection(database: Database.Database, parsed: IssueWorkflowState, updatedAt: string): void {
    const stateHash = projectionStateHash(parsed);
    const eventType = parsed.phase === "backlog" ? "task_created" : parsed.phase === "planning" ? "planning_started" : `phase_${parsed.phase}`;
    const eventById = database.prepare("SELECT revision, event_hash FROM forge_issue_timeline WHERE id = ? AND workflow_id = ?").get(parsed.lastEventId, parsed.workflowId) as { revision: number; event_hash: string } | undefined;
    if (eventById && eventById.event_hash && eventById.event_hash !== stateHash) throw new ProjectionIntegrityFailure("Projection event identity was reused with a different state", { taskId: parsed.issueId, revision: parsed.revision });
    const eventByRevision = database.prepare("SELECT id, event_hash FROM forge_issue_timeline WHERE workflow_id = ? AND revision = ?").get(parsed.workflowId, parsed.revision) as { id: string; event_hash: string } | undefined;
    if (eventByRevision && eventByRevision.event_hash && eventByRevision.event_hash !== stateHash) throw new ProjectionIntegrityFailure("Projection revision was reused with a different state", { taskId: parsed.issueId, revision: parsed.revision });
    if (!eventById && !eventByRevision) {
      database.prepare(`INSERT INTO forge_issue_timeline (id, task_id, company_id, workflow_id, revision, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(parsed.lastEventId, parsed.issueId, parsed.companyId, parsed.workflowId, parsed.revision, eventType, JSON.stringify({ revision: parsed.revision, phase: parsed.phase, stateHash }), updatedAt, stateHash);
    }

    const current = database.prepare("SELECT revision, event_hash FROM forge_issue_projections WHERE task_id = ?").get(parsed.issueId) as { revision: number; event_hash: string } | undefined;
    if (current && current.revision > parsed.revision) return;
    if (current && current.revision === parsed.revision && current.event_hash !== stateHash) throw new ProjectionIntegrityFailure("Projection revision was overwritten with a different state", { taskId: parsed.issueId, revision: parsed.revision });

    const snapshot = database.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = ?").get(parsed.issueId, parsed.revision) as { state_json: string } | undefined;
    if (snapshot) {
      let stored: unknown;
      try { stored = JSON.parse(snapshot.state_json); } catch { throw new ProjectionIntegrityFailure("Authoritative workflow snapshot is not valid JSON", { taskId: parsed.issueId, revision: parsed.revision }); }
      const storedRecord = stored as Record<string, unknown>;
      const storedParsed = IssueWorkflowStateSchema.safeParse({ ...storedRecord, issueId: storedRecord.issueId ?? parsed.issueId, companyId: storedRecord.companyId ?? parsed.companyId, projectId: storedRecord.projectId ?? parsed.projectId, workflowId: storedRecord.workflowId ?? parsed.workflowId, projectRevisionId: storedRecord.projectRevisionId ?? parsed.projectRevisionId, owner: storedRecord.owner === "system" ? "human" : storedRecord.owner, continuationCount: storedRecord.continuationCount ?? 0, lastSummaryHash: storedRecord.lastSummaryHash ?? null });
      if (!storedParsed.success || projectionStateHash(storedParsed.data) !== stateHash) throw new ProjectionIntegrityFailure("Authoritative workflow snapshot was overwritten with a different state", { taskId: parsed.issueId, revision: parsed.revision });
    }
    if (!snapshot) database.prepare(`INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, revision, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(parsed.issueId, parsed.companyId, parsed.workflowId, parsed.revision, JSON.stringify(parsed), updatedAt);
    if (current && current.revision === parsed.revision && current.event_hash === stateHash) return;

    database.prepare(`INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, event_hash, authoritative_revision, projected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET company_id = excluded.company_id, project_id = excluded.project_id, workflow_id = excluded.workflow_id, revision = excluded.revision, phase = excluded.phase, owner = excluded.owner, allowed_commands_json = excluded.allowed_commands_json, pending_action = excluded.pending_action, updated_at = excluded.updated_at, last_event_id = excluded.last_event_id, event_hash = excluded.event_hash, authoritative_revision = excluded.authoritative_revision, projected_at = excluded.projected_at
      WHERE forge_issue_projections.revision < excluded.revision`).run(
      parsed.issueId, parsed.companyId, parsed.projectId, parsed.workflowId, parsed.revision, parsed.phase, parsed.owner, JSON.stringify(parsed.allowedCommands), parsed.pendingAction, updatedAt, parsed.lastEventId, stateHash, parsed.revision, updatedAt,
    );
    database.prepare(`INSERT INTO forge_issue_governance (task_id, company_id, plan_revision, plan_material, material_categories_json, supplemental_review_used, supplemental_review_artifact_id, decision_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET company_id = excluded.company_id, plan_revision = excluded.plan_revision, plan_material = excluded.plan_material, material_categories_json = excluded.material_categories_json, supplemental_review_used = excluded.supplemental_review_used, supplemental_review_artifact_id = excluded.supplemental_review_artifact_id, decision_id = excluded.decision_id`).run(
      parsed.issueId, parsed.companyId, parsed.planRevision ?? null, parsed.planMaterial === undefined || parsed.planMaterial === null ? null : parsed.planMaterial ? 1 : 0, JSON.stringify(parsed.materialCategories ?? []), parsed.supplementalReviewUsed ? 1 : 0, parsed.supplementalReviewArtifactId ?? null, parsed.decisionId ?? null,
    );
  }

  projectIssueState(state: IssueProjectionRecord): void {
    this.db.transaction(() => {
      const updatedAt = new Date().toISOString();
      const parsed = this.validatedProjectionState(state);
      this.applyIssueProjection(this.db, parsed, updatedAt);
    })();
  }

  rebuildIssueProjections(taskId?: string): number {
    return this.db.transaction(() => {
      const snapshots = (taskId
        ? this.db.prepare("SELECT task_id, company_id, workflow_id, revision, state_json, updated_at FROM forge_workflow_snapshots WHERE task_id = ? ORDER BY task_id, revision").all(taskId)
        : this.db.prepare("SELECT task_id, company_id, workflow_id, revision, state_json, updated_at FROM forge_workflow_snapshots ORDER BY task_id, revision").all()) as Array<{ task_id: string; company_id: string; workflow_id: string; revision: number; state_json: string; updated_at: string }>;
      const parsedSnapshots = snapshots.map((snapshot) => {
        let raw: unknown;
        try { raw = JSON.parse(snapshot.state_json); } catch { throw new ProjectionIntegrityFailure("Stored workflow snapshot is not valid JSON", { taskId: snapshot.task_id, revision: snapshot.revision }); }
        const legacyOwner = String((raw as Record<string, unknown>).owner ?? "human") === "system" ? "human" : String((raw as Record<string, unknown>).owner ?? "human");
        const parsed = this.validatedProjectionState({ taskId: snapshot.task_id, companyId: snapshot.company_id, projectId: String((raw as Record<string, unknown>).projectId ?? ""), workflowId: snapshot.workflow_id, revision: snapshot.revision, phase: String((raw as Record<string, unknown>).phase ?? "failed") as IssueProjectionRecord["phase"], owner: legacyOwner as IssueProjectionRecord["owner"], allowedCommands: Array.isArray((raw as Record<string, unknown>).allowedCommands) ? (raw as Record<string, unknown>).allowedCommands as string[] : [], pendingAction: typeof (raw as Record<string, unknown>).pendingAction === "string" ? (raw as Record<string, unknown>).pendingAction as string : null, lastEventId: String((raw as Record<string, unknown>).lastEventId ?? `${snapshot.workflow_id}:${snapshot.revision}`), state: { ...(raw as Record<string, unknown>), taskId: undefined, issueId: (raw as Record<string, unknown>).issueId ?? snapshot.task_id, companyId: (raw as Record<string, unknown>).companyId ?? snapshot.company_id, workflowId: (raw as Record<string, unknown>).workflowId ?? snapshot.workflow_id, projectId: (raw as Record<string, unknown>).projectId ?? String((raw as Record<string, unknown>).projectId ?? ""), projectRevisionId: (raw as Record<string, unknown>).projectRevisionId ?? "projection-legacy", owner: legacyOwner } });
        if (parsed.revision !== snapshot.revision || parsed.workflowId !== snapshot.workflow_id || parsed.companyId !== snapshot.company_id) throw new ProjectionIntegrityFailure("Stored workflow snapshot envelope does not match its state", { taskId: snapshot.task_id, revision: snapshot.revision });
        return { snapshot, parsed };
      });
      const taskIds = [...new Set(parsedSnapshots.map(({ snapshot }) => snapshot.task_id))];
      for (const task of taskIds) {
        const row = this.db.prepare("SELECT company_id, workflow_id, project_id FROM forge_tasks WHERE id = ?").get(task) as { company_id: string; workflow_id: string; project_id: string } | undefined;
        const first = parsedSnapshots.find(({ snapshot }) => snapshot.task_id === task);
        if (!row || !first || row.company_id !== first.snapshot.company_id || row.workflow_id !== first.snapshot.workflow_id || row.project_id !== first.parsed.projectId) throw new ProjectionIntegrityFailure("Workflow snapshot crossed its task scope", { taskId: task });
      }
      for (const id of taskIds) {
        this.db.prepare("DELETE FROM forge_issue_projections WHERE task_id = ?").run(id);
        this.db.prepare("DELETE FROM forge_issue_governance WHERE task_id = ?").run(id);
      }
      for (const { snapshot, parsed } of parsedSnapshots) {
        this.applyIssueProjection(this.db, parsed, snapshot.updated_at);
      }
      return taskIds.length;
    })();
  }

  schemaStatus(): SchemaStatus {
    const folder = migrationFolder();
    const expected = expectedMigrationsFromJournal(folder);
    const journalMode = String(this.db.pragma("journal_mode", { simple: true })).toLowerCase();
    const walMode = journalMode === "wal";

    const appliedRows = this.db
      .prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC, hash ASC")
      .all() as Array<{ hash: string; created_at: number }>;
    const applied = appliedRows.map((row) => ({ hash: row.hash, createdAt: row.created_at }));

    return {
      state: determineSchemaState(expected, applied),
      expected,
      applied,
      walMode,
    };
  }

  health(): DatabaseHealth {
    let status: SchemaStatus;
    try {
      status = this.schemaStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const busy = (error as NodeJS.ErrnoException).code === "SQLITE_BUSY" || /database is locked|busy/i.test(message);
      return {
        walMode: false,
        schemaState: busy ? "locked" : "unavailable",
        expectedMigrations: 0,
        appliedMigrations: 0,
        readable: false,
        writable: false,
      };
    }

    try {
      this.db.prepare("CREATE TABLE IF NOT EXISTS health_write_probe (id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL)").run();
      this.db.prepare("DROP TABLE health_write_probe").run();
      return {
        walMode: status.walMode,
        schemaState: status.state,
        expectedMigrations: status.expected.length,
        appliedMigrations: status.applied.length,
        readable: true,
        writable: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const busy = (error as NodeJS.ErrnoException).code === "SQLITE_BUSY" || /database is locked|busy/i.test(message);
      return {
        walMode: status.walMode,
        schemaState: busy ? "locked" : status.state,
        expectedMigrations: status.expected.length,
        appliedMigrations: status.applied.length,
        readable: true,
        writable: false,
      };
    }
  }

  close(): void {
    this.db.close();
  }
}
