#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { AuthService } from "./auth.js";
import { ForgeDatabase } from "./database.js";
import { readProcessRegistry, stopOwnedProcesses } from "./process-manager.js";
import { startForge } from "./runtime.js";
import { StructuredLogger } from "./logging.js";
import { runSetup } from "./setup.js";
import { BackupService } from "./backup.js";

const command = process.argv[2] === "--" ? (process.argv[3] ?? "help") : (process.argv[2] ?? "help");
const foreground = process.argv.includes("--foreground");

async function stopForge(config: ReturnType<typeof loadConfig>): Promise<void> {
  const registryPath = `${config.runtimeRoot}/owned-processes.json`;
  const registry = await readProcessRegistry(registryPath);
  const report = await stopOwnedProcesses(registry);
  await rm(registryPath, { force: true });
  process.stdout.write(`${JSON.stringify({ stopped: report.stopped.length, containersStopped: report.containersStopped.length, skipped: report.skipped })}\n`);
}

async function main(): Promise<void> {
  if (command === "setup" || command === "onboard") {
    await runSetup();
    return;
  }
  if (command === "help") {
    process.stdout.write("Usage: pnpm run forge <setup|recover|backup|restore|start|stop|restart> [--foreground]\n");
    return;
  }
  const config = loadConfig();
  if (command === "backup" || command === "restore") {
    const service = new BackupService(config);
    const archive = process.argv[3];
    if (command === "backup") {
      const temporalPath = process.env.FORGE_TEMPORAL_DATA_PATH;
      if (!archive || !temporalPath) throw new Error("backup requires an archive path and FORGE_TEMPORAL_DATA_PATH");
      const result = await service.create({ destination: archive, temporalPersistencePath: temporalPath });
      process.stdout.write(`Backup created at ${result.archivePath} (${result.manifest.entries.length} files, ${result.durationMs}ms)\n`);
    } else {
      const destination = process.argv[4];
      if (!archive || !destination) throw new Error("restore requires an archive path and separate destination");
      const result = await service.restore(archive, destination);
      process.stdout.write(`Backup restored to ${destination}; verification ${result.valid ? "passed" : "failed"}\n`);
    }
    return;
  }
  if (command === "recover") {
    const database = new ForgeDatabase(config.databasePath);
    try {
      const invitation = new AuthService(database, config).createRecoveryInvitation();
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
