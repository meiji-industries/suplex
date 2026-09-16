import { statfs } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { runCommand, setCommandRunnerLogger } from "../command-runner.js";
import { ForgeDatabase } from "../database.js";
import { runDoctor } from "../diagnostics/doctor.js";
import { StructuredLogger } from "../logging.js";
import { checkHerdrReadiness } from "../../integrations/herdr/readiness.js";
import { installStage, installStages, type InstallContext, type StageOutcome } from "./stages.js";

export const INSTALL_PROTOCOL_VERSION = 1;

export function installManifest(): { protocolVersion: number; stages: { name: string; title: string }[] } {
  return {
    protocolVersion: INSTALL_PROTOCOL_VERSION,
    stages: installStages.map((stage) => ({ name: stage.name, title: stage.title })),
  };
}

async function freeBytes(path: string): Promise<number> {
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      const stats = await statfs(current);
      return stats.bavail * stats.bsize;
    } catch {
      if (dirname(current) === current) return 0;
    }
  }
}

export function createInstallContext(): InstallContext {
  return {
    env: process.env,
    system: { platform: platform(), arch: arch(), release: release() },
    run: async (command, args, timeoutMs = 60_000) => {
      const result = await runCommand({ taskId: null, stepId: null, command, args, timeout: timeoutMs, expectNonZero: true });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    progress: (line) => process.stderr.write(`${line}\n`),
    wait: async (milliseconds) => { await delay(milliseconds); },
    freeBytes,
    herdrReadiness: () => checkHerdrReadiness(),
    doctor: async (config) => {
      // A read-only handle reports the database as unwritable, which doctor grades as a failure, so the installer opens it the way Forge will.
      const database = new ForgeDatabase(config.databasePath);
      try {
        return await runDoctor(config, database);
      } finally {
        database.close();
      }
    },
  };
}

export async function runInstallCommand(args: readonly string[], context = createInstallContext()): Promise<number> {
  if (args.includes("--manifest")) {
    process.stdout.write(`${JSON.stringify(installManifest())}\n`);
    return 0;
  }
  const name = args[args.indexOf("--stage") + 1];
  if (!args.includes("--stage") || !name || name.startsWith("--")) {
    process.stderr.write("Usage: forge install --manifest | forge install --stage <name> --json\n");
    return 1;
  }
  const stage = installStage(name);
  // Command output shares stdout with the single JSON frame, so the command runner logs to stderr instead.
  setCommandRunnerLogger(new StructuredLogger((line) => process.stderr.write(line)));
  const failure = (reason: string): StageOutcome => ({ ok: false, reason });
  const outcome = stage
    ? await stage.run(context).catch((error: unknown) => failure(error instanceof Error ? error.message : "The stage stopped with an unknown error."))
    : failure(`Unknown install stage: ${name}`);
  process.stdout.write(`${JSON.stringify({
    ok: outcome.ok,
    stage: name,
    skipped: outcome.skipped ?? false,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.remedy ? { remedy: outcome.remedy } : {}),
  })}\n`);
  return outcome.ok ? 0 : 1;
}
