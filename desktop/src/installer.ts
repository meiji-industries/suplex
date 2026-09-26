import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runtimeEnvironment, DEFAULT_PORT, type RuntimePaths } from "./boot";

export type InstallStage = { readonly name: string; readonly title: string };

export type InstallEvent =
  | { readonly name: "stages"; readonly stages: readonly InstallStage[]; readonly from: number }
  | { readonly name: "stage-started"; readonly stage: string }
  | { readonly name: "log"; readonly line: string }
  | { readonly name: "stage-finished"; readonly stage: string; readonly skipped: boolean; readonly elapsedMs: number }
  | { readonly name: "failed"; readonly stage: string; readonly title: string; readonly reason: string; readonly remedy: string | null }
  | { readonly name: "done" };

export type InstallOutcome = "complete" | "failed" | "cancelled";

export type Installer = {
  run(from: string | null, emit: (event: InstallEvent) => void): Promise<InstallOutcome>;
  cancel(): void;
};

type Frame = { protocolVersion?: unknown; ok?: unknown; stage?: unknown; skipped?: unknown; reason?: unknown; remedy?: unknown; stages?: unknown };

function lastJsonLine(stdout: string): Frame | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{"));
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  try {
    return JSON.parse(last) as Frame;
  } catch {
    return null;
  }
}

/** Runs the native install stages, one child process each, and stops on the first failure. */
export function createInstaller(options: {
  readonly runtime: RuntimePaths;
  readonly userData: string;
  readonly base: NodeJS.ProcessEnv;
  readonly port?: number;
  readonly spawn?: (command: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; detached: boolean; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess;
}): Installer {
  const spawn = options.spawn ?? spawnChild;
  const paths = options.runtime;
  let active: ChildProcess | undefined;
  let cancelled = false;

  const child = (args: readonly string[], onLine: (line: string) => void): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const process_ = spawn(paths.binary, args, {
        cwd: paths.directory,
        env: runtimeEnvironment({ userData: options.userData, port: options.port ?? DEFAULT_PORT, base: options.base }),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      active = process_;
      let stdout = "";
      let stderr = "";
      let pending = "";
      process_.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      process_.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim() !== "") onLine(line);
      });
      const finish = (code: number): void => {
        if (pending.trim() !== "") onLine(pending);
        active = undefined;
        resolve({ code, stdout, stderr });
      };
      process_.once("error", (error) => { stderr += `${error.message}\n`; finish(-1); });
      process_.once("exit", (code) => { finish(code ?? -1); });
    });

  return {
    async run(from, emit): Promise<InstallOutcome> {
      cancelled = false;
      await mkdir(join(options.userData, "logs"), { recursive: true });
      const file: WriteStream = createWriteStream(join(options.userData, "logs", `install-${new Date().toISOString().replaceAll(":", "-")}.log`), { flags: "a" });
      const record = (line: string): void => { file.write(`${line}\n`); emit({ name: "log", line }); };
      const fail = (stage: string, title: string, reason: string, remedy: string | null): InstallOutcome => {
        record(reason);
        emit({ name: "failed", stage, title, reason, remedy });
        return "failed";
      };
      try {
        const manifest = await child(["install", "--manifest"], record);
        if (cancelled) return "cancelled";
        const parsed = lastJsonLine(manifest.stdout);
        const listed: unknown[] = manifest.code === 0 && parsed?.protocolVersion === 1 && Array.isArray(parsed.stages) ? parsed.stages : [];
        const stages: InstallStage[] = listed.flatMap((entry) => {
          const stage = entry as { name?: unknown; title?: unknown };
          return typeof stage.name === "string" && typeof stage.title === "string" ? [{ name: stage.name, title: stage.title }] : [];
        });
        if (stages.length === 0) return fail("", "Read the install steps", `Suplex could not read the install steps (exit ${manifest.code}).`, manifest.stderr.trim() || null);
        const start = from === null ? 0 : Math.max(0, stages.findIndex((stage) => stage.name === from));
        emit({ name: "stages", stages, from: start });
        for (const stage of stages.slice(start)) {
          emit({ name: "stage-started", stage: stage.name });
          const began = Date.now();
          const result = await child(["install", "--stage", stage.name, "--json"], record);
          if (cancelled) return "cancelled";
          const frame = lastJsonLine(result.stdout);
          if (result.code !== 0 || frame?.ok !== true || frame.stage !== stage.name) {
            const reason = typeof frame?.reason === "string" ? frame.reason : `The step ended unexpectedly (exit ${result.code}).`;
            return fail(stage.name, stage.title, reason, typeof frame?.remedy === "string" ? frame.remedy : null);
          }
          emit({ name: "stage-finished", stage: stage.name, skipped: frame.skipped === true, elapsedMs: Date.now() - began });
        }
        emit({ name: "done" });
        return "complete";
      } finally {
        file.end();
      }
    },
    cancel(): void {
      cancelled = true;
      if (active?.pid === undefined) return;
      try {
        process.kill(-active.pid, "SIGTERM");
      } catch {
        /* the stage already finished */
      }
    },
  };
}
