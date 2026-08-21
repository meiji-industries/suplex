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
import { attentionPolicy } from "./attention-policy.js";
import { StructuredLogger } from "./logging.js";

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
export class ProjectionIntegrityFailure extends Error {
  readonly code: string;
  readonly taskId: string | undefined;
  readonly revision: number | undefined;

  readonly eventId: string | undefined;

  constructor(message: string, details: { taskId?: string; revision?: number; eventId?: string } = {}, code = "projection_invalid") {
    super(message);
    this.name = "ProjectionIntegrityFailure";
    this.code = code;
    this.taskId = details.taskId;
    this.revision = details.revision;
    this.eventId = details.eventId;
  }
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
    const appliedByHash = new Map(applied.map((migration) => [migration.hash, migration.created_at]));

    for (const migration of migrations) {
      const hashAtTimestamp = appliedByTimestamp.get(migration.createdAt);
      const timestampForHash = appliedByHash.get(migration.hash);
      if (hashAtTimestamp !== undefined && hashAtTimestamp !== migration.hash) {
        throw new Error(`Applied migration timestamp has different SQL: ${migration.tag}`);
      }
      if (timestampForHash !== undefined && timestampForHash !== migration.createdAt) {
        throw new Error(`Applied migration hash has a different timestamp: ${migration.tag}`);
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

  constructor(filename: string) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("recursive_triggers = ON");
    this.orm = drizzle(this.db, { schema: { ...authSchema, probeWorkflows, workerRegistrations } });
    try {
      this.preflightProjectRepositoryIdentities();
      applyMigrations(this.db, migrationFolder());
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
      throw new ProjectionIntegrityFailure("Projection event identity does not match its task", { taskId: parsed.issueId, revision: parsed.revision, eventId: parsed.lastEventId }, "projection_identity_conflict");
    }
    let eventById = database.prepare("SELECT workflow_id, revision, event_hash FROM forge_issue_timeline WHERE id = ?").get(parsed.lastEventId) as { workflow_id: string; revision: number; event_hash: string } | undefined;
    let eventByRevision = database.prepare("SELECT id, event_hash FROM forge_issue_timeline WHERE workflow_id = ? AND revision = ?").get(parsed.workflowId, parsed.revision) as { id: string; event_hash: string } | undefined;
    let current = database.prepare("SELECT revision, event_hash, last_event_id, authoritative_revision, authoritative_event_hash FROM forge_issue_projections WHERE task_id = ?").get(parsed.issueId) as { revision: number; event_hash: string; last_event_id: string; authoritative_revision: number; authoritative_event_hash: string } | undefined;
    const identical = eventById?.workflow_id === parsed.workflowId
      && eventById.revision === parsed.revision
      && eventById.event_hash === stateHash
      && eventByRevision?.id === parsed.lastEventId
      && eventByRevision.event_hash === stateHash
      && current?.revision === parsed.revision
      && current.event_hash === stateHash
      && current.last_event_id === parsed.lastEventId;
    if (identical) return;

    // Temporal resets re-issue revision and event identities. The workflow's
    // newest state is authoritative, so replace all bookkeeping from the
    // divergence point instead of treating a reused identity as corruption.
    if ((eventById && (eventById.workflow_id !== parsed.workflowId || eventById.revision !== parsed.revision || eventById.event_hash !== stateHash))
      || (eventByRevision && (eventByRevision.id !== parsed.lastEventId || eventByRevision.event_hash !== stateHash))
      || (current?.revision === parsed.revision && (current.event_hash !== stateHash || current.last_event_id !== parsed.lastEventId))) {
      projectionLogger.info("Projection state overwritten for re-issued workflow revision");
      database.prepare("DELETE FROM forge_issue_timeline WHERE workflow_id = ? AND revision >= ?").run(parsed.workflowId, parsed.revision);
      database.prepare("DELETE FROM forge_workflow_snapshots WHERE task_id = ? AND revision >= ?").run(parsed.issueId, parsed.revision);
      database.prepare("DELETE FROM forge_issue_projections WHERE task_id = ? AND revision >= ?").run(parsed.issueId, parsed.revision);
      database.prepare("DELETE FROM forge_projection_invalidations WHERE task_id = ? AND revision >= ?").run(parsed.issueId, parsed.revision);
      eventById = undefined;
      eventByRevision = undefined;
      current = database.prepare("SELECT revision, event_hash, last_event_id, authoritative_revision, authoritative_event_hash FROM forge_issue_projections WHERE task_id = ?").get(parsed.issueId) as { revision: number; event_hash: string; last_event_id: string; authoritative_revision: number; authoritative_event_hash: string } | undefined;
    }

    const snapshot = database.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = ?").get(parsed.issueId, parsed.revision) as { state_json: string } | undefined;
    if (snapshot) {
      let stored: unknown;
      try { stored = JSON.parse(snapshot.state_json); } catch { throw new ProjectionIntegrityFailure("Authoritative workflow snapshot is not valid JSON", { taskId: parsed.issueId, revision: parsed.revision }); }
      const storedRecord = stored as Record<string, unknown>;
      const storedParsed = IssueWorkflowStateSchema.safeParse({ ...storedRecord, issueId: storedRecord.issueId ?? parsed.issueId, companyId: storedRecord.companyId ?? parsed.companyId, projectId: storedRecord.projectId ?? parsed.projectId, workflowId: storedRecord.workflowId ?? parsed.workflowId, projectRevisionId: storedRecord.projectRevisionId ?? parsed.projectRevisionId, owner: storedRecord.owner === "system" ? "human" : storedRecord.owner, continuationCount: storedRecord.continuationCount ?? 0, lastSummaryHash: storedRecord.lastSummaryHash ?? null });
      if (!storedParsed.success || projectionStateHash(storedParsed.data) !== stateHash) {
        projectionLogger.info("Workflow snapshot overwritten for re-issued projection revision");
        database.prepare("UPDATE forge_workflow_snapshots SET company_id = ?, workflow_id = ?, run_id = ?, state_json = ?, updated_at = ? WHERE task_id = ? AND revision = ?").run(parsed.companyId, parsed.workflowId, runId, JSON.stringify(parsed), updatedAt, parsed.issueId, parsed.revision);
      }
    }
    if (!eventById && !eventByRevision) database.prepare(`INSERT INTO forge_issue_timeline (id, task_id, company_id, workflow_id, run_id, revision, event_type, metadata_json, created_at, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(parsed.lastEventId, parsed.issueId, parsed.companyId, parsed.workflowId, runId, parsed.revision, eventType, JSON.stringify({ revision: parsed.revision, phase: parsed.phase, stateHash }), updatedAt, stateHash);
    if (!snapshot) database.prepare(`INSERT INTO forge_workflow_snapshots (task_id, company_id, workflow_id, run_id, revision, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(parsed.issueId, parsed.companyId, parsed.workflowId, runId, parsed.revision, JSON.stringify(parsed), updatedAt);
    if (current && current.revision > parsed.revision) return;

    const authoritativeRevision = Math.max(current?.authoritative_revision ?? 0, parsed.revision);
    const authoritativeEventHash = current && current.authoritative_revision > parsed.revision ? current.authoritative_event_hash : stateHash;
    const policy = attentionPolicy({ companyId: parsed.companyId, taskId: parsed.issueId, taskTitle: "", workflowId: parsed.workflowId, phase: parsed.phase, revision: parsed.revision, owner: parsed.owner, allowedCommands: parsed.allowedCommands, blocker: parsed.blocker, pendingAction: parsed.pendingAction, ...(parsed.stateChangedAt ? { stateChangedAt: parsed.stateChangedAt } : {}), projectedAt: updatedAt });
    let projectionStatus = policy.projectionStatus;
    // Evidence is optional: a bookkeeping activity that exhausted its retries still has to raise a badge.
    const evidence = policy.kind === "attention" ? policy.item.evidence : null;
    const attention = evidence
      ? database.prepare("SELECT id, kind, sha256 FROM forge_artifacts WHERE id = ? AND company_id = ? AND kind = ? AND sha256 = ?").get(evidence.artifactId, parsed.companyId, evidence.kind, evidence.sha256) as { id: string; kind: string; sha256: string } | undefined
      : undefined;
    if (evidence && !attention) projectionStatus = "unknown";
    database.prepare(`INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id, event_hash, authoritative_revision, authoritative_event_hash, projected_at, blocker_json, state_changed_at, projection_status, reconciled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET company_id = excluded.company_id, project_id = excluded.project_id, workflow_id = excluded.workflow_id, revision = excluded.revision, phase = excluded.phase, owner = excluded.owner, allowed_commands_json = excluded.allowed_commands_json, pending_action = excluded.pending_action, updated_at = excluded.updated_at, last_event_id = excluded.last_event_id, event_hash = excluded.event_hash, authoritative_revision = excluded.authoritative_revision, authoritative_event_hash = excluded.authoritative_event_hash, projected_at = excluded.projected_at, blocker_json = excluded.blocker_json, state_changed_at = excluded.state_changed_at, projection_status = excluded.projection_status, reconciled_at = excluded.reconciled_at
      WHERE forge_issue_projections.revision <= excluded.revision`).run(
      parsed.issueId, parsed.companyId, parsed.projectId, parsed.workflowId, parsed.revision, parsed.phase, parsed.owner, JSON.stringify(parsed.allowedCommands), parsed.pendingAction, updatedAt, parsed.lastEventId, stateHash, authoritativeRevision, authoritativeEventHash, updatedAt, parsed.blocker === undefined ? null : JSON.stringify(parsed.blocker), parsed.stateChangedAt ?? null, projectionStatus, updatedAt,
    );
    database.prepare("UPDATE forge_issue_projections SET last_run_id = ? WHERE task_id = ?").run(runId, parsed.issueId);
    const hadActiveAttention = Boolean((database.prepare("SELECT 1 AS present FROM forge_attention_items WHERE task_id = ? AND company_id = ? AND active = 1 LIMIT 1").get(parsed.issueId, parsed.companyId) as { present: number } | undefined)?.present);
    database.prepare("UPDATE forge_attention_items SET active = 0, updated_at = ? WHERE task_id = ? AND company_id = ? AND active = 1").run(updatedAt, parsed.issueId, parsed.companyId);
    if (policy.kind === "attention" && (attention || !evidence)) {
      database.prepare(`INSERT INTO forge_attention_items (id, company_id, task_id, category, summary, action, evidence_ref, active, created_at, updated_at, source_revision, activated_at, actions_json, evidence_artifact_id, evidence_sha256)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, action = excluded.action, evidence_ref = excluded.evidence_ref, active = 1, updated_at = excluded.updated_at, source_revision = excluded.source_revision, activated_at = excluded.activated_at, actions_json = excluded.actions_json, evidence_artifact_id = excluded.evidence_artifact_id, evidence_sha256 = excluded.evidence_sha256`).run(
        policy.item.id, parsed.companyId, parsed.issueId, policy.item.category, policy.item.summary, JSON.stringify(policy.item.actions), evidence ? `${evidence.artifactId}:${evidence.sha256}` : null, policy.item.activatedAt, updatedAt, policy.item.sourceRevision, policy.item.activatedAt, JSON.stringify(policy.item.actions), evidence?.artifactId ?? null, evidence?.sha256 ?? null,
      );
    }
    database.prepare("INSERT OR IGNORE INTO forge_projection_invalidations (id, company_id, task_id, revision, attention_changed, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(`${parsed.workflowId}:${parsed.revision}`, parsed.companyId, parsed.issueId, parsed.revision, policy.kind === "attention" || hadActiveAttention ? 1 : 0, updatedAt);
  }

  private normalizeLegacyInitialProjection(database: Database.Database, parsed: IssueWorkflowState, stateHash: string): void {
    if (parsed.revision !== 0 || parsed.phase !== "backlog" || parsed.repairCycle !== 0) return;
    const snapshot = database.prepare("SELECT state_json FROM forge_workflow_snapshots WHERE task_id = ? AND revision = 0").get(parsed.issueId) as { state_json: string } | undefined;
    if (!snapshot) return;
    let stored: unknown;
    try { stored = JSON.parse(snapshot.state_json); } catch { return; }
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
      database.prepare("INSERT OR IGNORE INTO forge_projection_invalidations (id, company_id, task_id, revision, attention_changed, created_at) VALUES (?, ?, ?, 0, 0, ?)").run(`${parsed.workflowId}:0`, parsed.companyId, parsed.issueId, new Date().toISOString());
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

  recordProjectionIntegrityFinding(input: { companyId: string; taskId: string; workflowId: string; revision: number | undefined; eventId: string | undefined; code: string; summary: string }): void {
    try {
      this.db.prepare(`INSERT INTO forge_projection_integrity_findings (id, company_id, task_id, workflow_id, revision, event_id, code, summary, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(`finding_${createHash("sha256").update(`${input.taskId}:${input.eventId ?? "unknown"}:${input.code}`).digest("hex").slice(0, 32)}`, input.companyId, input.taskId, input.workflowId, input.revision ?? null, input.eventId ?? null, input.code, input.summary.slice(0, 240), new Date().toISOString());
    } catch {
      // Finding persistence must not replace the original typed failure.
    }
  }

  private recordProjectionFinding(event: Partial<IssueProjectionEvent>, failure: ProjectionIntegrityFailure): void {
    if (!event.state?.companyId || !event.state.issueId || !event.state.workflowId) return;
    this.recordProjectionIntegrityFinding({ companyId: event.state.companyId, taskId: event.state.issueId, workflowId: event.state.workflowId, revision: event.state.revision, eventId: event.eventId, code: failure.code, summary: failure.message });
  }

  observeIssueProjection(event: IssueProjectionEvent): void {
    const validated = IssueProjectionEventSchema.parse(event);
    const stateHash = projectionStateHash(validated.state);
    this.db.transaction(() => {
      const task = this.db.prepare("SELECT company_id, project_id, workflow_id FROM forge_tasks WHERE id = ?").get(validated.state.issueId) as { company_id: string; project_id: string; workflow_id: string } | undefined;
      if (!task || task.company_id !== validated.state.companyId || task.project_id !== validated.state.projectId || task.workflow_id !== validated.state.workflowId) throw new ProjectionIntegrityFailure("Projection event identity does not match its task", { taskId: validated.state.issueId, revision: validated.state.revision, eventId: validated.eventId }, "projection_identity_conflict");
      const current = this.db.prepare("SELECT authoritative_revision, authoritative_event_hash FROM forge_issue_projections WHERE task_id = ?").get(validated.state.issueId) as { authoritative_revision: number; authoritative_event_hash: string } | undefined;
      if (current && current.authoritative_revision <= validated.state.revision) this.db.prepare("UPDATE forge_issue_projections SET authoritative_revision = ?, authoritative_event_hash = ? WHERE task_id = ?").run(validated.state.revision, stateHash, validated.state.issueId);
    })();
  }

  projectIssueEvent(event: IssueProjectionEvent): void {
    let validated: IssueProjectionEvent;
    try {
      validated = IssueProjectionEventSchema.parse(event);
      if (validated.state.issueId.length === 0) throw new ProjectionIntegrityFailure("Projection identity is invalid", { taskId: validated.state.issueId, revision: validated.state.revision }, "projection_identity_conflict");
      this.db.transaction(() => this.applyIssueProjection(this.db, validated.state, new Date().toISOString(), validated.runId))();
    } catch (error) {
      const failure = error instanceof ProjectionIntegrityFailure ? error : new ProjectionIntegrityFailure("Workflow projection event failed validation");
      this.recordProjectionFinding((event ?? {}) as Partial<IssueProjectionEvent>, failure);
      throw failure;
    }
  }

  projectIssueState(state: IssueProjectionRecord): void {
    const parsed = IssueWorkflowStateSchema.parse({
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
    this.db.transaction(() => this.applyIssueProjection(this.db, parsed, new Date().toISOString(), parsed.workflowId))();
  }

  replaceIssueProjectionFromEvents(taskId: string, events: IssueProjectionEvent[]): void {
    const validated = events.map((event) => IssueProjectionEventSchema.parse(event)).sort((left, right) => left.state.revision - right.state.revision);
    if (validated.length === 0 || validated.some((event) => event.state.issueId !== taskId)) throw new ProjectionIntegrityFailure("Projection rebuild events do not match the selected task", { taskId }, "projection_identity_conflict");
    try {
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM forge_issue_projections WHERE task_id = ?").run(taskId);
        this.db.prepare("DELETE FROM forge_issue_timeline WHERE task_id = ?").run(taskId);
        this.db.prepare("DELETE FROM forge_workflow_snapshots WHERE task_id = ?").run(taskId);
        for (const event of validated) this.applyIssueProjection(this.db, event.state, new Date().toISOString(), event.runId);
      })();
    } catch (error) {
      const failure = error instanceof ProjectionIntegrityFailure ? error : new ProjectionIntegrityFailure("Projection rebuild failed", { taskId });
      const event = validated.find((candidate) => candidate.state.revision === failure.revision) ?? validated.at(-1);
      if (event) this.recordProjectionFinding(event, failure);
      throw failure;
    }
  }

  schemaStatus(): SchemaStatus {
    const folder = migrationFolder();
    const expected = readMigrations(folder);
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
