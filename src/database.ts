import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { desc, eq } from "drizzle-orm";

import { probeWorkflows, workerRegistrations } from "./database-schema.js";
import { authSchema, type AuthSchema } from "./auth-schema.js";
import { canonicalJson } from "./canonical-json.js";
import { IssueProjectionEventSchema, IssueWorkflowStateSchema, type IssueProjectionEvent, type IssueWorkflowState } from "./temporal/issue-contracts.js";
import { StructuredLogger } from "./logging.js";
import { jsonRequired } from "./task-utils.js";

const projectionLogger = new StructuredLogger();

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

export function applyMigrations(db: Database.Database, folder: string): void {
  const migrations = readMigrations(folder);
  db.exec(`CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at numeric
  )`);
  const insert = db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
  // The applied set must be read inside the immediate (write-locked) transaction:
  // the server and worker start concurrently and open the same database file.
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
        if (statement.trim()) db.exec(statement);
      }
      insert.run(migration.hash, migration.createdAt);
    }
  }).immediate();
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
    this.orm = drizzle(this.db, { schema: { ...authSchema, probeWorkflows, workerRegistrations } });
    try {
      if (migrate) {
        this.preflightProjectRepositoryIdentities();
        applyMigrations(this.db, migrationFolder());
        this.ensureModelCatalog();
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

  authImmediateTransaction<T>(operation: (database: Database.Database) => T): T {
    return this.db.transaction(() => operation(this.db)).immediate();
  }

  authOrm(): BetterSQLite3Database<AuthSchema> {
    return this.orm;
  }

  authQuery<T>(operation: (database: Database.Database) => T): T {
    return operation(this.db);
  }

  private applyIssueProjection(database: Database.Database, parsed: IssueWorkflowState, updatedAt: string, runId: string): void {
    const stateHash = projectionStateHash(parsed);
    this.normalizeLegacyInitialProjection(database, parsed, stateHash);
    const eventType = parsed.phase === "backlog" ? "task_created" : parsed.phase === "planning" ? "planning_started" : `phase_${parsed.phase}`;
    const task = database.prepare("SELECT company_id, project_id, workflow_id FROM forge_tasks WHERE id = ?").get(parsed.issueId) as { company_id: string; project_id: string; workflow_id: string } | undefined;
    if (!task || task.company_id !== parsed.companyId || task.project_id !== parsed.projectId || task.workflow_id !== parsed.workflowId) {
      projectionLogger.warn("Skipping projection with task identity that no longer matches");
      return;
    }
    let eventById = database.prepare("SELECT workflow_id, revision, event_hash FROM forge_issue_timeline WHERE id = ?").get(parsed.lastEventId) as { workflow_id: string; revision: number; event_hash: string } | undefined;
    let eventByRevision = database.prepare("SELECT id, event_hash FROM forge_issue_timeline WHERE workflow_id = ? AND revision = ?").get(parsed.workflowId, parsed.revision) as { id: string; event_hash: string } | undefined;
    let current = database.prepare("SELECT revision, event_hash, last_event_id, last_run_id, authoritative_revision, authoritative_event_hash FROM forge_issue_projections WHERE task_id = ?").get(parsed.issueId) as { revision: number; event_hash: string; last_event_id: string; last_run_id: string | null; authoritative_revision: number; authoritative_event_hash: string } | undefined;
    const identical = eventById?.workflow_id === parsed.workflowId
      && eventById.revision === parsed.revision
      && eventById.event_hash === stateHash
      && eventByRevision?.id === parsed.lastEventId
      && eventByRevision.event_hash === stateHash
      && current?.revision === parsed.revision
      && current.event_hash === stateHash
      && current.last_event_id === parsed.lastEventId
      && current.last_run_id === runId;
    if (identical) return;

    // Temporal resets re-issue revision and event identities. The workflow's
    // newest state is authoritative, so replace all bookkeeping from the
    // divergence point instead of treating a reused identity as corruption.
    if ((eventById && (eventById.workflow_id !== parsed.workflowId || eventById.revision !== parsed.revision || eventById.event_hash !== stateHash))
      || (eventByRevision && (eventByRevision.id !== parsed.lastEventId || eventByRevision.event_hash !== stateHash))
      || (current && (current.last_run_id !== runId || current.revision >= parsed.revision) && (current.event_hash !== stateHash || current.last_event_id !== parsed.lastEventId || current.last_run_id !== runId || current.revision !== parsed.revision))) {
      projectionLogger.info("Projection state overwritten for re-issued workflow revision");
      database.prepare("DELETE FROM forge_issue_timeline WHERE workflow_id = ? AND revision >= ?").run(parsed.workflowId, parsed.revision);
      database.prepare("DELETE FROM forge_workflow_snapshots WHERE task_id = ? AND revision >= ?").run(parsed.issueId, parsed.revision);
      database.prepare("DELETE FROM forge_issue_projections WHERE task_id = ? AND revision >= ?").run(parsed.issueId, parsed.revision);
      eventById = undefined;
      eventByRevision = undefined;
      current = database.prepare("SELECT revision, event_hash, last_event_id, last_run_id, authoritative_revision, authoritative_event_hash FROM forge_issue_projections WHERE task_id = ?").get(parsed.issueId) as { revision: number; event_hash: string; last_event_id: string; last_run_id: string | null; authoritative_revision: number; authoritative_event_hash: string } | undefined;
    }

    const snapshot = database.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = ?").get(parsed.issueId, parsed.revision) as { state_json: string } | undefined;
    if (snapshot) {
      let stored: unknown;
      try { stored = jsonRequired(snapshot.state_json); } catch {
        projectionLogger.warn("Replacing unreadable workflow projection snapshot");
        stored = null;
      }
      const storedRecord = stored as Record<string, unknown>;
      const storedParsed = IssueWorkflowStateSchema.safeParse({ ...storedRecord, issueId: storedRecord.issueId ?? parsed.issueId, companyId: storedRecord.companyId ?? parsed.companyId, projectId: storedRecord.projectId ?? parsed.projectId, workflowId: storedRecord.workflowId ?? parsed.workflowId, projectRevisionId: storedRecord.projectRevisionId ?? parsed.projectRevisionId, owner: storedRecord.owner === "system" ? "human" : storedRecord.owner, continuationCount: storedRecord.continuationCount ?? 0, lastSummaryHash: storedRecord.lastSummaryHash ?? null });
      if (!storedParsed.success || projectionStateHash(storedParsed.data) !== stateHash) {
        projectionLogger.info("Workflow snapshot overwritten for re-issued projection revision");
        database.prepare("UPDATE forge_workflow_snapshots SET company_id = ?, workflow_id = ?, run_id = ?, state_json = ?, updated_at = ? WHERE task_id = ? AND revision = ?").run(parsed.companyId, parsed.workflowId, runId, JSON.stringify(parsed), updatedAt, parsed.issueId, parsed.revision);
      }
    }
    if (!eventById && !eventByRevision) database.prepare(`INSERT INTO forge_issue_timeline (id, task_id, company_id, workflow_id, run_id, revision, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(parsed.lastEventId, parsed.issueId, parsed.companyId, parsed.workflowId, runId, parsed.revision, eventType, JSON.stringify({ revision: parsed.revision, phase: parsed.phase, stateHash }), updatedAt, stateHash);
    if (!snapshot) database.prepare(`INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, run_id, revision, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(parsed.issueId, parsed.companyId, parsed.workflowId, runId, parsed.revision, JSON.stringify(parsed), updatedAt);
    const authoritativeRevision = parsed.revision;
    const authoritativeEventHash = stateHash;
    const projectionStatus = "current";
    database.prepare(`INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, event_hash, authoritative_revision, authoritative_event_hash, projected_at, blocker_json, state_changed_at, projection_status, reconciled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET company_id = excluded.company_id, project_id = excluded.project_id, workflow_id = excluded.workflow_id, revision = excluded.revision, phase = excluded.phase, owner = excluded.owner, allowed_commands_json = excluded.allowed_commands_json, pending_action = excluded.pending_action, updated_at = excluded.updated_at, last_event_id = excluded.last_event_id, event_hash = excluded.event_hash, authoritative_revision = excluded.authoritative_revision, authoritative_event_hash = excluded.authoritative_event_hash, projected_at = excluded.projected_at, blocker_json = excluded.blocker_json, state_changed_at = excluded.state_changed_at, projection_status = excluded.projection_status, projection_status_message = NULL, reconciled_at = excluded.reconciled_at
      `).run(
      parsed.issueId, parsed.companyId, parsed.projectId, parsed.workflowId, parsed.revision, parsed.phase, parsed.owner, JSON.stringify(parsed.allowedCommands), parsed.pendingAction, updatedAt, parsed.lastEventId, stateHash, authoritativeRevision, authoritativeEventHash, updatedAt, parsed.blocker === undefined ? null : JSON.stringify(parsed.blocker), parsed.stateChangedAt ?? null, projectionStatus, updatedAt,
    );
    database.prepare("UPDATE forge_issue_projections SET last_run_id = ? WHERE task_id = ?").run(runId, parsed.issueId);
    if (parsed.phase === "done" && parsed.resultCommit && (parsed.pendingAction === "Done — kept in worktree" || parsed.pendingAction === "Done — branch pushed")) {
      database.prepare("UPDATE forge_tasks SET delivery_worktree_path = ?, delivery_branch_name = ?, delivery_commit = ?, updated_at = ? WHERE id = ? AND company_id = ?").run(parsed.worktreePath ?? null, parsed.branchName ?? null, parsed.resultCommit, updatedAt, parsed.issueId, parsed.companyId);
    }
  }

  private normalizeLegacyInitialProjection(database: Database.Database, parsed: IssueWorkflowState, stateHash: string): void {
    if (parsed.revision !== 0 || parsed.phase !== "backlog" || parsed.repairCycle !== 0) return;
    const snapshot = database.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get(parsed.issueId) as { state_json: string } | undefined;
    if (!snapshot) return;
    let stored: unknown;
    try { stored = jsonRequired(snapshot.state_json); } catch { return; }
    if (!stored || typeof stored !== "object") return;
    const legacy = stored as Record<string, unknown>;
    const canonical = IssueWorkflowStateSchema.safeParse(legacy);
    if (canonical.success) {
      const normalizedStored = IssueWorkflowStateSchema.parse({ ...canonical.data, stateChangedAt: parsed.stateChangedAt });
      if (projectionStateHash(normalizedStored) !== stateHash) return;
      const storedHash = projectionStateHash(canonical.data);
      const timeline = database.prepare("SELECT event_hash FROM forge_issue_timeline WHERE id = ? AND workflow_id = ? AND revision = 0").get(parsed.lastEventId, parsed.workflowId) as { event_hash: string } | undefined;
      if (!timeline || timeline.event_hash !== storedHash) return;
      const current = database.prepare("SELECT revision, event_hash, authoritative_event_hash FROM forge_issue_projections WHERE task_id = ?").get(parsed.issueId) as { revision: number; event_hash: string; authoritative_event_hash: string } | undefined;
      if (current?.revision === 0 && current.event_hash !== storedHash && current.event_hash !== stateHash) return;
      database.prepare("UPDATE forge_workflow_snapshots SET state_json = ? WHERE task_id = ? AND revision = 0 AND state_json = ?").run(JSON.stringify(parsed), parsed.issueId, snapshot.state_json);
      database.prepare("UPDATE forge_issue_timeline SET event_hash = ?, metadata_json = ? WHERE id = ? AND workflow_id = ? AND revision = 0 AND event_hash = ?").run(stateHash, JSON.stringify({ revision: 0, phase: parsed.phase, stateHash }), parsed.lastEventId, parsed.workflowId, storedHash);
      if (current?.revision === 0 && current.event_hash === storedHash) database.prepare("UPDATE forge_issue_projections SET event_hash = ?, authoritative_event_hash = CASE WHEN authoritative_event_hash = ? THEN ? ELSE authoritative_event_hash END WHERE task_id = ? AND revision = 0 AND event_hash = ?").run(stateHash, storedHash, stateHash, parsed.issueId, storedHash);
      return;
    }
    if (legacy.issueId !== undefined || legacy.taskId !== parsed.issueId || legacy.repairCycle !== undefined) return;
    const normalized = IssueWorkflowStateSchema.safeParse({ ...legacy, taskId: undefined, issueId: parsed.issueId, repairCycle: 0 });
    if (!normalized.success || projectionStateHash(normalized.data) !== stateHash) return;

    const legacyHash = projectionStateHash(legacy);
    const timeline = database.prepare("SELECT event_hash FROM forge_issue_timeline WHERE id = ? AND workflow_id = ? AND revision = 0").get(parsed.lastEventId, parsed.workflowId) as { event_hash: string } | undefined;
    if (!timeline || timeline.event_hash !== legacyHash) return;
    const current = database.prepare("SELECT revision, event_hash, authoritative_event_hash FROM forge_issue_projections WHERE task_id = ?").get(parsed.issueId) as { revision: number; event_hash: string; authoritative_event_hash: string } | undefined;
    if (current?.revision === 0 && current.event_hash !== legacyHash && current.event_hash !== stateHash) return;

    database.prepare("UPDATE forge_workflow_snapshots SET state_json = ? WHERE task_id = ? AND revision = 0 AND state_json = ?").run(JSON.stringify(parsed), parsed.issueId, snapshot.state_json);
    database.prepare("UPDATE forge_issue_timeline SET event_hash = ?, metadata_json = ? WHERE id = ? AND workflow_id = ? AND revision = 0 AND event_hash = ?").run(stateHash, JSON.stringify({ revision: 0, phase: parsed.phase, stateHash }), parsed.lastEventId, parsed.workflowId, legacyHash);
    if (current?.revision === 0 && current.event_hash === legacyHash) {
      database.prepare("UPDATE forge_issue_projections SET event_hash = ?, authoritative_event_hash = CASE WHEN authoritative_event_hash = ? THEN ? ELSE authoritative_event_hash END WHERE task_id = ? AND revision = 0 AND event_hash = ?").run(stateHash, legacyHash, stateHash, parsed.issueId, legacyHash);
    }
  }

  observeIssueProjection(event: IssueProjectionEvent): void {
    const parsed = IssueProjectionEventSchema.safeParse(event);
    if (!parsed.success) {
      projectionLogger.warn("Skipping invalid workflow projection observation");
      return;
    }
    const validated = parsed.data;
    const stateHash = projectionStateHash(validated.state);
    this.db.transaction(() => {
      const task = this.db.prepare("SELECT company_id, project_id, workflow_id FROM forge_tasks WHERE id = ?").get(validated.state.issueId) as { company_id: string; project_id: string; workflow_id: string } | undefined;
      if (!task || task.company_id !== validated.state.companyId || task.project_id !== validated.state.projectId || task.workflow_id !== validated.state.workflowId) {
        projectionLogger.warn("Skipping workflow projection observation with mismatched task identity");
        return;
      }
      const current = this.db.prepare("SELECT authoritative_revision, authoritative_event_hash FROM forge_issue_projections WHERE task_id = ?").get(validated.state.issueId) as { authoritative_revision: number; authoritative_event_hash: string } | undefined;
      if (current && current.authoritative_revision <= validated.state.revision) this.db.prepare("UPDATE forge_issue_projections SET authoritative_revision = ?, authoritative_event_hash = ? WHERE task_id = ?").run(validated.state.revision, stateHash, validated.state.issueId);
    })();
  }

  projectIssueEvent(event: IssueProjectionEvent): void {
    const validated = IssueProjectionEventSchema.safeParse(event);
    if (!validated.success) {
      projectionLogger.warn("Skipping invalid workflow projection event");
      return;
    }
    try {
      this.db.transaction(() => this.applyIssueProjection(this.db, validated.data.state, new Date().toISOString(), validated.data.runId))();
    } catch (error) {
      projectionLogger.warn("Workflow projection write failed", {}, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  projectIssueState(state: IssueProjectionRecord): void {
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
      projectionLogger.warn("Skipping invalid workflow state projection");
      return;
    }
    try {
      this.db.transaction(() => this.applyIssueProjection(this.db, parsed.data, new Date().toISOString(), state.runId ?? parsed.data.workflowId))();
    } catch (error) {
      projectionLogger.warn("Workflow state projection write failed", {}, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  replaceIssueProjectionFromEvents(taskId: string, events: IssueProjectionEvent[]): void {
    const validated = events.map((event) => IssueProjectionEventSchema.safeParse(event)).filter((event): event is { success: true; data: IssueProjectionEvent } => event.success).map((event) => event.data).sort((left, right) => left.state.revision - right.state.revision);
    if (validated.length === 0 || validated.some((event) => event.state.issueId !== taskId)) {
      projectionLogger.warn("Skipping projection rebuild with invalid or mismatched events");
      return;
    }
    try {
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM forge_issue_projections WHERE task_id = ?").run(taskId);
        this.db.prepare("DELETE FROM forge_issue_timeline WHERE task_id = ?").run(taskId);
        this.db.prepare("DELETE FROM forge_workflow_snapshots WHERE task_id = ?").run(taskId);
        for (const event of validated) this.applyIssueProjection(this.db, event.state, new Date().toISOString(), event.runId);
      })();
    } catch (error) {
      projectionLogger.warn("Projection rebuild write failed", {}, { error: error instanceof Error ? error.message : String(error) });
    }
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
