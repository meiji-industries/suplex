#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import { readProcessRegistry, stopOwnedProcesses } from "./process-manager.js";
import { startForge } from "./runtime.js";
import { StructuredLogger } from "./logging.js";
import { runSetup } from "./setup.js";

const command = process.argv[2] ?? "help";
const foreground = process.argv.includes("--foreground");

async function stopForge(config: ReturnType<typeof loadConfig>): Promise<void> {
  const registryPath = `${config.runtimeRoot}/owned-processes.json`;
  const registry = await readProcessRegistry(registryPath);
  const report = await stopOwnedProcesses(registry);
  await rm(registryPath, { force: true });
  console.log(JSON.stringify({ stopped: report.stopped.length, containersStopped: report.containersStopped.length, skipped: report.skipped }));
}

async function main(): Promise<void> {
  if (command === "setup" || command === "onboard") {
    await runSetup();
    return;
  }
  if (command === "help") {
    console.log("Usage: npm run forge -- <setup|start|stop|restart> [--foreground]");
    return;
  }
  const config = loadConfig();
  if (command === "start") {
    const registry = await startForge(config, foreground);
    console.log(`Forge started at ${config.reachableAddress}; owned processes: ${registry.processes.map((process) => `${process.name}#${process.pid}`).join(", ")}`);
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
    console.log(`Forge restarted at ${config.reachableAddress}; owned processes: ${registry.processes.length}`);
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
