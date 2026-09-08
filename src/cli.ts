#!/usr/bin/env node
import { join } from "node:path";
import { rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./platform/config.js";
import { AuthService } from "./identity/auth.js";
import { ForgeDatabase } from "./platform/database.js";
import { readProcessRegistry, stopOwnedProcesses } from "./platform/process-manager.js";
import { startForge } from "./platform/runtime.js";
import { StructuredLogger } from "./platform/logging.js";
import { runSetup } from "./platform/setup.js";
import { BackupService } from "./platform/backup.js";
import { formatDoctor, runDoctor } from "./platform/diagnostics/doctor.js";
import { formatTaskDiagnostic, inspectTask, writeTaskBundle } from "./platform/diagnostics/task.js";
import { runLogViewer } from "./platform/log-viewer.js";
import { runCommand } from "./platform/command-runner.js";

const command = process.argv[2] === "--" ? (process.argv[3] ?? "help") : (process.argv[2] ?? "help");
const commandArgs = process.argv.slice(process.argv[2] === "--" ? 4 : 3);
const foreground = process.argv.includes("--foreground");
const verbose = process.argv.includes("--verbose");

function openDiagnosticDatabase(filename: string): ForgeDatabase {
  const database = new ForgeDatabase(filename, { readOnly: true });
  const schema = database.schemaStatus();
  if (database.openMode() === "read-only" && schema.state === "behind") {
    process.stderr.write("database is behind this build — restart the stack to migrate\n");
  }
  if (verbose) process.stderr.write(`database open mode: ${database.openMode()}\n`);
  return database;
}

async function stopForge(config: ReturnType<typeof loadConfig>): Promise<void> {
  const registryPath = `${config.runtimeRoot}/owned-processes.json`;
  const registry = await readProcessRegistry(registryPath);
  const report = await stopOwnedProcesses(registry);
  await rm(registryPath, { force: true });
  process.stdout.write(`${JSON.stringify({ stopped: report.stopped.length, skipped: report.skipped })}\n`);
}

async function main(): Promise<void> {
  if (command === "setup" || command === "onboard") {
    await runSetup();
    return;
  }
  if (command === "logs") {
    let taskId: string | undefined;
    let since: string | undefined;
    let errors = false;
    let follow = false;
    for (let index = 0; index < commandArgs.length; index += 1) {
      const arg = commandArgs[index];
      if (arg === "--task") taskId = commandArgs[++index];
      else if (arg === "--since") since = commandArgs[++index];
      else if (arg === "--errors") errors = true;
      else if (arg === "--follow") follow = true;
      else if (arg === "--verbose") { /* handled globally */ }
      else throw new Error(`Unknown logs option: ${arg}`);
      if ((arg === "--task" && !taskId) || (arg === "--since" && !since)) throw new Error(`${arg} requires a value`);
    }
    const database = openDiagnosticDatabase(loadConfig().databasePath);
    try {
      await runLogViewer({ errors, follow, ...(taskId ? { taskId } : {}), ...(since ? { since } : {}) });
    } finally { database.close(); }
    return;
  }
  if (command === "help") {
    process.stdout.write("Usage: pnpm run forge <setup|recover|backup|verify-backup|restore|migrate|task|doctor|start|stop|restart|logs> [--foreground]\n");
    return;
  }
  const config = loadConfig();
  if (command === "task") {
    const taskId = commandArgs[0];
    if (!taskId || taskId.startsWith("--")) throw new Error("task requires a task ID");
    const database = openDiagnosticDatabase(config.databasePath);
    try {
      const diagnostic = await inspectTask(config, database, taskId, process.argv.includes("--history"));
      if (process.argv.includes("--bundle")) process.stdout.write(`bundle      ${await writeTaskBundle(config, database, taskId)}\n`);
      process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(diagnostic, null, 2)}\n` : formatTaskDiagnostic(diagnostic));
    } finally { database.close(); }
    return;
  }
  if (command === "doctor") {
    if (process.argv.includes("--fix")) throw new Error("doctor is read-only. Restart Forge to apply pending migrations.");
    const database = openDiagnosticDatabase(config.databasePath);
    try {
      const checks = await runDoctor(config, database);
      process.stdout.write(formatDoctor(checks));
      if (checks.some((check) => check.status === "FAIL")) process.exitCode = 1;
    } finally { database.close(); }
    return;
  }
  if (command === "migrate") {
    const database = new ForgeDatabase(config.databasePath);
    try {
      const status = database.schemaStatus();
      if (status.state !== "current") {
        throw new Error(`Database schema is ${status.state} after migration (${status.applied.length}/${status.expected.length} migrations applied)`);
      }
      process.stdout.write(`Database schema is current (${status.applied.length}/${status.expected.length} migrations applied)\n`);
    } finally {
      database.close();
    }
    return;
  }
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
        const handoff = {
          version: 1,
          restoredAt: new Date().toISOString(),
          archivePath: result.archivePath,
          archiveBytes: (await stat(result.archivePath)).size,
          backupDurationMs: result.durationMs,
          restoreDurationMs: result.restoreDurationMs,
          verification: { valid: result.valid, verifiedAt: result.verifiedAt, errors: result.errors },
          requiresReauthentication: true,
          nextSteps: ["Restore repository and worktree paths before starting Forge", "Sign in to OpenCode and GitHub on the restored host", "Preserve OpenCode session storage to continue existing tasks", "Start Forge and review any specific recovery question"],
        };
        await writeFile(join(destination, "forge-backup", "restore-handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
      } finally { restoredDatabase.close(); }
      process.stdout.write(`backup restored to ${destination}; verification ${result.valid ? "passed" : "failed"} (${result.restoreDurationMs}ms); see forge-backup/restore-handoff.json\n`);
    }
    return;
  }
  if (command === "desktop") {
    const url = `http://localhost:${config.port}`;
    const result = await runCommand({ taskId: null, stepId: null, command: "open", args: ["-na", "Forge", "--args", `--url=${url}`], expectNonZero: true }); // -n: a running Forge.app receives the URL through its single-instance lock
    if (result.exitCode !== 0) throw new Error(`Forge.app did not open: ${result.stderr.trim() || "install Forge.app from desktop/release first"}`);
    process.stdout.write(`Forge.app opened at ${url}\n`);
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
