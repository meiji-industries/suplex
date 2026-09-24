import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { providerInstancesDirectory } from "../profiles/provider-instances.js";
import type { SuplexConfig } from "./config.js";
import { SuplexDatabase } from "./database.js";

export class LiveSessionsBlockReset extends Error {
  constructor() {
    super("Cancel active tasks and wait for their sessions to stop before you factory reset Suplex");
    this.name = "LiveSessionsBlockReset";
  }
}

/**
 * Replaces the live database with a freshly migrated one and deletes artifacts and provider homes.
 * Backups, worktrees and repositories stay on disk. Live native sessions block the reset, because
 * their agents would keep running with no task to stop them.
 */
export async function factoryReset(database: SuplexDatabase, config: Pick<SuplexConfig, "databasePath" | "artifactRoot">): Promise<void> {
  const live = database.authQuery(db => db.prepare("SELECT 1 FROM suplex_task_controls WHERE status IN ('active', 'waiting_human') UNION ALL SELECT 1 FROM suplex_task_sessions WHERE stop_requested_at IS NOT NULL AND stopped_at IS NULL LIMIT 1").get());
  if (live) throw new LiveSessionsBlockReset();
  const staging = await mkdtemp(join(tmpdir(), "suplex-factory-reset-"));
  try {
    const path = join(staging, "suplex.sqlite");
    new SuplexDatabase(path).close();
    const fresh = new Database(path);
    // SQLite's backup API swaps the pages under open connections, which see the empty database on their next read.
    try { await fresh.backup(config.databasePath); } finally { fresh.close(); }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await rm(config.artifactRoot, { recursive: true, force: true });
  await mkdir(config.artifactRoot, { recursive: true });
  await rm(providerInstancesDirectory(config.databasePath), { recursive: true, force: true });
}
