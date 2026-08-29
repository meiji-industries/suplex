import type { ForgeConfig } from "../config.js";
import { ForgeDatabase } from "../database.js";
import { IssueEngine } from "./runs.js";

const engines = new Map<string, IssueEngine>();
export function getIssueEngine(config: ForgeConfig): IssueEngine {
  let engine = engines.get(config.databasePath);
  if (!engine) { engine = new IssueEngine(config, new ForgeDatabase(config.databasePath)); engines.set(config.databasePath, engine); }
  return engine;
}
export function installIssueEngine(config: ForgeConfig, engine: IssueEngine): void {
  const previous = engines.get(config.databasePath); if (previous && previous !== engine) previous.dispose(); engines.set(config.databasePath, engine);
}
export function disposeIssueEngine(config: ForgeConfig): void { engines.get(config.databasePath)?.dispose(); engines.delete(config.databasePath); }
