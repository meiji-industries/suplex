import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestConfig, type ForgeConfig } from "../../src/config.js";
import { ForgeDatabase } from "../../src/database.js";
import { installIssueEngine } from "../../src/engine/index.js";
import { IssueEngine, type EngineClock } from "../../src/engine/runs.js";

export interface EngineHarness { root: string; config: ForgeConfig; database: ForgeDatabase; engine: IssueEngine; restart(): Promise<IssueEngine>; stop(): Promise<void> }
export async function createEngineHarness(activities: object = {}, clock?: EngineClock): Promise<EngineHarness> {
  const root = await mkdtemp(join(tmpdir(), "forge-engine-")); const config = createTestConfig(root); let database = new ForgeDatabase(config.databasePath); let engine = new IssueEngine(config, database, { activities, ...(clock ? { clock } : {}) }); installIssueEngine(config, engine);
  return { root, config, get database() { return database; }, get engine() { return engine; }, async restart() { engine.dispose(); database.close(); database = new ForgeDatabase(config.databasePath); engine = new IssueEngine(config, database, { activities, ...(clock ? { clock } : {}) }); installIssueEngine(config, engine); return engine; }, async stop() { engine.dispose(); database.close(); await rm(root, { recursive: true, force: true }); } };
}
