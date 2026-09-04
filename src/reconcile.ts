import type { ForgeConfig } from "./config.js";
import type { ForgeDatabase } from "./database.js";
import { reconcileActiveTurns } from "./active-turn-recovery.js";
import { CapacityManager } from "./capacity.js";
import { reconcileGithubObservations } from "./github-observation-reconciliation.js";
import { reconcileWorktrees } from "./worktree-reconciliation.js";
import type { IssueEngine } from "./engine/runs.js";

export async function reconcile(database: ForgeDatabase, config: ForgeConfig, _engine: IssueEngine, deps: { logger: { error(message: string, attributes?: object, error?: object): void }; force?: boolean; herdr?: unknown } = { logger: console }): Promise<{ turns: number; worktrees: number; github: number; capacity: number }> {
  const turns = await reconcileActiveTurns(database, config, { logger: deps.logger });
  const worktrees = await reconcileWorktrees(database, config);
  let github = 0;
  github = (await reconcileGithubObservations(database, config)).signalled;
  const capacity = new CapacityManager(database, config).reconcileFromLedgers();
  return { turns: turns.length, worktrees: worktrees.removedExternally + worktrees.reported, github, capacity };
}
