import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadConfig, type ForgeConfig } from "../config.js";
import { ForgeDatabase } from "../database.js";
import { upsertForgeEnvironment } from "../setup.js";
import type { DoctorCheck } from "../diagnostics/doctor.js";
import type { HealthCheck } from "../health.js";

export type StageOutcome = { ok: boolean; skipped?: boolean; reason?: string; remedy?: string };

export type InstallCommandResult = { exitCode: number | null; stdout: string; stderr: string };

export interface InstallContext {
  env: NodeJS.ProcessEnv;
  system: { platform: string; arch: string; release: string };
  run: (command: string, args: readonly string[], timeoutMs?: number) => Promise<InstallCommandResult>;
  progress: (line: string) => void;
  wait: (milliseconds: number) => Promise<void>;
  freeBytes: (path: string) => Promise<number>;
  herdrReadiness: () => Promise<HealthCheck>;
  doctor: (config: ForgeConfig) => Promise<DoctorCheck[]>;
}

export interface InstallStage {
  name: string;
  title: string;
  run: (context: InstallContext) => Promise<StageOutcome>;
}

const MINIMUM_FREE_BYTES = 2 * 1024 ** 3;
const MINIMUM_DARWIN_MAJOR = 22;
const DEVELOPER_TOOLS_TIMEOUT_MS = 30 * 60_000;
const HERDR_INSTALL_URL = "https://herdr.dev/install.sh";
const HERDR_READY_ATTEMPTS = 30;

function gigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

function herdrIsReachable(check: HealthCheck): boolean {
  return check.details.apiReachable === true;
}

const prerequisites: InstallStage = {
  name: "prerequisites",
  title: "Check this Mac",
  async run(context) {
    const { platform, arch, release } = context.system;
    if (platform !== "darwin") {
      return { ok: false, reason: `Forge runs on macOS and this computer reports ${platform}.`, remedy: "Install Forge on a Mac with Apple silicon." };
    }
    if (Number(release.split(".")[0]) < MINIMUM_DARWIN_MAJOR) {
      return { ok: false, reason: `Forge needs macOS 13 or newer and this Mac reports Darwin ${release}.`, remedy: "Update macOS in System Settings, then try again." };
    }
    if (arch !== "arm64") {
      return { ok: false, reason: `Forge needs a Mac with Apple silicon and this Mac reports ${arch}.`, remedy: "Run Forge on an Apple silicon Mac." };
    }
    const free = await context.freeBytes(resolve(context.env.FORGE_DATA_ROOT ?? ".forge/data"));
    if (free < MINIMUM_FREE_BYTES) {
      return { ok: false, reason: `Forge needs 2 GB of free space and this disk has ${gigabytes(free)} GB.`, remedy: "Free up disk space, then try again." };
    }
    return { ok: true, reason: `macOS ${release} on ${arch} with ${gigabytes(free)} GB free` };
  },
};

const developerTools: InstallStage = {
  name: "developer-tools",
  title: "Install Apple developer tools (git)",
  async run(context) {
    const [git, tools] = await Promise.all([context.run("git", ["--version"]), context.run("xcode-select", ["-p"])]);
    if (git.exitCode === 0 && tools.exitCode === 0) {
      return { ok: true, skipped: true, reason: `${git.stdout.trim()} already installed` };
    }
    if (git.exitCode !== 0) context.progress(`git --version failed: ${git.stderr.trim() || `exit ${git.exitCode}`}`);
    if (/agreed to the Xcode/.test(`${git.stdout}${git.stderr}`)) {
      context.progress("Accepting the Xcode license; macOS asks for an administrator password");
      const accepted = await context.run("osascript", ["-e", 'do shell script "xcodebuild -license accept" with administrator privileges']);
      const retry = accepted.exitCode === 0 ? await context.run("git", ["--version"]) : accepted;
      if (retry.exitCode === 0) return { ok: true, reason: `${retry.stdout.trim()} after accepting the Xcode license` };
      return { ok: false, reason: `git needs the Xcode license accepted: ${(accepted.stderr || retry.stderr).trim() || "the password dialog was cancelled"}`, remedy: "Open Terminal, run: sudo xcodebuild -license accept, then try again." };
    }
    context.progress("Asking macOS to install the Apple developer tools");
    const request = await context.run("xcode-select", ["--install"]);
    // xcode-select exits non-zero when the installer is already open; the poll below decides the outcome either way.
    if (request.exitCode !== 0) context.progress(request.stderr.trim() || `xcode-select --install exited ${request.exitCode}`);
    if (/already installed/.test(`${request.stdout}${request.stderr}`)) {
      return { ok: false, reason: `macOS says the developer tools are installed, but git does not work: ${git.stderr.trim() || `exit ${git.exitCode}`}`, remedy: "Open Terminal and run: sudo rm -rf /Library/Developer/CommandLineTools && xcode-select --install, finish the dialog, then try again." };
    }
    for (let elapsed = 0; elapsed < DEVELOPER_TOOLS_TIMEOUT_MS; elapsed += 5_000) {
      await context.wait(5_000);
      const retry = await context.run("git", ["--version"]);
      if (retry.exitCode === 0) return { ok: true, reason: retry.stdout.trim() };
      if (elapsed % 60_000 === 0) context.progress(`Waiting for the Apple developer tools (${elapsed / 60_000 + 1} min)`);
    }
    return { ok: false, reason: "The Apple developer tools did not finish installing within 30 minutes.", remedy: "Finish the macOS developer tools dialog, then try again." };
  },
};

const herdr: InstallStage = {
  name: "herdr",
  title: "Install Herdr terminals",
  async run(context) {
    const installed = (await context.run("herdr", ["--version"])).exitCode === 0;
    if (!installed) {
      context.progress("Downloading the Herdr installer");
      const script = join(tmpdir(), "forge-herdr-install.sh");
      const download = await context.run("curl", ["-fsSL", "-o", script, HERDR_INSTALL_URL], 120_000);
      if (download.exitCode !== 0) {
        return { ok: false, reason: `curl exited ${download.exitCode}`, remedy: "Check the network connection and try again." };
      }
      context.progress("Installing Herdr");
      const install = await context.run("sh", [script], 300_000);
      if (install.exitCode !== 0) {
        return { ok: false, reason: install.stderr.trim().split("\n").at(-1) || `The Herdr installer exited ${install.exitCode}`, remedy: "Check the network connection and try again." };
      }
      if ((await context.run("herdr", ["--version"])).exitCode !== 0) {
        return { ok: false, reason: "Herdr installed but is not on the PATH.", remedy: "Add ~/.local/bin to PATH, then try again." };
      }
    }
    let readiness = await context.herdrReadiness();
    const running = herdrIsReachable(readiness);
    if (!running) {
      const status = await context.run("herdr", ["status", "server", "--json"]);
      let stale = false;
      try { const parsed = JSON.parse(status.stdout) as { running?: boolean; restart_needed?: boolean; compatible?: boolean; version?: string }; stale = parsed.running === true && (parsed.restart_needed === true || parsed.compatible === false); if (stale) context.progress(`Stopping the old Herdr server (${parsed.version ?? "unknown version"}) so the new one can start`); } catch {}
      if (stale) {
        const stop = await context.run("herdr", ["server", "stop"], 30_000);
        if (stop.exitCode !== 0) context.progress(`herdr server stop exited ${stop.exitCode}: ${(stop.stderr || stop.stdout).trim()}`);
      }
      context.progress("Starting the Herdr server");
      // `herdr` attaches a TUI and needs a terminal; `herdr server` is the headless entry point.
      await context.run("sh", ["-c", "nohup herdr server >/dev/null 2>&1 &"]);
      let reported = "";
      for (let attempt = 0; attempt < HERDR_READY_ATTEMPTS && !herdrIsReachable(readiness); attempt += 1) {
        await context.wait(1_000);
        readiness = await context.herdrReadiness();
        const detail = `${readiness.summary} (${String(readiness.details?.failure ?? "")}; server ${String(readiness.details?.serverVersion ?? "unknown")})`;
        if (detail !== reported) { context.progress(detail); reported = detail; }
      }
      if (!herdrIsReachable(readiness)) {
        const probe = await context.run("herdr", ["workspace", "list"]);
        context.progress(`herdr workspace list exited ${probe.exitCode}: ${(probe.stderr || probe.stdout).trim()}`);
        const status = await context.run("herdr", ["status", "server", "--json"]);
        context.progress(`herdr status server: ${status.stdout.trim()}`);
      }
    }
    if (!herdrIsReachable(readiness)) {
      return { ok: false, reason: readiness.summary, remedy: readiness.remedy ?? "Open Terminal, run herdr, then try again." };
    }
    return { ok: true, skipped: installed && running, reason: readiness.summary };
  },
};

const data: InstallStage = {
  name: "data",
  title: "Prepare Forge data",
  async run(context) {
    const config = loadConfig(context.env);
    const envFile = resolve(context.env.FORGE_ENV_FILE ?? ".forge/forge.env");
    const existingEnvironment = await readFile(envFile, "utf8").catch(() => "");
    const existingDatabase = await stat(config.databasePath).then(() => true, () => false);
    await mkdir(config.dataRoot, { recursive: true });
    await upsertForgeEnvironment(envFile, {
      FORGE_ACCESS_MODE: "local",
      FORGE_BIND_ADDRESS: "127.0.0.1",
      FORGE_PORT: String(config.port),
    });
    const configured = existingEnvironment === await readFile(envFile, "utf8");
    const database = new ForgeDatabase(config.databasePath);
    try {
      const schema = database.schemaStatus();
      const reason = `schema ${schema.state} (${schema.applied.length}/${schema.expected.length} migrations)`;
      return schema.state === "current"
        ? { ok: true, skipped: configured && existingDatabase, reason }
        : { ok: false, reason, remedy: "Move the Forge data folder aside and run the install again." };
    } finally {
      database.close();
    }
  },
};

const complete: InstallStage = {
  name: "complete",
  title: "Finish",
  async run(context) {
    const checks = await context.doctor(loadConfig(context.env));
    const failed = checks.find((check) => check.status === "FAIL");
    if (failed) {
      return { ok: false, reason: `${failed.name}: ${failed.detail}`, remedy: "Fix the failing check and run the install again." };
    }
    return { ok: true, reason: `${checks.length} checks passed` };
  },
};

export const installStages: readonly InstallStage[] = [prerequisites, developerTools, herdr, data, complete];

export function installStage(name: string): InstallStage | undefined {
  return installStages.find((stage) => stage.name === name);
}
