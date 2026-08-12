#!/usr/bin/env node
import { join } from "node:path";
import { rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { AuthService } from "./auth.js";
import { ForgeDatabase } from "./database.js";
import { readProcessRegistry, stopOwnedProcesses } from "./process-manager.js";
import { startForge } from "./runtime.js";
import { StructuredLogger } from "./logging.js";
import { runSetup } from "./setup.js";
import { BackupService, reconcileRestoredState } from "./backup.js";
import { AttentionService } from "./attention.js";
import { CapacityManager } from "./capacity.js";
import { createGithubReleasePort } from "./github-release.js";
import { ProjectionRebuildFailure, ProjectionRebuildService } from "./projection-rebuild.js";
import { runAgentWrapper } from "./agent-wrapper.js";
import { reconcileAgentExecutions } from "./agent-recovery.js";
import { reconcileDeveloperExecutions } from "./developer-recovery.js";

const command = process.argv[2] === "--" ? (process.argv[3] ?? "help") : (process.argv[2] ?? "help");
const foreground = process.argv.includes("--foreground");

async function stopForge(config: ReturnType<typeof loadConfig>): Promise<void> {
  const registryPath = `${config.runtimeRoot}/owned-processes.json`;
  const registry = await readProcessRegistry(registryPath);
  const report = await stopOwnedProcesses(registry);
  await rm(registryPath, { force: true });
  process.stdout.write(`${JSON.stringify({ stopped: report.stopped.length, skipped: report.skipped })}\n`);
}

async function main(): Promise<void> {
  if (command === "agent-wrapper") {
    const manifestPath = process.argv[3];
    if (!manifestPath) throw new Error("agent-wrapper requires a manifest path");
    await runAgentWrapper(manifestPath);
    return;
  }
  if (command === "setup" || command === "onboard") {
    await runSetup();
    return;
  }
  if (command === "help") {
    process.stdout.write("Usage: pnpm run forge <setup|recover|backup|verify-backup|restore|start|stop|restart> [--foreground]\n");
    return;
  }
  const config = loadConfig();
  if (command === "backup" || command === "verify-backup" || command === "restore") {
    const service = new BackupService(config);
    const archive = process.argv[3];
    if (command === "backup") {
      if (!archive) throw new Error("backup requires an archive path");
      const result = await service.create({ destination: archive });
      process.stdout.write(`Backup created at ${result.archivePath} (${result.manifest.entries.length} files, ${result.archiveBytes} bytes, ${result.durationMs}ms)\n`);
    } else if (command === "verify-backup") {
      if (!archive) throw new Error("verify-backup requires an archive path");
      const result = await service.verify(archive);
      process.stdout.write(`Backup verification ${result.valid ? "passed" : "failed"} (${result.durationMs}ms)${result.errors.length ? `: ${result.errors.join("; ")}` : ""}\n`);
      if (!result.valid) process.exitCode = 1;
    } else {
      const destination = process.argv[4];
      if (!archive || !destination) throw new Error("restore requires an archive path and separate destination");
      const result = await service.restore(archive, destination);
      const restoredDatabase = new ForgeDatabase(`${destination}/forge-backup/app/forge.sqlite`);
      try {
        let rebuild: Awaited<ReturnType<ProjectionRebuildService["rebuild"]>> | undefined;
        let rebuildFailure: { code: string; summary: string } | undefined;
        try {
          rebuild = await new ProjectionRebuildService(restoredDatabase, config).rebuild();
        } catch (error) {
          if (!(error instanceof ProjectionRebuildFailure)) throw error;
          rebuildFailure = { code: error.code, summary: error.message };
        }
        const restoredAuth = new AuthService(restoredDatabase, config);
        const companies = new AttentionService(restoredDatabase, restoredAuth).rebuildAll();
        await reconcileAgentExecutions(restoredDatabase);
        await reconcileDeveloperExecutions(restoredDatabase);
        new CapacityManager(restoredDatabase, config).reconcileFromLedgers();
        const reconciliation = await reconcileRestoredState(restoredDatabase, createGithubReleasePort());
        const handoff = {
          version: 1,
          restoredAt: new Date().toISOString(),
          archivePath: result.archivePath,
          archiveBytes: (await stat(result.archivePath)).size,
          backupDurationMs: result.durationMs,
          restoreDurationMs: result.restoreDurationMs,
          verification: { valid: result.valid, verifiedAt: result.verifiedAt, errors: result.errors },
          projectionRebuild: rebuild ? { status: "rebuilt", rebuilt: rebuild.rebuilt, findings: rebuild.findings } : { status: "blocked", ...rebuildFailure },
          projectionsRebuilt: rebuild?.rebuilt ?? 0,
          projectionIntegrityFindings: rebuild?.findings ?? [],
          companiesRebuilt: companies,
          reconciliation,
          requiresReauthentication: true,
          nextSteps: ["Recreate the restored Cloud configuration without copying secrets; preserve installationId, temporalNamespace, and taskQueue", "Create a new Temporal Cloud API key for the restored host", "Reauthenticate the restored host integrations", "Start Forge against the existing Temporal Cloud namespace", "Inspect interrupted Developer turns before explicitly retrying or cancelling them"],
        };
        await writeFile(join(destination, "forge-backup", "restore-handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
        process.stdout.write(rebuild ? `Restored projection state (${rebuild.rebuilt} issue snapshots, ${companies} companies); ` : `Restored database; projection rebuild blocked (${rebuildFailure?.code}), ${companies} companies reconciled; `);
        process.stdout.write(`reconciled ${reconciliation.developerExecutions.length} Developer executions and ${reconciliation.providers.length} provider releases; `);
      } finally { restoredDatabase.close(); }
      process.stdout.write(`backup restored to ${destination}; verification ${result.valid ? "passed" : "failed"} (${result.restoreDurationMs}ms); see forge-backup/restore-handoff.json\n`);
    }
    return;
  }
  if (command === "rebuild-projections") {
    const database = new ForgeDatabase(config.databasePath);
    try {
      const rebuild = await new ProjectionRebuildService(database, config).rebuild();
      const attention = new AttentionService(database, new AuthService(database, config));
      attention.rebuildAll();
      await reconcileAgentExecutions(database);
      await reconcileDeveloperExecutions(database);
      new CapacityManager(database, config).reconcileFromLedgers();
      process.stdout.write(`Rebuilt ${rebuild.rebuilt} issue projections (${rebuild.findings.length} findings) and reconciled operator ledgers\n`);
    } finally { database.close(); }
    return;
  }
  if (command === "recover") {
    if (!process.argv.includes("--confirm-recovery")) {
      throw new Error("recover requires --confirm-recovery");
    }
    const database = new ForgeDatabase(config.databasePath);
    try {
      const invitation = new AuthService(database, config).createRecoveryInvitation({ confirmed: true, initiationMethod: "local-cli", installationId: config.installationId });
      process.stdout.write(`Recovery enrollment (showing once): ${config.reachableAddress}/auth?mode=recovery&invite=${invitation.token}\n`);
    } finally {
      database.close();
    }
    return;
  }
  if (command === "start") {
    const registry = await startForge(config, foreground);
    process.stdout.write(`Forge started at ${config.reachableAddress}; owned processes: ${registry.processes.map((process) => `${process.name}#${process.pid}`).join(", ")}\n`);
    return;
  }
  if (command === "stop") {
    await stopForge(config);
    return;
  }
  if (command === "restart") {
    try {
      await stopForge(config);
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT|no such file/i.test(error.message)) {
        throw error;
      }
    }
    const registry = await startForge(config, foreground);
    process.stdout.write(`Forge restarted at ${config.reachableAddress}; owned processes: ${registry.processes.length}\n`);
    return;
  }
  throw new Error(`Unknown Forge command: ${command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    new StructuredLogger().error("Forge command failed", {}, { error: error instanceof Error ? error.message : "unknown error" });
    process.exitCode = 1;
  });
}
