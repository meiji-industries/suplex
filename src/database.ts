import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { desc, eq } from "drizzle-orm";

import { workerRegistrations } from "./database-schema.js";
import { authSchema, type AuthSchema } from "./auth-schema.js";
import { canonicalJson } from "./canonical-json.js";
import { IssueProjectionEventSchema, IssueWorkflowStateSchema, type IssueProjectionEvent, type IssueWorkflowState } from "./engine/issue-contracts.js";
import { jsonRequired } from "./task-utils.js";

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
  runId?: string;
  projectRevisionId?: string;
  revision: number;
  phase: IssueWorkflowState["phase"];
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
export function projectionStateHash(state: unknown): string {
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}

export type SchemaState = "current" | "behind" | "ahead" | "partial" | "corrupt" | "locked" | "unavailable";

export interface ExpectedMigration {
  index: number;
  tag: string;
  hash: string;
  createdAt: number;
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

/**
 * Migration is opt-out for the server and worker, but diagnostics must choose
 * a non-migrating mode explicitly so observing a live database cannot change
 * it. A read-only connection also requires the database to already exist.
 */
export type ForgeDatabaseOpenOptions =
  | { migrate?: true; readOnly?: false }
  | { migrate: false; readOnly?: false }
  | { migrate?: false; readOnly: true };

export type ForgeDatabaseOpenMode = "migrate" | "read-write" | "read-only";

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

export class ProjectionPersistenceFailure extends Error {
  constructor(
    readonly code: "invalid-input" | "identity-mismatch" | "conflict" | "not-durable" | "write-failed",
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ProjectionPersistenceFailure";
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
      return existsSync(candidate) && readdirSync(candidate, { withFileTypes: true }).some((entry) => entry.isFile() && entry.name.endsWith(".sql"));
    } catch {
      return false;
    }
  });
  if (!folder) {
    throw new Error("Forge database migrations are not installed");
  }
  return folder;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const TIMESTAMPED_MIGRATION = /^(\d{14}(?:\d{3})?)_([a-z0-9][a-z0-9_]*)\.sql$/;

function migrationTimestamp(value: string): number {
  const milliseconds = value.length === 17 ? Number(value.slice(14, 17)) : 0;
  const timestamp = Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(4, 6)) - 1,
    Number(value.slice(6, 8)),
    Number(value.slice(8, 10)),
    Number(value.slice(10, 12)),
    Number(value.slice(12, 14)),
    milliseconds,
  );
  const normalized = new Date(timestamp).toISOString().replace(/\D/g, "").slice(0, value.length);
  if (normalized !== value) throw new Error(`Invalid migration timestamp: ${value}`);
  return timestamp;
}

export function readMigrations(folder: string): ExpectedMigration[] {
  const migrations = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => {
      const match = TIMESTAMPED_MIGRATION.exec(entry.name);
      if (!match) throw new Error(`Migration filenames must start with a UTC timestamp: ${entry.name}`);
      return {
        tag: entry.name.slice(0, -4),
        hash: fileSha256(`${folder}/${entry.name}`),
        createdAt: migrationTimestamp(match[1]!),
      };
    })
    .sort((left, right) => left.createdAt - right.createdAt || left.tag.localeCompare(right.tag));

  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1]!.createdAt === migrations[index]!.createdAt) {
      throw new Error(`Migration timestamps must be unique: ${migrations[index]!.tag}`);
    }
  }

  return migrations.map((migration, index) => ({ index, ...migration }));
}

const REBUILD_COPY_ALL = /^\s*INSERT\s+INTO\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s+SELECT\s+\*\s+FROM\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)[`"]?\s*;?\s*$/i;

function preserveAdditiveColumnsDuringRebuild(db: Database.Database, statement: string): void {
  const match = REBUILD_COPY_ALL.exec(statement);
  if (!match) return;
  const destination = match[1]!;
  const source = match[2]!;
  const destinationColumns = new Set((db.pragma(`table_info('${destination}')`) as Array<{ name: string }>).map((column) => column.name));
  const sourceColumns = db.pragma(`table_info('${source}')`) as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;
  for (const column of sourceColumns) {
    if (destinationColumns.has(column.name)) continue;
    if (column.pk || (column.notnull && column.dflt_value === null)) {
      throw new Error(`Cannot preserve required column ${source}.${column.name} during rebuild into ${destination}`);
    }
    const name = `"${column.name.replaceAll('"', '""')}"`;
    const type = column.type.trim();
    const defaultValue = column.dflt_value === null ? "" : ` DEFAULT ${column.dflt_value}`;
    db.exec(`ALTER TABLE "${destination}" ADD COLUMN ${name}${type ? ` ${type}` : ""}${column.notnull ? " NOT NULL" : ""}${defaultValue}`);
    destinationColumns.add(column.name);
  }
}

export function applyMigrations(db: Database.Database, folder: string): void {
  const migrations = readMigrations(folder);
  db.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at numeric
  )`);
  const insert = db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  if (foreignKeys) db.pragma("foreign_keys = OFF");
  // The applied set must be read inside the immediate (write-locked) transaction:
  // the server and worker start concurrently and open the same database file.
  try {
    db.transaction(() => {
      const applied = db.prepare("SELECT hash, created_at FROM __drizzle_migrations").all() as Array<{ hash: string; created_at: number }>;
      const appliedByTimestamp = new Map(applied.map((migration) => [migration.created_at, migration.hash]));

      // A migration's identity is its timestamp. Two migrations with identical SQL are legal,
      // so there is deliberately no hash→timestamp cross-check here.
      for (const migration of migrations) {
        const hashAtTimestamp = appliedByTimestamp.get(migration.createdAt);
        if (hashAtTimestamp !== undefined && hashAtTimestamp !== migration.hash) {
          throw new Error(`Applied migration timestamp has different SQL: ${migration.tag}`);
        }
      }

      for (const migration of migrations) {
        if (appliedByTimestamp.get(migration.createdAt) === migration.hash) continue;
        const sql = readFileSync(`${folder}/${migration.tag}.sql`, "utf8");
        for (const statement of sql.split("--> statement-breakpoint")) {
          if (statement.trim()) {
            preserveAdditiveColumnsDuringRebuild(db, statement);
            db.exec(statement);
          }
        }
        insert.run(migration.hash, migration.createdAt);
      }
    }).immediate();
  } finally {
    if (foreignKeys) db.pragma("foreign_keys = ON");
  }
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
  private readonly orm: BetterSQLite3Database<AuthSchema & { workerRegistrations: typeof workerRegistrations }>;
  private readonly mode: ForgeDatabaseOpenMode;

  constructor(filename: string, options: ForgeDatabaseOpenOptions = {}) {
    const readOnly = options.readOnly === true;
    const migrate = options.migrate ?? !readOnly;
    if (readOnly && migrate) throw new Error("A read-only database connection cannot run migrations");
    this.mode = readOnly ? "read-only" : migrate ? "migrate" : "read-write";
    if (migrate) mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename, readOnly ? { readonly: true } : migrate ? undefined : { fileMustExist: true });
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("recursive_triggers = ON");
    if (!readOnly) {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
    }
    this.orm = drizzle(this.db, { schema: { ...authSchema, workerRegistrations } });
    try {
      if (migrate) {
        this.ensureModelCatalog();
        this.preflightProjectRepositoryIdentities();
        applyMigrations(this.db, migrationFolder());
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  openMode(): ForgeDatabaseOpenMode {
    return this.mode;
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

  authImmediateTransaction<T>(operation: (database: Database.Database) => T): T {
    return this.db.transaction(() => operation(this.db)).immediate();
  }

  authOrm(): BetterSQLite3Database<AuthSchema> {
    return this.orm;
  }

  authQuery<T>(operation: (database: Database.Database) => T): T {
    return operation(this.db);
  }

  private projectionTransaction<T>(label: string, operation: () => T): T {
    try {
      return this.db.transaction(operation)();
    } catch (error) {
      if (error instanceof ProjectionPersistenceFailure) throw error;
      throw new ProjectionPersistenceFailure("write-failed", `${label} failed`, error);
    }
  }

  private applyIssueProjection(database: Database.Database, parsed: IssueWorkflowState, updatedAt: string, runId: string): boolean {
    const stateHash = projectionStateHash(parsed);
    this.normalizeLegacyInitialProjection(database, parsed, stateHash, runId);
    const eventType = parsed.phase === "backlog" ? "task_created" : parsed.phase === "planning" ? "planning_started" : `phase_${parsed.phase}`;
    const task = database.prepare("SELECT company_id, project_id, workflow_id FROM forge_tasks WHERE id = ?").get(parsed.issueId) as { company_id: string; project_id: string; workflow_id: string } | undefined;
    if (!task || task.company_id !== parsed.companyId || task.project_id !== parsed.projectId || task.workflow_id !== parsed.workflowId) {
      throw new ProjectionPersistenceFailure("identity-mismatch", "Workflow projection task identity does not match");
    }
    const eventById = database.prepare("SELECT task_id, company_id, workflow_id, run_id, revision, source, event_type, event_hash FROM forge_issue_timeline WHERE id = ?").get(parsed.lastEventId) as { task_id: string; company_id: string; workflow_id: string; run_id: string | null; revision: number; source: string; event_type: string; event_hash: string } | undefined;
    const eventByRevision = database.prepare("SELECT id, task_id, company_id, run_id, event_type, event_hash FROM forge_issue_timeline WHERE workflow_id = ? AND revision = ? AND source = 'workflow' AND CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.stateHash') END IS NOT NULL").get(parsed.workflowId, parsed.revision) as { id: string; task_id: string; company_id: string; run_id: string | null; event_type: string; event_hash: string } | undefined;
    const snapshotByEventId = database.prepare("SELECT task_id, workflow_id, run_id, revision FROM forge_workflow_snapshots WHERE CASE WHEN json_valid(state_json) THEN json_extract(state_json, '$.lastEventId') END = ? LIMIT 1").get(parsed.lastEventId) as { task_id: string; workflow_id: string; run_id: string | null; revision: number } | undefined;
    const snapshot = database.prepare("SELECT company_id, workflow_id, run_id, state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = ?").get(parsed.issueId, parsed.revision) as { company_id: string; workflow_id: string; run_id: string | null; state_json: string } | undefined;
    const current = database.prepare("SELECT revision, event_hash, last_event_id, last_run_id FROM forge_issue_projections WHERE task_id = ?").get(parsed.issueId) as { revision: number; event_hash: string; last_event_id: string; last_run_id: string | null } | undefined;
    const commandReplay = !snapshot && !eventById
      ? database.prepare("SELECT result_json FROM forge_engine_commands WHERE workflow_id = ? AND CASE WHEN json_valid(result_json) THEN json_extract(result_json, '$.revision') END = ? AND CASE WHEN json_valid(result_json) THEN json_extract(result_json, '$.lastEventId') END = ?").all(parsed.workflowId, parsed.revision, parsed.lastEventId) as Array<{ result_json: string }>
      : [];
    const commandReplayMatches = commandReplay.some((row) => {
      let result: unknown;
      try { result = jsonRequired(row.result_json); } catch { return false; }
      const stored = IssueWorkflowStateSchema.safeParse(result);
      return stored.success && projectionStateHash(stored.data) === stateHash;
    });

    if (eventById && (eventById.source !== "workflow" || eventById.task_id !== parsed.issueId || eventById.company_id !== parsed.companyId || eventById.workflow_id !== parsed.workflowId || eventById.run_id !== runId || eventById.revision !== parsed.revision || eventById.event_type !== eventType || eventById.event_hash !== stateHash)) {
      throw new ProjectionPersistenceFailure("conflict", "Workflow projection event identity already has conflicting content");
    }
    if (eventByRevision && (eventByRevision.id !== parsed.lastEventId || eventByRevision.task_id !== parsed.issueId || eventByRevision.company_id !== parsed.companyId || eventByRevision.run_id !== runId || eventByRevision.event_type !== eventType || eventByRevision.event_hash !== stateHash)) {
      throw new ProjectionPersistenceFailure("conflict", "Workflow projection revision already has conflicting timeline content");
    }
    if (snapshotByEventId && (snapshotByEventId.task_id !== parsed.issueId || snapshotByEventId.workflow_id !== parsed.workflowId || snapshotByEventId.run_id !== runId || snapshotByEventId.revision !== parsed.revision)) {
      throw new ProjectionPersistenceFailure("conflict", "Workflow projection event identity already belongs to another snapshot");
    }

    let snapshotMatches = false;
    if (snapshot) {
      let stored: unknown;
      try { stored = jsonRequired(snapshot.state_json); } catch {
        throw new ProjectionPersistenceFailure("conflict", "Workflow projection revision has an unreadable snapshot");
      }
      const storedRecord = stored as Record<string, unknown>;
      const storedParsed = IssueWorkflowStateSchema.safeParse({ ...storedRecord, issueId: storedRecord.issueId ?? parsed.issueId, companyId: storedRecord.companyId ?? parsed.companyId, projectId: storedRecord.projectId ?? parsed.projectId, workflowId: storedRecord.workflowId ?? parsed.workflowId, projectRevisionId: storedRecord.projectRevisionId ?? parsed.projectRevisionId, owner: storedRecord.owner === "system" ? "human" : storedRecord.owner, continuationCount: storedRecord.continuationCount ?? 0, lastSummaryHash: storedRecord.lastSummaryHash ?? null });
      snapshotMatches = snapshot.company_id === parsed.companyId
        && snapshot.workflow_id === parsed.workflowId
        && snapshot.run_id === runId
        && storedParsed.success
        && projectionStateHash(storedParsed.data) === stateHash;
      if (!snapshotMatches) throw new ProjectionPersistenceFailure("conflict", "Workflow projection revision already has a conflicting snapshot");
    }
    if (current && current.revision > parsed.revision) {
      if (!snapshotMatches && !eventById && !commandReplayMatches) throw new ProjectionPersistenceFailure("conflict", "Workflow projection cannot reuse a pruned or unpersisted revision");
      return false;
    }
    if (current?.revision === parsed.revision && (current.event_hash !== stateHash || current.last_event_id !== parsed.lastEventId || current.last_run_id !== runId)) {
      throw new ProjectionPersistenceFailure("conflict", "Workflow projection revision already has conflicting latest state");
    }
    if ((!current && parsed.revision !== 0) || (current && parsed.revision > current.revision + 1)) {
      throw new ProjectionPersistenceFailure("conflict", "Workflow projection revision does not have the exact durable predecessor");
    }

    const priorPhase = database.prepare("SELECT json_extract(metadata_json, '$.phase') AS phase, json_extract(metadata_json, '$.pendingAction') AS pendingAction FROM forge_issue_timeline WHERE workflow_id = ? AND source = 'workflow' AND event_type LIKE 'phase_%' AND revision < ? ORDER BY revision DESC, stream_id DESC LIMIT 1").get(parsed.workflowId, parsed.revision) as { phase: string; pendingAction: string } | undefined;
    const recordsTransition = parsed.phase === "backlog" || priorPhase?.phase !== parsed.phase || priorPhase.pendingAction !== parsed.pendingAction;
    if (current?.revision === parsed.revision && snapshotMatches && (eventById || !recordsTransition)) return true;

    if (!eventById && !eventByRevision && recordsTransition) database.prepare(`INSERT INTO forge_issue_timeline (id, task_id, company_id, workflow_id, run_id, revision, source, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, ?, ?, 'workflow', ?, ?, ?, ?)`).run(parsed.lastEventId, parsed.issueId, parsed.companyId, parsed.workflowId, runId, parsed.revision, eventType, JSON.stringify({ revision: parsed.revision, phase: parsed.phase, pendingAction: parsed.pendingAction, stateHash }), updatedAt, stateHash);
    if (!snapshot) database.prepare(`INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, run_id, revision, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(parsed.issueId, parsed.companyId, parsed.workflowId, runId, parsed.revision, JSON.stringify(parsed), updatedAt);
    // Snapshots are a bounded history: keep revision 0 (the creation record) and the newest 50. A hot loop once grew one task to 2.7M rows.
    if (!current || current.revision < parsed.revision) database.prepare("DELETE FROM forge_workflow_snapshots WHERE task_id = ? AND revision > 0 AND revision <= ?").run(parsed.issueId, parsed.revision - 50);
    if (!current || current.revision < parsed.revision) {
      const projection = database.prepare(`INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, event_hash, projected_at, blocker_json, state_changed_at, projection_status, reconciled_at, last_run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET company_id = excluded.company_id, project_id = excluded.project_id, workflow_id = excluded.workflow_id, revision = excluded.revision, phase = excluded.phase, owner = excluded.owner, allowed_commands_json = excluded.allowed_commands_json, pending_action = excluded.pending_action, updated_at = excluded.updated_at, last_event_id = excluded.last_event_id, event_hash = excluded.event_hash, projected_at = excluded.projected_at, blocker_json = excluded.blocker_json, state_changed_at = excluded.state_changed_at, projection_status = excluded.projection_status, projection_status_message = NULL, reconciled_at = excluded.reconciled_at, last_run_id = excluded.last_run_id
        WHERE forge_issue_projections.revision = excluded.revision - 1
        `).run(
        parsed.issueId, parsed.companyId, parsed.projectId, parsed.workflowId, parsed.revision, parsed.phase, parsed.owner, JSON.stringify(parsed.allowedCommands), parsed.pendingAction, updatedAt, parsed.lastEventId, stateHash, updatedAt, parsed.blocker === undefined ? null : JSON.stringify(parsed.blocker), parsed.stateChangedAt ?? null, "current", updatedAt, runId,
      );
      if (projection.changes !== 1) throw new ProjectionPersistenceFailure("conflict", "Workflow projection lost its expected-revision comparison");
    }
    if (parsed.phase === "done" && parsed.resultCommit && (parsed.pendingAction === "Done — kept in worktree" || parsed.pendingAction === "Done — branch pushed")) {
      database.prepare("UPDATE forge_tasks SET delivery_worktree_path = ?, delivery_branch_name = ?, delivery_commit = ?, updated_at = ? WHERE id = ? AND company_id = ?").run(parsed.worktreePath ?? null, parsed.branchName ?? null, parsed.resultCommit, updatedAt, parsed.issueId, parsed.companyId);
    }
    return true;
  }

  private applyIssueProjectionObservation(database: Database.Database, parsed: IssueWorkflowState, runId: string): void {
    const task = database.prepare("SELECT company_id, project_id, workflow_id FROM forge_tasks WHERE id = ?").get(parsed.issueId) as { company_id: string; project_id: string; workflow_id: string } | undefined;
    if (!task || task.company_id !== parsed.companyId || task.project_id !== parsed.projectId || task.workflow_id !== parsed.workflowId) {
      throw new ProjectionPersistenceFailure("identity-mismatch", "Workflow projection observation task identity does not match");
    }
    const stateHash = projectionStateHash(parsed);
    const current = database.prepare("SELECT revision, event_hash, last_event_id, last_run_id FROM forge_issue_projections WHERE task_id = ?").get(parsed.issueId) as { revision: number; event_hash: string; last_event_id: string; last_run_id: string | null } | undefined;
    if (!current
      || current.revision !== parsed.revision
      || current.event_hash !== stateHash
      || current.last_event_id !== parsed.lastEventId
      || current.last_run_id !== runId) {
      throw new ProjectionPersistenceFailure("not-durable", "Workflow projection observation has no matching durable projection");
    }
    database.prepare("UPDATE forge_issue_projections SET authoritative_revision = ?, authoritative_event_hash = ? WHERE task_id = ?").run(parsed.revision, stateHash, parsed.issueId);
  }

  private normalizeLegacyInitialProjection(database: Database.Database, parsed: IssueWorkflowState, stateHash: string, runId: string): void {
    if (parsed.revision !== 0 || parsed.phase !== "backlog" || parsed.repairCycle !== 0) return;
    const snapshot = database.prepare("SELECT run_id, state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get(parsed.issueId) as { run_id: string | null; state_json: string } | undefined;
    if (!snapshot || (snapshot.run_id !== null && snapshot.run_id !== "legacy-unknown" && snapshot.run_id !== runId)) return;
    let stored: unknown;
    try { stored = jsonRequired(snapshot.state_json); } catch { return; }
    if (!stored || typeof stored !== "object") return;
    const legacy = stored as Record<string, unknown>;
    const canonical = IssueWorkflowStateSchema.safeParse(legacy);
    if (canonical.success) {
      const normalizedStored = IssueWorkflowStateSchema.parse({ ...canonical.data, stateChangedAt: parsed.stateChangedAt });
      if (projectionStateHash(normalizedStored) !== stateHash) return;
      const storedHash = projectionStateHash(canonical.data);
      const timeline = database.prepare("SELECT run_id, event_hash FROM forge_issue_timeline WHERE id = ? AND workflow_id = ? AND revision = 0 AND source = 'workflow'").get(parsed.lastEventId, parsed.workflowId) as { run_id: string | null; event_hash: string } | undefined;
      if (!timeline || (timeline.run_id !== null && timeline.run_id !== "legacy-unknown" && timeline.run_id !== runId) || timeline.event_hash !== storedHash) return;
      if (storedHash === stateHash && snapshot.run_id === runId && timeline.run_id === runId) return;
      const current = database.prepare("SELECT revision, event_hash, authoritative_event_hash, last_run_id FROM forge_issue_projections WHERE task_id = ?").get(parsed.issueId) as { revision: number; event_hash: string; authoritative_event_hash: string; last_run_id: string | null } | undefined;
      if (current?.revision === 0 && ((current.last_run_id !== null && current.last_run_id !== "legacy-unknown" && current.last_run_id !== runId) || (current.event_hash !== storedHash && current.event_hash !== stateHash))) return;
      database.prepare("UPDATE forge_workflow_snapshots SET run_id = ?, state_json = ? WHERE task_id = ? AND revision = 0 AND (run_id IS NULL OR run_id = 'legacy-unknown' OR run_id = ?) AND state_json = ?").run(runId, JSON.stringify(parsed), parsed.issueId, runId, snapshot.state_json);
      database.prepare("UPDATE forge_issue_timeline SET run_id = ?, event_hash = ?, metadata_json = ? WHERE id = ? AND workflow_id = ? AND revision = 0 AND source = 'workflow' AND (run_id IS NULL OR run_id = 'legacy-unknown' OR run_id = ?) AND event_hash = ?").run(runId, stateHash, JSON.stringify({ revision: 0, phase: parsed.phase, stateHash }), parsed.lastEventId, parsed.workflowId, runId, storedHash);
      if (current?.revision === 0) database.prepare("UPDATE forge_issue_projections SET last_run_id = ?, event_hash = ?, authoritative_event_hash = CASE WHEN authoritative_event_hash = ? THEN ? ELSE authoritative_event_hash END WHERE task_id = ? AND revision = 0 AND (last_run_id IS NULL OR last_run_id = 'legacy-unknown' OR last_run_id = ?) AND event_hash = ?").run(runId, stateHash, storedHash, stateHash, parsed.issueId, runId, storedHash);
      return;
    }
    if (legacy.issueId !== undefined || legacy.taskId !== parsed.issueId || legacy.repairCycle !== undefined) return;
    const normalized = IssueWorkflowStateSchema.safeParse({ ...legacy, taskId: undefined, issueId: parsed.issueId, repairCycle: 0 });
    if (!normalized.success || projectionStateHash(normalized.data) !== stateHash) return;

    const legacyHash = projectionStateHash(legacy);
    const timeline = database.prepare("SELECT run_id, event_hash FROM forge_issue_timeline WHERE id = ? AND workflow_id = ? AND revision = 0 AND source = 'workflow'").get(parsed.lastEventId, parsed.workflowId) as { run_id: string | null; event_hash: string } | undefined;
    if (!timeline || (timeline.run_id !== null && timeline.run_id !== "legacy-unknown" && timeline.run_id !== runId) || timeline.event_hash !== legacyHash) return;
    const current = database.prepare("SELECT revision, event_hash, authoritative_event_hash, last_run_id FROM forge_issue_projections WHERE task_id = ?").get(parsed.issueId) as { revision: number; event_hash: string; authoritative_event_hash: string; last_run_id: string | null } | undefined;
    if (current?.revision === 0 && ((current.last_run_id !== null && current.last_run_id !== "legacy-unknown" && current.last_run_id !== runId) || (current.event_hash !== legacyHash && current.event_hash !== stateHash))) return;

    database.prepare("UPDATE forge_workflow_snapshots SET run_id = ?, state_json = ? WHERE task_id = ? AND revision = 0 AND (run_id IS NULL OR run_id = 'legacy-unknown' OR run_id = ?) AND state_json = ?").run(runId, JSON.stringify(parsed), parsed.issueId, runId, snapshot.state_json);
    database.prepare("UPDATE forge_issue_timeline SET run_id = ?, event_hash = ?, metadata_json = ? WHERE id = ? AND workflow_id = ? AND revision = 0 AND source = 'workflow' AND (run_id IS NULL OR run_id = 'legacy-unknown' OR run_id = ?) AND event_hash = ?").run(runId, stateHash, JSON.stringify({ revision: 0, phase: parsed.phase, stateHash }), parsed.lastEventId, parsed.workflowId, runId, legacyHash);
    if (current?.revision === 0) {
      database.prepare("UPDATE forge_issue_projections SET last_run_id = ?, event_hash = ?, authoritative_event_hash = CASE WHEN authoritative_event_hash = ? THEN ? ELSE authoritative_event_hash END WHERE task_id = ? AND revision = 0 AND (last_run_id IS NULL OR last_run_id = 'legacy-unknown' OR last_run_id = ?) AND event_hash = ?").run(runId, stateHash, legacyHash, stateHash, parsed.issueId, runId, legacyHash);
    }
  }

  observeIssueProjection(event: IssueProjectionEvent): void {
    const validated = IssueProjectionEventSchema.safeParse(event);
    if (!validated.success) {
      throw new ProjectionPersistenceFailure("invalid-input", "Workflow projection observation failed schema validation", validated.error);
    }
    this.projectionTransaction("Workflow projection observation", () => {
      this.applyIssueProjectionObservation(this.db, validated.data.state, validated.data.runId);
    });
  }

  projectIssueEvent(event: IssueProjectionEvent): void {
    const validated = IssueProjectionEventSchema.safeParse(event);
    if (!validated.success) {
      throw new ProjectionPersistenceFailure("invalid-input", "Workflow projection event failed schema validation", validated.error);
    }
    this.projectionTransaction("Workflow projection event write", () => {
      if (this.applyIssueProjection(this.db, validated.data.state, new Date().toISOString(), validated.data.runId)) {
        this.applyIssueProjectionObservation(this.db, validated.data.state, validated.data.runId);
      }
    });
  }

  bootstrapIssueProjection(event: IssueProjectionEvent): void {
    const validated = IssueProjectionEventSchema.safeParse(event);
    if (!validated.success) throw new ProjectionPersistenceFailure("invalid-input", "Workflow projection bootstrap failed schema validation", validated.error);
    this.projectionTransaction("Workflow projection bootstrap", () => {
      this.db.prepare("UPDATE forge_workflow_snapshots SET run_id = ? WHERE task_id = ? AND revision = ? AND (run_id IS NULL OR run_id = 'legacy-unknown')").run(validated.data.runId, validated.data.state.issueId, validated.data.state.revision);
      if (this.applyIssueProjection(this.db, validated.data.state, new Date().toISOString(), validated.data.runId)) {
        this.applyIssueProjectionObservation(this.db, validated.data.state, validated.data.runId);
      }
    });
  }

  projectIssueEvents(events: IssueProjectionEvent[]): void {
    const validated: IssueProjectionEvent[] = [];
    for (const event of events) {
      const parsed = IssueProjectionEventSchema.safeParse(event);
      if (!parsed.success) throw new ProjectionPersistenceFailure("invalid-input", "Workflow projection batch failed schema validation", parsed.error);
      validated.push(parsed.data);
    }
    if (validated.length === 0) return;
    this.projectionTransaction("Workflow projection batch write", () => {
      const updatedAt = new Date().toISOString();
      for (const event of validated) {
        if (this.applyIssueProjection(this.db, event.state, updatedAt, event.runId)) this.applyIssueProjectionObservation(this.db, event.state, event.runId);
      }
    });
  }

  commitIssueCommand(input: { commandId: string; workflowId: string; runId: string; command: string; result: IssueWorkflowState; events: IssueProjectionEvent[]; createdAt: string }): IssueWorkflowState {
    const result = IssueWorkflowStateSchema.safeParse(input.result);
    if (!result.success) throw new ProjectionPersistenceFailure("invalid-input", "Issue command result failed schema validation", result.error);
    const validatedEvents: IssueProjectionEvent[] = [];
    for (const event of input.events) {
      const parsed = IssueProjectionEventSchema.safeParse(event);
      if (!parsed.success) throw new ProjectionPersistenceFailure("invalid-input", "Issue command projection failed schema validation", parsed.error);
      validatedEvents.push(parsed.data);
    }
    if (result.data.workflowId !== input.workflowId || validatedEvents.some((event) => event.runId !== input.runId || event.state.workflowId !== input.workflowId)) {
      throw new ProjectionPersistenceFailure("identity-mismatch", "Issue command projection identity does not match");
    }
    const lastEvent = validatedEvents.at(-1);
    if (lastEvent && projectionStateHash(lastEvent.state) !== projectionStateHash(result.data)) {
      throw new ProjectionPersistenceFailure("identity-mismatch", "Issue command result does not match its final projection");
    }

    return this.projectionTransaction("Issue command commit", () => {
      const existing = this.db.prepare("SELECT workflow_id, command, result_json FROM forge_engine_commands WHERE command_id = ?").get(input.commandId) as { workflow_id: string; command: string; result_json: string } | undefined;
      if (existing) {
        let stored: unknown;
        try { stored = jsonRequired(existing.result_json); } catch {
          throw new ProjectionPersistenceFailure("conflict", "Issue command identity has an unreadable receipt");
        }
        const parsed = IssueWorkflowStateSchema.safeParse(stored);
        if (existing.workflow_id === input.workflowId && existing.command === input.command && parsed.success) return parsed.data;
        throw new ProjectionPersistenceFailure("conflict", "Issue command identity already has a conflicting receipt");
      }

      for (const event of validatedEvents) {
        if (this.applyIssueProjection(this.db, event.state, input.createdAt, event.runId)) this.applyIssueProjectionObservation(this.db, event.state, event.runId);
      }
      const current = this.db.prepare("SELECT revision, event_hash, last_event_id FROM forge_issue_projections WHERE workflow_id = ?").get(input.workflowId) as { revision: number; event_hash: string; last_event_id: string } | undefined;
      if (!current || current.revision !== result.data.revision || current.last_event_id !== result.data.lastEventId || current.event_hash !== projectionStateHash(result.data)) {
        throw new ProjectionPersistenceFailure("not-durable", "Issue command result has no matching authoritative projection");
      }
      const receipt = this.db.prepare("INSERT INTO forge_engine_commands (command_id, workflow_id, command, result_json, created_at) VALUES (?, ?, ?, ?, ?)").run(input.commandId, input.workflowId, input.command, JSON.stringify(result.data), input.createdAt);
      if (receipt.changes !== 1) throw new ProjectionPersistenceFailure("write-failed", "Issue command receipt was not persisted");
      return result.data;
    });
  }

  projectIssueState(state: IssueProjectionRecord): void {
    if (state.state && (
      (state.state.issueId !== undefined && state.state.issueId !== state.taskId)
      || (state.state.companyId !== undefined && state.state.companyId !== state.companyId)
      || (state.state.projectId !== undefined && state.state.projectId !== state.projectId)
      || (state.state.workflowId !== undefined && state.state.workflowId !== state.workflowId)
      || (state.state.revision !== undefined && state.state.revision !== state.revision)
      || (state.state.lastEventId !== undefined && state.state.lastEventId !== state.lastEventId)
    )) {
      throw new ProjectionPersistenceFailure("identity-mismatch", "Workflow state projection identity does not match its state");
    }
    const parsed = IssueWorkflowStateSchema.safeParse({
      ...(state.state ?? {}),
      issueId: state.taskId,
      companyId: state.companyId,
      projectId: state.projectId,
      workflowId: state.workflowId,
      revision: state.revision,
      phase: state.phase,
      owner: state.owner,
      allowedCommands: state.allowedCommands,
      pendingAction: state.pendingAction,
      lastEventId: state.lastEventId,
      ...(state.projectRevisionId ? { projectRevisionId: state.projectRevisionId } : {}),
    });
    if (!parsed.success) {
      throw new ProjectionPersistenceFailure("invalid-input", "Workflow state projection failed schema validation", parsed.error);
    }
    const runId = state.runId ?? parsed.data.workflowId;
    this.projectionTransaction("Workflow state projection write", () => {
      if (this.applyIssueProjection(this.db, parsed.data, new Date().toISOString(), runId)) {
        this.applyIssueProjectionObservation(this.db, parsed.data, runId);
      }
    });
  }

  replaceIssueProjectionFromEvents(taskId: string, events: IssueProjectionEvent[]): void {
    const validated: IssueProjectionEvent[] = [];
    for (const event of events) {
      const parsed = IssueProjectionEventSchema.safeParse(event);
      if (!parsed.success) {
        throw new ProjectionPersistenceFailure("invalid-input", "Projection rebuild event failed schema validation", parsed.error);
      }
      validated.push(parsed.data);
    }
    if (validated.length === 0) {
      throw new ProjectionPersistenceFailure("invalid-input", "Projection rebuild requires at least one event");
    }
    if (validated.some((event) => event.state.issueId !== taskId)) {
      throw new ProjectionPersistenceFailure("identity-mismatch", "Projection rebuild task identity does not match");
    }
    validated.sort((left, right) => left.state.revision - right.state.revision);
    this.projectionTransaction("Projection rebuild write", () => {
      for (const event of validated) {
        if (this.applyIssueProjection(this.db, event.state, new Date().toISOString(), event.runId)) {
          this.applyIssueProjectionObservation(this.db, event.state, event.runId);
        }
      }
    });
  }

  schemaStatus(): SchemaStatus {
    const folder = migrationFolder();
    const expected = readMigrations(folder);
    const journalMode = String(this.db.pragma("journal_mode", { simple: true })).toLowerCase();
    const walMode = journalMode === "wal";

    const migrationsTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get();
    const appliedRows = migrationsTable
      ? this.db.prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC, hash ASC").all() as Array<{ hash: string; created_at: number }>
      : [];
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
