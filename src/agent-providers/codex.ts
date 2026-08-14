import { execFile, spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, delimiter, join, sep } from "node:path";
import { promisify } from "node:util";

import { AgentFailure } from "../agent-failure.js";
import { createAgentWrapperManifest, inspectAgentWrapper, launchAgentWrapper, readAgentWrapperManifest } from "../agent-wrapper.js";
import { redact } from "../logging.js";
import { defaultProcessController, type ProcessController, type ProcessInspection } from "../process-manager.js";
import { FileSessionStore } from "../session-store.js";
import type { CommandRunner } from "../provider-readiness.js";
import { CodexReadinessProbe } from "./codex-readiness.js";
import { parseCodexJsonl, type CodexJsonlParserState } from "./codex-jsonl.js";
import { CodexTurnSupervisor, sanitizeCodexLine } from "./codex-turn-supervisor.js";
import { prepareCodexTurnWrapper } from "./codex-turn-wrapper.js";
import { catalogSupportsCodexTurn } from "./codex-turn.js";
import type { AgentProfileSettings, AgentProvider, AgentTranscript, AgentTranscriptOptions, AgentTurnRequest, AgentTurnWrapperRequest, LeadInvocation, LeadProcessResult, PreparedAgentTurnWrapper } from "./provider.js";

const execFileAsync = promisify(execFile);

function resolveCodexCommand(command: string, executablePath = process.env.PATH ?? ""): string {
  if (command !== "codex") return command;
  let fallback: string | undefined;
  for (const directory of executablePath.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      fallback ??= candidate;
      if (!/^mise(?:\.exe)?$/i.test(basename(realpathSync(candidate)))) return candidate;
    } catch { /* Continue to the next PATH entry. */ }
  }
  return fallback ?? command;
}

function forgeWrapperLauncher(): { command: string; args: string[] } {
  const entry = process.argv[1] ?? "";
  // Unit and real-proof runners execute services inside Vitest rather than
  // through Forge's normal CLI entry point. Keep the same hidden CLI branch
  // in that environment so durable wrappers are still real child processes.
  if (entry.includes("vitest")) return { command: join(process.cwd(), "node_modules", ".bin", "tsx"), args: [join(process.cwd(), "src", "cli.ts")] };
  const args = entry.includes(`${sep}.bin${sep}`) || entry.endsWith("/tsx") || entry.endsWith("\\tsx")
    ? process.argv.slice(1, 3)
    : process.argv.slice(1, 2);
  return { command: process.execPath, args };
}

async function runDurableProcess(invocation: LeadInvocation & { durable: NonNullable<LeadInvocation["durable"]> }): Promise<LeadProcessResult> {
  const expected = {
    runtimeRoot: invocation.durable.runtimeRoot,
    executionId: invocation.durable.executionId,
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    ...(invocation.durable.pathOverride ? { pathOverride: invocation.durable.pathOverride } : {}),
  };
  const manifestPath = join(invocation.durable.runtimeRoot, "agent-executions", invocation.durable.executionId, "manifest.json");
  let directory;
  let existing = false;
  try {
    const loaded = await readAgentWrapperManifest(manifestPath);
    if (loaded.manifest.runtimeRoot !== expected.runtimeRoot || loaded.manifest.executionId !== expected.executionId || loaded.manifest.command !== expected.command || loaded.manifest.cwd !== expected.cwd || JSON.stringify(loaded.manifest.args) !== JSON.stringify(expected.args) || (loaded.manifest.pathOverride ?? null) !== (expected.pathOverride ?? null)) throw new AgentFailure("wrapper-identity-mismatch", "The durable Codex wrapper manifest does not match the retried execution");
    directory = loaded.paths;
    existing = true;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error;
    directory = await createAgentWrapperManifest(expected);
  }
  const initialInspection = await inspectAgentWrapper(directory.manifestPath);
  if (!existing || (!initialInspection.live && !initialInspection.result && !initialInspection.state)) await launchAgentWrapper(directory.manifestPath, forgeWrapperLauncher());
  else if (!initialInspection.live && !initialInspection.result && initialInspection.state) throw new AgentFailure("wrapper-process-missing", "The durable Codex wrapper stopped without a stored result");
  let stdoutOffset = 0;
  let pending = "";
  let started = false;
  const readOutput = async (): Promise<void> => {
    const bytes = await readFile(directory.stdoutPath).catch(() => Buffer.alloc(0));
    if (bytes.length <= stdoutOffset) return;
    pending += bytes.subarray(stdoutOffset).toString("utf8");
    stdoutOffset = bytes.length;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) await invocation.onLine(line);
  };
  for (;;) {
    await readOutput();
    const inspection = await inspectAgentWrapper(directory.manifestPath);
    if (!started && inspection.state?.childPid) {
      const identity = inspection.state.childStartIdentity?.split(":").slice(1).join(":") || new Date().toISOString();
      await invocation.onStart(inspection.state.childPid, identity);
      started = true;
    }
    if (inspection.result) {
      if (pending.trim()) {
        await invocation.onLine(pending);
        pending = "";
      }
      const stderr = await readFile(directory.stderrPath, "utf8").catch(() => "");
      return { exitCode: inspection.result.exitCode, stderr: redact(stderr.slice(-16_384)) as string };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

function defaultProcessRunner(invocation: LeadInvocation): Promise<LeadProcessResult> {
  if (invocation.durable) return runDurableProcess(invocation as LeadInvocation & { durable: NonNullable<LeadInvocation["durable"]> });
  const turnSupervisor = new CodexTurnSupervisor();
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, detached: invocation.detached, stdio: ["ignore", "pipe", "pipe"] });
    const startedAt = new Date().toISOString();
    let stderr = "";
    let buffer = "";
    let settled = false;
    let hookChain = Promise.resolve();
    const queueLine = (line: string): void => {
      hookChain = hookChain.then(() => invocation.onLine(line));
    };
    const finish = (result: LeadProcessResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    if (!child.pid) {
      reject(new AgentFailure("process-start-failed", "Codex process could not be started"));
      return;
    }
    let inspection: ProcessInspection | undefined;
    hookChain = hookChain.then(async () => {
      inspection = await defaultProcessController.inspect(child.pid!);
      await invocation.onStart(child.pid!, startedAt, inspection);
    });
    if (invocation.signal) {
      const cancel = async (): Promise<void> => {
        await hookChain.catch(() => undefined);
        if (settled) return;
        const owned = inspection ? {
          name: "codex-wrapper",
          pid: child.pid!,
          command: inspection.command,
          startedAt,
          processGroup: inspection.processGroup,
          startTime: inspection.startTime,
          executable: inspection.executable,
          argv: inspection.argv,
        } : undefined;
        if (!owned || !await turnSupervisor.cancelOwnedProcess(owned, inspection)) {
          reject(new AgentFailure("ownership_ambiguous", "Codex wrapper ownership could not be verified"));
          return;
        }
      };
      if (invocation.signal.aborted) void cancel();
      else invocation.signal.addEventListener("abort", () => void cancel(), { once: true });
    }
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) queueLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-16_384);
    });
    child.once("close", (code) => {
      if (buffer.trim()) queueLine(buffer);
      void hookChain.then(() => finish({ exitCode: code ?? -1, stderr: redact(stderr) as string })).catch((error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  });
}

export const runCodexProcess = defaultProcessRunner;

function eventValue(line: string): { type: string | undefined; threadId: string | undefined; sessionRef: string | undefined; itemText: string | undefined } {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const item = event.item as Record<string, unknown> | undefined;
    return {
      type: typeof event.type === "string" ? event.type : undefined,
      threadId: typeof event.thread_id === "string" ? event.thread_id : typeof event.threadId === "string" ? event.threadId : undefined,
      sessionRef: typeof event.session_ref === "string" ? event.session_ref : typeof event.sessionRef === "string" ? event.sessionRef : undefined,
      itemText: item && item.type === "agent_message" && typeof item.text === "string" ? item.text : undefined,
    };
  } catch {
    return { type: undefined, threadId: undefined, sessionRef: undefined, itemText: undefined };
  }
}

function agentMessages(lines: string[]): string[] {
  return lines.flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
      return event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string" ? [event.item.text] : [];
    } catch {
      return [];
    }
  });
}

function futureResetTimestamp(value: unknown, now = Date.now()): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1_000;
    if (millis > now && millis <= now + 7 * 24 * 60 * 60 * 1_000) return new Date(millis).toISOString();
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return parsed > now && parsed <= now + 7 * 24 * 60 * 60 * 1_000 ? new Date(parsed).toISOString() : undefined;
}

function rateLimitTiming(outputLines: string[]): { retryAt?: string; retryAfterMs?: number } {
  for (const line of outputLines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : record;
      for (const key of ["retry_at", "reset_at", "resets_at", "retryAt", "resetAt"]) {
        const retryAt = futureResetTimestamp(nested[key]);
        if (retryAt) return { retryAt };
      }
      for (const key of ["retry_after_seconds", "retryAfterSeconds"]) {
        const seconds = typeof nested[key] === "number" ? nested[key] : typeof nested[key] === "string" ? Number(nested[key]) : Number.NaN;
        if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 7 * 24 * 60 * 60) return { retryAfterMs: Math.round(seconds * 1_000) };
      }
      for (const key of ["retry_after_ms", "retryAfterMs"]) {
        const millis = typeof nested[key] === "number" ? nested[key] : typeof nested[key] === "string" ? Number(nested[key]) : Number.NaN;
        if (Number.isFinite(millis) && millis >= 0 && millis <= 7 * 24 * 60 * 60 * 1_000) return { retryAfterMs: Math.round(millis) };
      }
    } catch { /* plain-text provider diagnostics are handled by regex below */ }
  }
  return {};
}

function agentProcessFailure(result: LeadProcessResult, outputLines: string[] = [], model?: string): AgentFailure {
  const diagnosticText = `${result.stderr}\n${outputLines.join("\n")}`;
  if (/not logged in|login required|authentication required|unauthenticated|oauth authorization required/i.test(diagnosticText)) {
    return new AgentFailure("login-expired", "Agent provider authentication is unavailable. Sign in again, then retry.", { nonRetryable: true });
  }
  if (/rate[ -]?limit|too many requests|\b429\b/i.test(diagnosticText)) {
    return new AgentFailure("rate-limited", "Agent provider rate limiting prevented this invocation from completing.", rateLimitTiming(outputLines));
  }
  if (/model .*not supported|unsupported model|invalid model|unknown model|model_not_found|model metadata .*not found|model .*does not exist/i.test(diagnosticText)) {
    const configuredModel = model ? ` “${model}”` : "";
    return new AgentFailure("model-unavailable", `The configured model${configuredModel} is unavailable for the active provider account. Select a supported model, then retry.`, { nonRetryable: true });
  }
  return new AgentFailure(result.exitCode === 0 ? "process-output-failed" : "process-exited", "The agent invocation did not complete.");
}

function profileArgs(profile: AgentProfileSettings): string[] {
  return ["--model", profile.model, "-c", `model_reasoning_effort=\"${profile.reasoningLevel}\"`, "-c", `service_tier=\"${profile.servicePriority === "fast" ? "fast" : profile.servicePriority === "priority" ? "priority" : "default"}\"`];
}

function buildTurnArgs(request: AgentTurnRequest): string[] {
  if (request.resumeSessionId !== undefined) {
    return ["exec", "resume", ...(request.profile ? profileArgs(request.profile) : []), request.resumeSessionId, "--json", "--skip-git-repo-check", request.prompt];
  }
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    ...(request.networkAccess ? ["-c", "sandbox_workspace_write.network_access=true"] : []),
    ...(request.addDirectories ?? []).flatMap((directory) => ["--add-dir", directory]),
    ...(request.profile ? profileArgs(request.profile) : []),
    ...(request.imagePaths ?? []).flatMap((path) => ["--image", path]),
    request.prompt,
  ];
}

export const codexProvider: AgentProvider = {
  id: "codex",
  processRunner: defaultProcessRunner,
  resolveCommand(command?: string, executablePath?: string): string {
    return resolveCodexCommand(command ?? process.env.FORGE_CODEX_COMMAND ?? "codex", executablePath ?? process.env.PATH ?? "");
  },
  buildTurnArgs,
  parseEvent: eventValue,
  agentMessages,
  sanitizeLine: sanitizeCodexLine,
  classifyProcessFailure: agentProcessFailure,
  createSessionStore(root: string) {
    return new FileSessionStore(root);
  },
  createTurnSupervisor(controller?: ProcessController) {
    return new CodexTurnSupervisor(controller);
  },
  prepareTurnWrapper(request: AgentTurnWrapperRequest, executionRoot: string): Promise<PreparedAgentTurnWrapper> {
    return prepareCodexTurnWrapper(request, executionRoot);
  },
  async assertTurnCompatibility(command: string, settings: AgentProfileSettings): Promise<void> {
    try {
      const result = await execFileAsync(command, ["debug", "models", "--bundled"], { timeout: 8_000, maxBuffer: 2 * 1024 * 1024 });
      if (!catalogSupportsCodexTurn(JSON.parse(result.stdout), settings)) {
        throw new AgentFailure("scope_configuration", "The configured Codex model, reasoning level, or service tier is unavailable", { nonRetryable: true });
      }
    } catch (error) {
      if (error instanceof AgentFailure) throw error;
      throw new AgentFailure("version_incompatible", "The installed Codex CLI model catalog could not validate the pinned Lead settings", { nonRetryable: true });
    }
  },
  parseExecutionTranscript(lines: Iterable<string>, options: AgentTranscriptOptions): AgentTranscript {
    const { state, ...input } = options;
    return parseCodexJsonl(lines, { ...input, ...(state ? { state: state as CodexJsonlParserState } : {}) });
  },
  readinessProbe(command?: string, runner?: CommandRunner) {
    return runner
      ? new CodexReadinessProbe(command ?? process.env.FORGE_CODEX_COMMAND ?? "codex", runner)
      : new CodexReadinessProbe(command ?? process.env.FORGE_CODEX_COMMAND ?? "codex");
  },
};
