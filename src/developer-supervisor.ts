import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, unlink, lstat } from "node:fs/promises";
import { createServer, createConnection, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createInterface } from "node:readline";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { compareProcessIdentity, defaultProcessController, type OwnedProcess, type ProcessController, type ProcessInspection } from "./process-manager.js";
import { DeveloperSupervisorHeartbeatSchema, DeveloperSupervisorInvocationSchema, DeveloperSupervisorRequestSchema, DeveloperSupervisorResponseSchema, DeveloperSupervisorSnapshotSchema, sha256, withSupervisorResultHash, type DeveloperSupervisorIdentity, type DeveloperSupervisorInvocation, type DeveloperSupervisorRequest, type DeveloperSupervisorResponse, type DeveloperSupervisorResult } from "./developer-supervisor-protocol.js";
import { redact } from "./logging.js";

const maxEventsBytes = 8 * 1024 * 1024;
const executionIdPattern = /^developer_[a-f0-9]{24}$/;
const unixSocketPathLimit = 100;

export function developerSupervisorSocketPath(executionRoot: string): string {
  const socketPath = join(resolve(executionRoot), "control.sock");
  if (Buffer.byteLength(socketPath) <= unixSocketPathLimit) return socketPath;
  return join("/private/tmp", `forge-developer-${createHash("sha256").update(socketPath).digest("hex").slice(0, 24)}.sock`);
}

function identity(inspection: ProcessInspection): DeveloperSupervisorIdentity {
  return { pid: inspection.pid, processGroup: inspection.processGroup, startTime: inspection.startTime, executable: inspection.executable, argv: inspection.argv, ownerUid: inspection.ownerUid ?? null };
}

function owned(value: DeveloperSupervisorIdentity): OwnedProcess {
  return { name: "developer", pid: value.pid, command: value.argv.join(" "), startedAt: value.startTime, processGroup: value.processGroup, startTime: value.startTime, executable: value.executable, argv: value.argv, ...(value.ownerUid !== null ? { ownerUid: value.ownerUid } : {}) };
}

async function rejectSymlinks(root: string, target: string): Promise<void> {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const path = relative(absoluteRoot, absoluteTarget);
  if (path === ".." || path.startsWith(`..${sep}`) || path.includes(`${sep}..${sep}`)) throw new Error("Developer supervisor path escapes execution root");
  let current = absoluteRoot;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Developer supervisor path cannot traverse a symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, path);
}

async function appendLine(path: string, line: string): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try { await handle.write(`${line}\n`); } finally { await handle.close(); }
}

function tokenMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readSupervisorToken(): string {
  const token = readFileSync(3, "utf8").trim();
  if (!token || token.length > 256) throw new Error("Developer supervisor lease token is invalid");
  return token;
}

async function inspect(controller: ProcessController, pid: number): Promise<ProcessInspection> {
  const result = await controller.inspect(pid);
  if (!result) throw new Error("Developer process identity is unavailable");
  return result;
}

async function acquireStartLock(root: string, supervisor: DeveloperSupervisorIdentity): Promise<boolean> {
  const path = join(root, "start-lock.json");
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(supervisor)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

interface SupervisorState {
  executionRoot: string;
  executionId: string;
  token: string;
  tokenHash: string;
  controller: ProcessController;
  supervisor: DeveloperSupervisorIdentity;
  child: DeveloperSupervisorIdentity;
  childProcess: ChildProcess;
  gitGuardDirectory: string | null;
  status: "starting" | "running" | "result_ready" | "cancelling" | "terminated" | "failed";
  heartbeatAt: string;
  startedAt: string;
  sequence: number;
  outputTruncated: boolean;
  eventsBytes: number;
  termSentAt: string | null;
  killSentAt: string | null;
  confirmedExitAt: string | null;
  finished: Promise<DeveloperSupervisorResult | undefined>;
  resolveFinished: (result: DeveloperSupervisorResult | undefined) => void;
  pendingControlRequests: Set<Promise<void>>;
  cancellationTask: Promise<CancellationOutcome> | null;
}

async function writeSnapshot(state: SupervisorState, resultHash?: string, exitCode?: number | null, exitSignal?: string | null): Promise<void> {
  const snapshot = DeveloperSupervisorSnapshotSchema.parse({ version: 1, executionId: state.executionId, status: state.status, supervisor: state.supervisor, child: state.child, heartbeatAt: state.heartbeatAt, ...(resultHash ? { resultHash } : {}), ...(exitCode !== undefined ? { exitCode } : {}), ...(exitSignal !== undefined ? { exitSignal } : {}), ...(state.termSentAt ? { termSentAt: state.termSentAt } : {}), ...(state.killSentAt ? { killSentAt: state.killSentAt } : {}), ...(state.confirmedExitAt ? { confirmedExitAt: state.confirmedExitAt } : {}) });
  await atomicWriteJson(join(state.executionRoot, "supervisor.json"), snapshot);
}

async function writeHeartbeat(state: SupervisorState): Promise<void> {
  state.heartbeatAt = new Date().toISOString();
  await atomicWriteJson(join(state.executionRoot, "heartbeat.json"), DeveloperSupervisorHeartbeatSchema.parse({ version: 1, executionId: state.executionId, status: state.status, heartbeatAt: state.heartbeatAt }));
}

type ProcessExitObservation = "running" | "exited" | "ownership_ambiguous";

export async function observeOwnedProcessExit(controller: ProcessController, child: DeveloperSupervisorIdentity): Promise<ProcessExitObservation> {
  const leader = await controller.inspect(child.pid);
  if (leader) return compareProcessIdentity(owned(child), leader).kind === "exact_match" ? "running" : "ownership_ambiguous";
  if (controller.isProcessGroupAlive && await controller.isProcessGroupAlive(child.processGroup)) return "running";
  return "exited";
}

async function waitForGroupExit(state: SupervisorState, graceMs: number): Promise<Exclude<ProcessExitObservation, "running"> | "timed_out"> {
  const deadline = Date.now() + graceMs;
  while (Date.now() <= deadline) {
    const observation = await observeOwnedProcessExit(state.controller, state.child);
    if (observation !== "running") return observation;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return "timed_out";
}

type CancellationOutcome = "confirmed" | "ownership_ambiguous" | "termination_failed";

async function finishCancellation(state: SupervisorState, termGraceMs: number, killGraceMs: number): Promise<CancellationOutcome> {
  const current = await state.controller.inspect(state.child.pid);
  if (!current || compareProcessIdentity(owned(state.child), current).kind !== "exact_match") return "ownership_ambiguous";
  await writeSnapshot(state);
  try { await state.controller.signalGroup?.(state.child.processGroup, "SIGTERM"); }
  catch { return "termination_failed"; }
  state.termSentAt = new Date().toISOString();
  await writeSnapshot(state);
  const afterTerm = await waitForGroupExit(state, termGraceMs);
  if (afterTerm === "ownership_ambiguous") return "ownership_ambiguous";
  if (afterTerm === "exited") {
    state.confirmedExitAt = new Date().toISOString();
    await writeSnapshot(state);
    return "confirmed";
  }
  const beforeKill = await state.controller.inspect(state.child.pid);
  if (beforeKill && compareProcessIdentity(owned(state.child), beforeKill).kind !== "exact_match") return "ownership_ambiguous";
  state.killSentAt = new Date().toISOString();
  try { await state.controller.signalGroup?.(state.child.processGroup, "SIGKILL"); }
  catch { return "termination_failed"; }
  await writeSnapshot(state);
  const afterKill = await waitForGroupExit(state, killGraceMs);
  if (afterKill === "ownership_ambiguous") return "ownership_ambiguous";
  if (afterKill !== "exited") return "termination_failed";
  state.confirmedExitAt = new Date().toISOString();
  await writeSnapshot(state);
  return "confirmed";
}

async function cancelChild(state: SupervisorState, termGraceMs: number, killGraceMs: number): Promise<DeveloperSupervisorResponse> {
  if (state.cancellationTask) {
    await state.cancellationTask;
    if (state.confirmedExitAt) return { version: 1, status: "terminated", supervisor: state.supervisor, child: state.child, heartbeatAt: state.heartbeatAt, termSentAt: state.termSentAt, killSentAt: state.killSentAt, confirmedExitAt: state.confirmedExitAt };
    return { version: 1, status: "termination_failed", reasonCode: "developer-exit-unconfirmed", summary: "Forge could not confirm Developer process termination after signalling it." };
  }
  state.status = "cancelling";
  const task = finishCancellation(state, termGraceMs, killGraceMs);
  state.cancellationTask = task;
  const outcome = await task.finally(() => { state.cancellationTask = null; });
  if (outcome === "ownership_ambiguous") {
    state.status = "failed";
    await writeSnapshot(state);
    return { version: 1, status: "ownership_ambiguous", reasonCode: "developer-child-identity-changed", summary: "Forge stopped cancellation because the Developer process identity changed." };
  }
  if (outcome === "termination_failed") {
    state.status = "failed";
    await writeSnapshot(state);
    return { version: 1, status: "termination_failed", reasonCode: "developer-exit-unconfirmed", summary: "Forge could not confirm Developer process termination after signalling it." };
  }
  state.status = "terminated";
  await writeSnapshot(state);
  return { version: 1, status: "terminated", supervisor: state.supervisor, child: state.child, heartbeatAt: state.heartbeatAt, termSentAt: state.termSentAt, killSentAt: state.killSentAt, confirmedExitAt: state.confirmedExitAt };
}

async function handleSocketRequest(state: SupervisorState, request: DeveloperSupervisorRequest, token: string): Promise<DeveloperSupervisorResponse | null> {
  if (request.executionId !== state.executionId || !tokenMatches(request.leaseToken, token)) return { version: 1, status: "ownership_ambiguous", reasonCode: "developer-supervisor-request-identity-mismatch", summary: "Forge cannot prove ownership of the previous Developer process." };
  if (request.command === "status") {
    return DeveloperSupervisorResponseSchema.parse({ version: 1, status: state.status, supervisor: state.supervisor, child: state.child, heartbeatAt: state.heartbeatAt, ...(state.termSentAt ? { termSentAt: state.termSentAt } : {}), ...(state.killSentAt ? { killSentAt: state.killSentAt } : {}), ...(state.confirmedExitAt ? { confirmedExitAt: state.confirmedExitAt } : {}) });
  }
  return cancelChild(state, request.termGraceMs, request.killGraceMs);
}

function socketRequest(socketPath: string, request: DeveloperSupervisorRequest): Promise<DeveloperSupervisorResponse | null> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(socketPath);
    let data = "";
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error("Developer supervisor socket timed out")); }, 60_000);
    // Keep the writable side open while the supervisor performs a bounded
    // cancellation. Half-closing here causes Node's default allowHalfOpen=false
    // server socket to close before a delayed TERM/KILL response can be sent.
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => { data += chunk.toString("utf8"); if (data.includes("\n")) { clearTimeout(timeout); socket.destroy(); try { resolvePromise(DeveloperSupervisorResponseSchema.parse(JSON.parse(data.trim()))); } catch (error) { reject(error); } } });
    socket.on("error", (error) => { clearTimeout(timeout); reject(error); });
    socket.on("close", () => { clearTimeout(timeout); if (!data) reject(new Error("Developer supervisor closed the control socket without a response")); });
  });
}

export async function requestDeveloperSupervisor(executionRoot: string, request: DeveloperSupervisorRequest): Promise<DeveloperSupervisorResponse | null> {
  return socketRequest(developerSupervisorSocketPath(executionRoot), DeveloperSupervisorRequestSchema.parse(request));
}

export function developerSupervisorCommand(): { command: string; args: string[] } {
  const sourcePath = fileURLToPath(new URL("./developer-supervisor.ts", import.meta.url));
  const currentPath = fileURLToPath(import.meta.url);
  if (currentPath.endsWith(".ts")) return { command: process.execPath, args: ["--import", "tsx", sourcePath] };
  return { command: process.execPath, args: [fileURLToPath(new URL("./developer-supervisor.js", import.meta.url))] };
}

export function spawnDeveloperSupervisor(executionRoot: string, token: string, invocation: DeveloperSupervisorInvocation): ChildProcess {
  const command = developerSupervisorCommand();
  const child = spawn(command.command, [...command.args, executionRoot], { detached: true, stdio: ["ignore", "ignore", "ignore", "pipe"], env: process.env });
  const tokenStream = child.stdio[3];
  if (!tokenStream || typeof tokenStream === "string" || !("end" in tokenStream)) throw new Error("Developer supervisor token pipe was not created");
  tokenStream.end(token);
  child.unref();
  void invocation;
  return child;
}

async function startSocket(state: SupervisorState): Promise<ReturnType<typeof createServer>> {
  const socketPath = developerSupervisorSocketPath(state.executionRoot);
  await rm(socketPath, { force: true });
  const server = createServer((socket: Socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (!data.includes("\n")) return;
      const line = data.slice(0, data.indexOf("\n"));
      let request: DeveloperSupervisorRequest;
      try { request = DeveloperSupervisorRequestSchema.parse(JSON.parse(line)); } catch { socket.end(`${JSON.stringify({ version: 1, status: "termination_failed", reasonCode: "developer-supervisor-request-invalid", summary: "Forge rejected the malformed Developer supervisor request." })}\n`); return; }
      const operation = handleSocketRequest(state, request, state.token).then((response) => {
        if (response) socket.end(`${JSON.stringify(response)}\n`);
        else socket.destroy();
      }).catch(() => { socket.end(`${JSON.stringify({ version: 1, status: "termination_failed", reasonCode: "developer-supervisor-handler-failed", summary: "Forge could not complete the bounded Developer supervisor operation." })}\n`); });
      state.pendingControlRequests.add(operation);
      void operation.finally(() => state.pendingControlRequests.delete(operation));
    });
  });
  await new Promise<void>((resolvePromise, reject) => { server.once("error", reject); server.listen(socketPath, () => resolvePromise()); });
  return server;
}

async function finalize(state: SupervisorState, childExit: { code: number | null; signal: NodeJS.Signals | null }, eventsPath: string): Promise<DeveloperSupervisorResult> {
  const output = await readFile(eventsPath);
  const resultBase = { version: 1 as const, executionId: state.executionId, leaseTokenHash: state.tokenHash, supervisor: state.supervisor, child: state.child, exitCode: childExit.code, exitSignal: childExit.signal, outputPath: "events.jsonl" as const, outputSha256: sha256(output), outputTruncated: state.outputTruncated, startedAt: state.startedAt, finishedAt: new Date().toISOString() };
  const result = withSupervisorResultHash(resultBase);
  const temporary = join(state.executionRoot, "result.json.tmp");
  await atomicWriteJson(temporary, result);
  await rename(temporary, join(state.executionRoot, "result.json"));
  state.status = "result_ready";
  await writeHeartbeat(state);
  await writeSnapshot(state, result.resultHash, childExit.code, childExit.signal);
  if (state.gitGuardDirectory) await rm(state.gitGuardDirectory, { recursive: true, force: true });
  state.resolveFinished(result);
  return result;
}

export async function runDeveloperSupervisor(executionRoot: string, options: { controller?: ProcessController } = {}): Promise<DeveloperSupervisorResult | undefined> {
  const root = resolve(executionRoot);
  const executionId = basename(root);
  if (!executionIdPattern.test(executionId) || basename(dirname(root)) !== "developer-executions") throw new Error("Developer supervisor execution root is invalid");
  await rejectSymlinks(dirname(dirname(root)), root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const token = readSupervisorToken();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const controller = options.controller ?? defaultProcessController;
  const supervisorInspection = await inspect(controller, process.pid);
  const supervisor = identity(supervisorInspection);
  // The immutable start lock is the one-child gate. Retried Activities may
  // race to launch a supervisor, but only the process that creates this file
  // is allowed to spawn the external Developer process.
  if (!(await acquireStartLock(root, supervisor))) return undefined;
  const heartbeatAt = new Date().toISOString();
  await atomicWriteJson(join(root, "supervisor.json"), DeveloperSupervisorSnapshotSchema.parse({ version: 1, executionId, status: "starting", supervisor, child: null, heartbeatAt }));
  await atomicWriteJson(join(root, "heartbeat.json"), DeveloperSupervisorHeartbeatSchema.parse({ version: 1, executionId, status: "starting", heartbeatAt }));
  const eventsPath = join(root, "events.jsonl");
  try {
    const events = await open(eventsPath, "wx", 0o600);
    await events.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const invocationPath = join(root, "invocation.json");
  let invocation: DeveloperSupervisorInvocation;
  try {
    invocation = DeveloperSupervisorInvocationSchema.parse(JSON.parse(await readFile(invocationPath, "utf8")));
  } catch (error) {
    const failedAt = new Date().toISOString();
    await atomicWriteJson(join(root, "supervisor.json"), DeveloperSupervisorSnapshotSchema.parse({ version: 1, executionId, status: "failed", supervisor, child: null, heartbeatAt: failedAt }));
    await atomicWriteJson(join(root, "heartbeat.json"), DeveloperSupervisorHeartbeatSchema.parse({ version: 1, executionId, status: "failed", heartbeatAt: failedAt }));
    throw error;
  }
  if (invocation.executionId !== executionId) throw new Error("Developer supervisor invocation identity mismatch");
  const childProcess = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...invocation.env } });
  const childExitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    childProcess.once("error", reject);
    childProcess.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  const childInspection = await inspect(controller, childProcess.pid ?? -1);
  const child = identity(childInspection);
  let resolveFinished!: (result: DeveloperSupervisorResult | undefined) => void;
  const finished = new Promise<DeveloperSupervisorResult | undefined>((resolvePromise) => { resolveFinished = resolvePromise; });
  const gitGuardDirectory = invocation.env.FORGE_GIT_GUARD_DIR && resolve(invocation.env.FORGE_GIT_GUARD_DIR).startsWith(`${root}${sep}`) ? resolve(invocation.env.FORGE_GIT_GUARD_DIR) : null;
  const state: SupervisorState = { executionRoot: root, executionId, token, tokenHash, controller, supervisor, child, childProcess, gitGuardDirectory, status: "starting", heartbeatAt, startedAt: heartbeatAt, sequence: 0, outputTruncated: false, eventsBytes: 0, termSentAt: null, killSentAt: null, confirmedExitAt: null, pendingControlRequests: new Set(), cancellationTask: null, finished, resolveFinished };
  await unlink(invocationPath).catch(() => undefined);
  state.status = "running";
  await writeSnapshot(state);
  await writeHeartbeat(state);
  const server = await startSocket(state);
  const heartbeat = setInterval(() => void writeHeartbeat(state), 2_000);
  heartbeat.unref();
  let eventWrite = Promise.resolve();
  const writeEvent = (stream: "stdout" | "stderr", line: string): Promise<void> => {
    const record = JSON.stringify({ sequence: state.sequence++, at: new Date().toISOString(), stream, line: redact(line) });
    const write = eventWrite.then(async () => {
      const bytes = Buffer.byteLength(`${record}\n`);
      if (state.eventsBytes + bytes > maxEventsBytes) {
        if (!state.outputTruncated) {
          state.outputTruncated = true;
          const marker = JSON.stringify({ sequence: state.sequence++, at: new Date().toISOString(), stream: "supervisor", line: "output_truncated" });
          if (state.eventsBytes + Buffer.byteLength(`${marker}\n`) <= maxEventsBytes) { await appendLine(join(root, "events.jsonl"), marker); state.eventsBytes += Buffer.byteLength(`${marker}\n`); }
        }
        return;
      }
      await appendLine(join(root, "events.jsonl"), record);
      state.eventsBytes += bytes;
    });
    eventWrite = write.catch(() => undefined);
    return write;
  };
  const readers: Promise<void>[] = [];
  const pendingWrites = new Set<Promise<void>>();
  for (const [stream, name] of [[childProcess.stdout, "stdout" as const], [childProcess.stderr, "stderr" as const]] as const) readers.push(new Promise<void>((resolvePromise, reject) => {
    if (!stream) { resolvePromise(); return; }
    const reader = createInterface({ input: stream });
    reader.on("line", (line) => {
      const pending = writeEvent(name, line).catch(reject);
      pendingWrites.add(pending);
      void pending.finally(() => pendingWrites.delete(pending));
    });
    reader.on("close", () => resolvePromise());
  }));
  const childExit = await childExitPromise;
  await Promise.race([Promise.all(readers), new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2_000))]);
  await Promise.allSettled([...pendingWrites]);
  if (state.cancellationTask) await Promise.allSettled([state.cancellationTask]);
  await Promise.allSettled([...state.pendingControlRequests]);
  clearInterval(heartbeat);
  server.close();
  return finalize(state, childExit, eventsPath);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runDeveloperSupervisor(process.argv[2] ?? "").catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "Developer supervisor failed"}\n`); process.exitCode = 1; });
}
