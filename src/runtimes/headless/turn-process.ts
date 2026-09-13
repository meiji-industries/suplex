// eslint-disable-next-line no-restricted-imports -- detached process identity is this runtime's ownership boundary.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { withWorktreeMiseTrust } from "../../coordination/worker-environment.js";
import { compareProcessIdentity, executionProcessEnvironment, inspectProcessOnce, sessionProcessEnvironment, stopExecutionProcesses, stopOwnedProcesses, stopSessionProcesses, taskProcessEnvironment, type OwnedProcess } from "../../platform/process-manager.js";
import type { PromptDispatchAttempt } from "../../tasks/control.js";
import type { PromptIntent, TaskScope } from "../task-harness.js";

export const HeadlessTurnRecordSchema = z.object({
  generation: z.string().uuid(),
  turnId: z.string().min(1),
  sessionID: z.string().min(1),
  pid: z.number().int().positive(),
  processIdentity: z.object({
    command: z.string().min(1),
    executable: z.string().min(1),
    argv: z.array(z.string()),
    processGroup: z.number().int().positive(),
    startTime: z.string().min(1),
    ownerUid: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type HeadlessTurnRecord = z.infer<typeof HeadlessTurnRecordSchema>;

export function ownedHeadlessTurn(record: HeadlessTurnRecord): OwnedProcess {
  return { ...record.processIdentity, pid: record.pid, name: `headless-${record.generation}`, startedAt: record.processIdentity.startTime };
}

export async function readHeadlessTurnRecord(path: string): Promise<HeadlessTurnRecord | null> {
  try { return HeadlessTurnRecordSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
}

export async function readHeadlessText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
}

export async function headlessTurnRunning(record: HeadlessTurnRecord): Promise<boolean> {
  return compareProcessIdentity(ownedHeadlessTurn(record), await inspectProcessOnce(record.pid)).kind === "exact_match";
}

export function headlessTurnFiles(runtimeDirectory: string, turnId: string) {
  return {
    prompt: join(runtimeDirectory, `turn-${turnId}.prompt`),
    log: join(runtimeDirectory, `turn-${turnId}.jsonl`),
    stderr: join(runtimeDirectory, `turn-${turnId}.stderr.log`),
    exit: join(runtimeDirectory, `turn-${turnId}.exit`),
  };
}

async function waitForHeadlessIdentity(child: ChildProcess) {
  if (!child.pid) return undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const inspection = await inspectProcessOnce(child.pid);
    if (inspection) return inspection;
    await delay(50);
  }
  return undefined;
}

export async function headlessSessionBusy(runtimeDirectory: string): Promise<boolean> {
  const record = await readHeadlessTurnRecord(join(runtimeDirectory, "turn.json"));
  return record !== null && await headlessTurnRunning(record);
}

export async function headlessRecord(runtimeDirectory: string, intent: PromptIntent, attempt?: PromptDispatchAttempt | null | undefined): Promise<HeadlessTurnRecord | null> {
  const fenced = attempt ? await readHeadlessTurnRecord(join(runtimeDirectory, `dispatch-${attempt.serverGeneration}.json`)) : null;
  const latest = fenced ?? await readHeadlessTurnRecord(join(runtimeDirectory, "turn.json"));
  return latest?.turnId === intent.messageID ? latest : null;
}

export async function headlessObservationPrelude(input: { runtimeDirectory: string; intent: PromptIntent; attempt?: PromptDispatchAttempt | null | undefined }) {
  const files = headlessTurnFiles(input.runtimeDirectory, input.intent.messageID);
  const record = await headlessRecord(input.runtimeDirectory, input.intent, input.attempt);
  const log = await readHeadlessText(files.log);
  const base = { sessionID: input.intent.sessionID, messageID: input.intent.messageID, assistantMessageIDs: [] as string[] };
  if (!record) {
    const replayable = input.intent.dispatch === "not_submitted" || input.intent.dispatch === "rejected";
    return { files, log, record, base, early: log === null
      ? { ...base, state: "unknown" as const, admission: "not_observed" as const, retry: replayable ? "allowed" as const : "forbidden" as const, reason: replayable ? "message_not_observed" : "admission_ambiguous" }
      : { ...base, state: "unknown" as const, admission: "unknown" as const, retry: "forbidden" as const, reason: "dispatch_identity_missing", executionUncertain: { stoppedServerGeneration: input.attempt?.serverGeneration ?? "unknown" } } };
  }
  if (record.sessionID !== input.intent.sessionID) return { files, log, record, base, early: { ...base, state: "unknown" as const, admission: "unknown" as const, retry: "forbidden" as const, reason: "session_identity_conflict" } };
  return { files, log, record, base, early: null };
}

export async function dispatchHeadless(input: { runtimeDirectory: string; scope: TaskScope; intent: PromptIntent; executable: string; args: string[]; prompt: string; environment?: NodeJS.ProcessEnv | undefined; claim: (generation: string) => Promise<boolean>; label: string }): Promise<HeadlessTurnRecord> {
  await mkdir(input.runtimeDirectory, { recursive: true, mode: 0o700 });
  const generation = randomUUID();
  if (!await input.claim(generation)) throw new Error(`${input.label} prompt replay claim was not acquired`);
  const files = headlessTurnFiles(input.runtimeDirectory, input.intent.messageID);
  await writeFile(files.prompt, input.prompt, { mode: 0o600 });
  const [promptFile, log, stderr] = await Promise.all([open(files.prompt, "r"), open(files.log, "a", 0o600), open(files.stderr, "a", 0o600)]);
  let child: ChildProcess | undefined;
  let exited = false;
  try {
    // The wrapper writes an exit status even after Forge loses the child handle.
    const command = '"$0" "$@"; code=$?; printf "%s\\n" "$code" > "$FORGE_HEADLESS_EXIT_FILE"; exit "$code"';
    child = spawn("/bin/sh", ["-c", command, input.executable, ...input.args], {
      cwd: input.scope.directory,
      env: { ...withWorktreeMiseTrust(input.environment ?? process.env, input.scope.directory), ...taskProcessEnvironment(input.scope.directory), ...sessionProcessEnvironment(input.runtimeDirectory), ...executionProcessEnvironment(input.runtimeDirectory, generation), FORGE_HEADLESS_EXIT_FILE: files.exit },
      detached: true,
      stdio: [promptFile.fd, log.fd, stderr.fd],
    });
    child.once("exit", () => { exited = true; });
    await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
  } finally { await Promise.all([promptFile.close(), log.close(), stderr.close()]); }
  if (!child?.pid) throw new Error(`${input.label} did not start`);
  const pid = child.pid;
  child.unref();
  const inspection = exited ? undefined : await waitForHeadlessIdentity(child);
  if (inspection && (inspection.ownerUid === undefined || inspection.processGroup === undefined || inspection.processGroup !== pid)) throw new Error(`${input.label} process identity could not be established`);
  const processIdentity = inspection && inspection.ownerUid !== undefined && inspection.processGroup !== undefined
    ? { command: inspection.command, executable: inspection.executable, argv: inspection.argv, processGroup: inspection.processGroup, startTime: inspection.startTime, ownerUid: inspection.ownerUid }
    : { command: input.executable, executable: input.executable, argv: [input.executable, ...input.args], processGroup: pid, startTime: "exited-before-inspection", ownerUid: process.getuid?.() ?? 0 };
  const record: HeadlessTurnRecord = { generation, turnId: input.intent.messageID, sessionID: input.intent.sessionID, pid, processIdentity };
  const pending = join(input.runtimeDirectory, `dispatch-${generation}.json.pending`);
  await writeFile(pending, JSON.stringify(record), { mode: 0o600 });
  await rename(pending, join(input.runtimeDirectory, `dispatch-${generation}.json`));
  await writeFile(join(input.runtimeDirectory, "turn.json"), JSON.stringify(record), { mode: 0o600 });
  return record;
}

export async function recoverHeadlessDispatch(input: { runtimeDirectory: string; attempt: PromptDispatchAttempt }): Promise<void> {
  const record = await readHeadlessTurnRecord(join(input.runtimeDirectory, `dispatch-${input.attempt.serverGeneration}.json`));
  if (record && await headlessTurnRunning(record)) await stopOwnedProcesses({ version: 1, processes: [ownedHeadlessTurn(record)] });
  await stopExecutionProcesses(input.runtimeDirectory, input.attempt.serverGeneration);
}

export async function stopHeadlessSession(input: { runtimeDirectory: string; nativeSessionId: string | null }): Promise<void> {
  const record = await readHeadlessTurnRecord(join(input.runtimeDirectory, "turn.json"));
  if (record && input.nativeSessionId !== null && record.sessionID !== input.nativeSessionId) return;
  if (record && await headlessTurnRunning(record)) await stopOwnedProcesses({ version: 1, processes: [ownedHeadlessTurn(record)] });
  await stopSessionProcesses(input.runtimeDirectory);
}
