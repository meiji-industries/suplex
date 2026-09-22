import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { authSchema, type AuthSchema } from "../identity/auth-schema.js";

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
    resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../drizzle"),
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
  private readonly commitCallbacks: Array<Array<() => void>> = [];
  private readonly db: Database.Database;
  private readonly orm: BetterSQLite3Database<AuthSchema>;
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
    this.orm = drizzle(this.db, { schema: authSchema });
    try {
      if (migrate) {
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

  filename(): string {
    return this.db.name;
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

  authTransaction<T>(operation: (database: Database.Database) => T): T {
    return this.runTransaction(operation, false);
  }

  authImmediateTransaction<T>(operation: (database: Database.Database) => T): T {
    return this.runTransaction(operation, true);
  }

  private runTransaction<T>(operation: (database: Database.Database) => T, immediate: boolean): T {
    const callbacks: Array<() => void> = [];
    this.commitCallbacks.push(callbacks);
    try {
      const transaction = this.db.transaction(() => operation(this.db));
      const result = immediate ? transaction.immediate() : transaction();
      this.commitCallbacks.pop();
      const parent = this.commitCallbacks.at(-1);
      if (parent) parent.push(...callbacks);
      else for (const callback of callbacks) { try { callback(); } catch { /* Diagnostics cannot change a committed command. */ } }
      return result;
    } catch (error) {
      this.commitCallbacks.pop();
      throw error;
    }
  }

  afterCommit(callback: () => void): void {
    const pending = this.commitCallbacks.at(-1);
    if (pending) pending.push(callback);
    else { try { callback(); } catch { /* Diagnostics cannot change a completed command. */ } }
  }

  authOrm(): BetterSQLite3Database<AuthSchema> {
    return this.orm;
  }

  authQuery<T>(operation: (database: Database.Database) => T): T {
    return operation(this.db);
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
