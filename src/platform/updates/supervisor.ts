// eslint-disable-next-line no-restricted-imports
import { fork, spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve } from "node:path";
import type { UpdateResponse, UpdateStatus } from "../../http/contracts/update.js";

type UpdateStep = Extract<UpdateStatus, { kind: "applying" }>["step"];
type UpdateSnapshot = Omit<UpdateResponse, "canRestart"> & { canRestart: true };
type ChildRequest = { kind: "update:read"; requestId: string; check: boolean } | { kind: "update:apply"; requestId: string };
type ChildMessage = ChildRequest | { kind: "ready"; instanceId: string; currentRevision?: string };
type CommandResult = { code: number; stdout: string; stderr: string };

const FORGE_REPOSITORY = "meiji-industries/forge";
const PACKAGED_UPDATE_MESSAGE = "Updates come with the desktop app.";
const MAIN_BRANCH = "main";
const READY_TIMEOUT_MS = 30_000;

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signalCommand(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { child.kill(signal); return; }
  }
  child.kill(signal);
}

function commandAlive(child: ChildProcess): boolean {
  if (process.platform === "win32" || !child.pid) return child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function childMessage(value: unknown): ChildMessage | undefined {
  if (!value || typeof value !== "object" || !("kind" in value)) return undefined;
  const record = Object.fromEntries(Object.entries(value));
  if (record.kind === "ready" && typeof record.instanceId === "string" && (record.currentRevision === undefined || typeof record.currentRevision === "string")) {
    return { kind: "ready", instanceId: record.instanceId, ...(typeof record.currentRevision === "string" ? { currentRevision: record.currentRevision } : {}) };
  }
  if (record.kind === "update:read" && typeof record.requestId === "string" && typeof record.check === "boolean") return { kind: "update:read", requestId: record.requestId, check: record.check };
  if (record.kind === "update:apply" && typeof record.requestId === "string") return { kind: "update:apply", requestId: record.requestId };
  return undefined;
}

function requiredRevision(value: string): string {
  const revision = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("git returned an invalid commit revision");
  return revision;
}

function repositoryPath(pathname: string): string | undefined {
  const normalized = pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized) ? normalized.toLowerCase() : undefined;
}

export function canonicalForgeRepository(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  const scp = /^git@github\.com:([^\s]+)$/i.exec(trimmed);
  if (scp?.[1]) return repositoryPath(scp[1]) === FORGE_REPOSITORY;
  try {
    const url = new URL(trimmed);
    const https = url.protocol === "https:";
    const ssh = url.protocol === "ssh:" || url.protocol === "git+ssh:";
    if ((!https && !ssh) || url.hostname.toLowerCase() !== "github.com" || url.search || url.hash) return false;
    if (https && (url.username || url.password)) return false;
    if (ssh && (url.username !== "git" || url.password || (url.port && url.port !== "22"))) return false;
    return repositoryPath(url.pathname) === FORGE_REPOSITORY;
  } catch {
    return false;
  }
}

function packagedStatus(action: "check" | "apply"): UpdateStatus {
  return { kind: "failed", action, message: PACKAGED_UPDATE_MESSAGE, error: "This Forge ships inside Forge.app; install the new app to update it." };
}

export class ForgeSupervisor {
  private readonly root: string;
  private readonly watchMode: boolean;
  private readonly packaged: boolean;
  private child: ChildProcess | undefined;
  private watcher: FSWatcher | undefined;
  private activeCommand: ChildProcess | undefined;
  private activeCommandDone: Promise<unknown> | undefined;
  private activeCommandStop: { child: ChildProcess; promise: Promise<void> } | undefined;
  private status: UpdateStatus = { kind: "idle" };
  private currentRevision: string | undefined;
  private availableRevision: string | undefined;
  private instanceId: string | undefined;
  private checkFlight: Promise<void> | undefined;
  private applyFlight: Promise<void> | undefined;
  private stopping = false;
  private updating = false;
  private watchTimer: NodeJS.Timeout | undefined;
  private watchFlight: Promise<void> | undefined;

  constructor(root: string, watchMode: boolean, packaged = process.env.FORGE_PACKAGED === "1") {
    this.root = root;
    this.watchMode = watchMode;
    this.packaged = packaged;
  }

  async run(): Promise<void> {
    this.installSignalHandlers();
    try { this.currentRevision = this.packaged ? undefined : await this.readHead(); } catch { this.currentRevision = undefined; }
    await this.startChild();
    if (this.watchMode) this.startWatcher();
  }


  snapshot(): UpdateSnapshot {
    return {
      status: this.status,
      ...(this.currentRevision ? { currentRevision: this.currentRevision } : {}),
      ...(this.availableRevision ? { availableRevision: this.availableRevision } : {}),
      ...(this.instanceId ? { instanceId: this.instanceId } : {}),
      canRestart: true,
    };
  }

  private childEntry(): { modulePath: string; execArgv: string[] } {
    const source = extname(fileURLToPath(import.meta.url)) === ".ts";
    return source
      ? { modulePath: join(this.root, "src/server.ts"), execArgv: ["--import", "tsx"] }
      : { modulePath: resolve(dirname(fileURLToPath(import.meta.url)), "../../server.js"), execArgv: [] };
  }

  private async startChild(): Promise<void> {
    if (this.stopping) return;
    const entry = this.childEntry();
    let startRevision: string | undefined;
    try { startRevision = this.packaged ? undefined : await this.readHead(); } catch { startRevision = undefined; }
    const child = fork(entry.modulePath, [], { cwd: this.root, env: process.env, execArgv: entry.execArgv, stdio: ["inherit", "inherit", "inherit", "ipc"] });
    this.child = child;
    await new Promise<void>((resolveReady, reject) => {
      let settled = false;
      let timedOut = false;
      let escalation: NodeJS.Timeout | undefined;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        if (this.child === child) this.child = undefined;
        reject(error);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
      }, READY_TIMEOUT_MS);
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        fail(timedOut ? new Error("Forge API did not report readiness.") : new Error(`Forge API stopped before readiness (${signal ?? code ?? "unknown"}).`));
      };
      child.once("exit", onExit);
      child.once("error", (error) => fail(error));
      child.on("message", (message: unknown) => {
        const typed = childMessage(message);
        if (!typed) return;
        if (typed.kind === "ready") {
          if (settled || timedOut) return;
          settled = true;
          clearTimeout(timer);
          this.instanceId = typed.instanceId;
          this.currentRevision = typed.currentRevision ?? startRevision;
          child.off("exit", onExit);
          child.once("exit", () => { if (this.child === child) this.child = undefined; });
          resolveReady();
          return;
        }
        void this.handleRequest(child, typed).catch((error: unknown) => process.stderr.write(`Forge update IPC failed: ${text(error)}\n`));
      });
    });
  }

  private async handleRequest(child: ChildProcess, request: ChildRequest): Promise<void> {
    if (request.kind === "update:read") {
      if (request.check) await this.check();
      await this.send(child, { kind: "update:read-result", requestId: request.requestId, value: this.snapshot() });
      return;
    }
    const alreadyRunning = this.applyFlight !== undefined;
    if (!alreadyRunning) {
      this.status = { kind: "applying", step: "fetch", message: "Forge checks the update." };
      setTimeout(() => { if (!this.applyFlight && !this.stopping) this.applyFlight = this.apply().finally(() => { this.applyFlight = undefined; }); }, 100);
    }
    await this.send(child, { kind: "update:apply-result", requestId: request.requestId, value: { accepted: true, status: this.status } });
  }

  async check(): Promise<void> {
    if (this.packaged) { this.status = packagedStatus("check"); return; }
    if (this.applyFlight || this.updating) return;
    if (this.checkFlight) return this.checkFlight;
    this.checkFlight = this.performCheck().finally(() => { this.checkFlight = undefined; });
    return this.checkFlight;
  }

  private async performCheck(): Promise<void> {
    const priorApplyFailure = this.status.kind === "failed" && this.status.action === "apply" ? this.status : undefined;
    this.status = { kind: "checking" };
    try {
      const remoteRef = await this.fetchRemoteMain();
      const head = await this.readHead();
      const remote = requiredRevision((await this.git(["rev-parse", "--verify", `${remoteRef}^{commit}`])).stdout);
      const running = this.currentRevision ?? head;
      this.availableRevision = running === remote ? undefined : remote;
      if (head !== remote) await this.requireFastForward(head, remoteRef);
      this.status = priorApplyFailure ?? (running === remote ? { kind: "current" } : { kind: "available" });
    } catch (error) {
      this.status = priorApplyFailure ?? { kind: "failed", action: "check", message: "Forge could not check for an update.", error: text(error) };
    }
  }

  async apply(): Promise<void> {
    if (this.packaged) { this.status = packagedStatus("apply"); return; }
    this.updating = true;
    this.pauseWatcher();
    let childStopped = false;
    try {
      if (this.watchFlight) await this.watchFlight;
      if (this.checkFlight) await this.checkFlight;
      this.setApplying("fetch", "Forge checks the update.");
      const remoteRef = await this.fetchRemoteMain();
      const head = await this.readHead();
      const remote = requiredRevision((await this.git(["rev-parse", "--verify", `${remoteRef}^{commit}`])).stdout);
      await this.requireFastForward(head, remoteRef);
      this.availableRevision = head === remote ? this.availableRevision : remote;

      this.setApplying("stop", "Forge stops the host.");
      await this.stopChild();
      childStopped = true;

      if (head !== remote) {
        this.setApplying("merge", "Forge applies the update.");
        await this.git(["merge", "--ff-only", remoteRef]);
      }
      this.setApplying("install", "Forge installs dependencies.");
      await this.command("pnpm", ["install", "--frozen-lockfile"], 5 * 60_000);
      if (process.env.FORGE_FRONTEND_DEV_SERVER !== "1") {
        this.setApplying("build", "Forge builds production assets.");
        await this.command("pnpm", ["run", "build"], 5 * 60_000);
      }

      this.setApplying("start", "Forge starts the host.");
      await this.startChild();
      this.availableRevision = undefined;
      this.status = { kind: "current" };
    } catch (error) {
      const original = text(error);
      let restartError: string | undefined;
      if (childStopped && !this.stopping && !this.child) {
        try { await this.startChild(); } catch (restartFailure) { restartError = text(restartFailure); }
      }
      this.status = {
        kind: "failed",
        action: "apply",
        message: "Forge could not apply the update.",
        error: restartError ? `${original}\nForge could not restart the current checkout: ${restartError}` : original,
      };
    } finally {
      this.updating = false;
      if (this.watchMode && !this.stopping) this.startWatcher();
    }
  }

  private setApplying(step: UpdateStep, message: string): void {
    this.status = { kind: "applying", step, message };
  }

  private async resolveRemote(): Promise<string> {
    const branch = (await this.git(["symbolic-ref", "--short", "HEAD"])).stdout.trim();
    if (branch !== MAIN_BRANCH) throw new Error(`Forge updates require the ${MAIN_BRANCH} branch. The current branch is ${branch || "detached"}.`);
    const upstream = await this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], true);
    if (upstream.code === 0) {
      const value = upstream.stdout.trim();
      const slash = value.indexOf("/");
      const remote = slash > 0 ? value.slice(0, slash) : "";
      const remoteBranch = slash > 0 ? value.slice(slash + 1) : "";
      if (!remote || remoteBranch !== MAIN_BRANCH) throw new Error(`Forge main must track a ${MAIN_BRANCH} branch.`);
      await this.requireForgeRemote(remote);
      return remote;
    }
    const names = (await this.git(["remote"])).stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const matches: string[] = [];
    for (const name of names) if (canonicalForgeRepository((await this.git(["remote", "get-url", name])).stdout)) matches.push(name);
    if (matches.includes("origin")) return "origin";
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error("git found no remote for meiji-industries/forge.");
    throw new Error("git found multiple Forge remotes and no authoritative upstream.");
  }

  private async requireForgeRemote(remote: string): Promise<void> {
    if (!canonicalForgeRepository((await this.git(["remote", "get-url", remote])).stdout)) throw new Error("git upstream does not match meiji-industries/forge.");
  }

  private async fetchRemoteMain(): Promise<string> {
    const remote = await this.resolveRemote();
    const remoteRef = `refs/remotes/${remote}/${MAIN_BRANCH}`;
    await this.git(["fetch", "--no-tags", remote, `refs/heads/${MAIN_BRANCH}:${remoteRef}`]);
    return remoteRef;
  }

  private async requireFastForward(head: string, remoteRef: string): Promise<void> {
    const result = await this.git(["merge-base", "--is-ancestor", head, remoteRef], true);
    if (result.code !== 0) throw new Error("The Forge checkout has diverged from remote main. Resolve the branch before updating.");
  }

  private async readHead(): Promise<string> {
    return requiredRevision((await this.git(["rev-parse", "--verify", "HEAD^{commit}"])).stdout);
  }

  private git(args: string[], allowFailure = false): Promise<CommandResult> {
    return this.command("git", args, 30_000, allowFailure);
  }

  private command(command: string, args: string[], timeoutMs: number, allowFailure = false): Promise<CommandResult> {
    if (this.stopping) return Promise.reject(new Error("Forge update stopped."));
    const done = new Promise<CommandResult>((resolveCommand, reject) => {
      const child = spawn(command, args, { cwd: this.root, env: process.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      this.activeCommand = child;
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const timer = setTimeout(() => {
        void this.stopCommand(child);
      }, timeoutMs);
      let settled = false;
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.activeCommand === child) this.activeCommand = undefined;
        reject(error);
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const stop = this.activeCommandStop?.child === child ? this.activeCommandStop.promise : Promise.resolve();
        void stop.then(() => {
          if (this.activeCommandStop?.child === child) this.activeCommandStop = undefined;
          if (this.activeCommand === child) this.activeCommand = undefined;
          const result = { code: code ?? 1, stdout, stderr };
          if (allowFailure || code === 0) resolveCommand(result);
          else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code ?? "unknown"})${stderr.trim() ? `\n${stderr.trim()}` : ""}`));
        });
      });
    });
    const tracked = done.finally(() => { if (this.activeCommandDone === tracked) this.activeCommandDone = undefined; });
    this.activeCommandDone = tracked;
    return tracked;
  }

  private stopCommand(child: ChildProcess): Promise<void> {
    if (this.activeCommandStop?.child === child) return this.activeCommandStop.promise;
    const promise = (async () => {
      signalCommand(child, "SIGTERM");
      const deadline = Date.now() + 5_000;
      while (commandAlive(child) && Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        await delay(25);
      }
      if (commandAlive(child)) signalCommand(child, "SIGKILL");
      const killDeadline = Date.now() + 5_000;
      while (commandAlive(child) && Date.now() < killDeadline) await delay(25);
    })();
    this.activeCommandStop = { child, promise };
    return promise;
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      if (this.child === child) this.child = undefined;
      return;
    }
    if (child.connected) {
      try { child.send?.({ kind: "shutdown" }, (error) => { if (error) child.kill("SIGTERM"); }); } catch { child.kill("SIGTERM"); }
    } else child.kill("SIGTERM");
    await new Promise<void>((resolveStopped) => {
      const force = setTimeout(() => child.kill("SIGTERM"), 5_000);
      const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.once("exit", () => { clearTimeout(force); clearTimeout(kill); resolveStopped(); });
    });
    if (this.child === child) this.child = undefined;
  }

  private startWatcher(): void {
    if (this.watcher || this.stopping || this.updating) return;
    this.watcher = watch(join(this.root, "src"), { recursive: true }, (_event, filename) => {
      const path = typeof filename === "string" ? filename.replaceAll("\\", "/") : "";
      if (this.updating || this.stopping || path.startsWith("frontend/")) return;
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => {
        if (!this.watchFlight) this.watchFlight = this.restartForWatch().finally(() => { this.watchFlight = undefined; });
      }, 150);
    });
  }

  private async restartForWatch(): Promise<void> {
    if (this.updating || this.stopping) return;
    try { await this.stopChild(); await this.startChild(); } catch (error) { process.stderr.write(`Forge watch restart failed: ${text(error)}\n`); }
  }

  private pauseWatcher(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }

  private send(child: ChildProcess, message: object): Promise<void> {
    return new Promise((resolveSent, reject) => {
      if (!child.connected) { reject(new Error("Forge API IPC disconnected.")); return; }
      try { child.send(message, (error) => error ? reject(error) : resolveSent()); } catch (error) { reject(error); }
    });
  }

  private installSignalHandlers(): void {
    const stop = (): void => {
      if (this.stopping) return;
      this.stopping = true;
      this.pauseWatcher();
      const commandStop = this.activeCommand ? this.stopCommand(this.activeCommand) : Promise.resolve();
      void commandStop.catch(() => undefined).then(() => this.activeCommandDone).catch(() => undefined).then(() => this.stopChild()).finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
}

async function main(): Promise<void> {
  const supervisor = new ForgeSupervisor(process.cwd(), process.argv.includes("--watch"));
  await supervisor.run();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => { process.stderr.write(`Forge supervisor stopped: ${text(error)}\n`); process.exitCode = 1; });
}
