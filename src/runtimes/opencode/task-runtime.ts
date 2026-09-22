import { stopSessionProcesses, stopExecutionProcesses } from "../../platform/process-manager.js";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveOpenCodeExecutable } from "../../platform/executable-resolver.js";
import { ensureOpenCodeServer, OpenCodeServerReferenceSchema, openCodeAttachCommand, openCodeServerRunning, openCodeRoleConfig, openCodeServerClient, readOpenCodeServer, stopOpenCodeServer, type OpenCodeServerReference } from "./server.js";
import { openCodeModel, reconcileOpenCodePrompt, replayOpenCodePrompt } from "./session.js";
import { PromptDispatchAttemptSchema, type PromptDispatchAttempt } from "../../tasks/control.js";
import { taskSessionRuntimeDirectory, taskSessionTitle, writeAdvisorReportBridgeBinding, writeRootBridgeBinding, type PromptIntent, type PromptObservation, type TaskHarness, type TaskScope } from "../task-harness.js";
import { attachTaskDisplay, type TaskPanePort } from "../task-display.js";
import { taskRolePrompt } from "../../tasks/execution/role-prompt.js";
import { createGitCommandGuard, withWorktreeMiseTrust } from "../../coordination/worker-environment.js";
import { executionFromMessages } from "./session-reader.js";
import { excludeEnvironmentKeys } from "../project-environment.js";

export type OpenCodeTaskScope = TaskScope;

export function openCodeDisplayAttached(reference: Pick<OpenCodeServerReference, "executable" | "baseUrl" | "directory">, sessionID: string | null, args: readonly string[]): boolean {
  return args[0] === reference.executable && args[1] === "attach" && args[2] === reference.baseUrl && args[args.indexOf("--session") + 1] === sessionID && args[args.indexOf("--dir") + 1] === reference.directory;
}

export class OpenCodeTaskRuntime implements TaskHarness {
  constructor(private readonly databasePath: string, private readonly herdr: TaskPanePort, private readonly options: { executable?: string; artifactRoot?: string } = {}) {}

  private runtimeDirectory(scope: Pick<TaskScope, "id">): string {
    return taskSessionRuntimeDirectory(this.databasePath, scope.id);
  }

  // The controller holds the durable session claim and persists the returned
  // identity before permitting any prompt dispatch.
  async ensureSession(scope: TaskScope, nativeSessionId: string | null): Promise<string> {
    const runtimeDirectory = this.runtimeDirectory(scope);
    const executable = await resolveOpenCodeExecutable(this.options.executable ? { executable: this.options.executable } : {});
    const bridge = scope.role === "root"
      ? await writeRootBridgeBinding({ runtimeDirectory, identity: scope.identity, databasePath: this.databasePath, artifactRoot: this.options.artifactRoot })
      : scope.role === "advisor" ? await writeAdvisorReportBridgeBinding({ runtimeDirectory, role: scope.advisorRole }) : undefined;
    const guard = scope.role === "worker" ? await createGitCommandGuard(runtimeDirectory, "git-guard") : undefined;
    const evidenceDirectory = scope.role !== "worker" && (scope.workflow !== "standard" || scope.projectContextPath) && scope.evidenceRoot ? scope.evidenceRoot : undefined;
    const reference = await ensureOpenCodeServer({
      runtimeDirectory, executable, directory: scope.directory,
      config: openCodeRoleConfig({ role: scope.role, profile: scope.profile, ...(bridge ? { bridge } : {}), ...(evidenceDirectory ? { evidenceDirectory, directory: scope.directory } : {}), ...(scope.projectContextPath ? { contextDirectory: dirname(scope.projectContextPath) } : {}) }),
      env: excludeEnvironmentKeys(withWorktreeMiseTrust({ ...(guard?.env ?? process.env), ...scope.projectEnvironment }, scope.directory), scope.excludedEnvironmentKeys),
    });
    const client = openCodeServerClient(reference);
    if (scope.role !== "worker") {
      const bridgeName = scope.role === "root" ? "suplex_root" : "suplex_advisor";
      const bridgeStatus = (await client.mcpStatus(scope.directory))[bridgeName];
      if (bridgeStatus?.status !== "connected") throw new Error(`Suplex ${scope.role === "root" ? "Coordinator" : "Advisor report"} bridge is unavailable: ${bridgeStatus?.error ?? bridgeStatus?.status ?? "not configured"}`);
    }
    if (nativeSessionId) return (await client.getSession(nativeSessionId, scope.directory)).id;
    const model = openCodeModel(scope.profile.modelID);
    const native = await client.createSession({
      title: taskSessionTitle(scope), directory: scope.directory,
      model: { providerID: model.providerID, id: model.modelID, variant: scope.profile.reasoningEffort },
      agent: `suplex-${scope.role}`,
    });
    return native.id;
  }

  async attach(input: { scope: TaskScope; nativeSessionId: string; paneId: string | null; rootPaneId?: string | null; shellPaneId?: string | null; persistPane: (paneId: string) => void; persistShellPane?: (paneId: string) => void }): Promise<string> {
    const reference = await readOpenCodeServer(this.runtimeDirectory(input.scope));
    if (!reference) throw new Error("OpenCode server reference is missing");
    return attachTaskDisplay(this.herdr, {
      ...input, generation: reference.generation,
      isAttached: args => openCodeDisplayAttached(reference, input.nativeSessionId, args),
      command: await openCodeAttachCommand({ reference, runtimeDirectory: this.runtimeDirectory(input.scope), sessionID: input.nativeSessionId }),
    });
  }

  async observe(scope: TaskScope, intent: PromptIntent, attempt?: PromptDispatchAttempt | null): Promise<PromptObservation> {
    const reference = await readOpenCodeServer(this.runtimeDirectory(scope));
    if (!reference) throw new Error("OpenCode server reference is missing");
    const observed = await reconcileOpenCodePrompt(openCodeServerClient(reference), intent);
    if (attempt && attempt.serverGeneration !== reference.generation && observed.admission === "observed" && (["admitted", "running"].includes(observed.state) || observed.reason === "native_abort")) {
      return this.recoverDispatch(scope, intent, attempt);
    }
    return observed;
  }

  async stop(scope: Pick<TaskScope, "id">, nativeSessionId: string | null): Promise<void> {
    const reference = await readOpenCodeServer(this.runtimeDirectory(scope));
    if (!reference) { await stopSessionProcesses(this.runtimeDirectory(scope)); return; }
    if (nativeSessionId && await openCodeServerRunning(reference)) {
      const client = openCodeServerClient(reference);
      await client.abortSession(nativeSessionId, reference.directory);
      const status = (await client.getStatus(reference.directory))[nativeSessionId];
      if (status && status.type !== "idle") throw new Error("OpenCode session has not stopped");
    }
    await stopOpenCodeServer(reference);
    await stopSessionProcesses(this.runtimeDirectory(scope));
  }

  async recoverDispatch(scope: TaskScope, intent: PromptIntent, attempt: PromptDispatchAttempt): Promise<PromptObservation> {
    PromptDispatchAttemptSchema.parse(attempt);
    const filename = join(this.runtimeDirectory(scope), `dispatch-server-${attempt.serverGeneration}.json`);
    const reference = OpenCodeServerReferenceSchema.parse(JSON.parse(await readFile(filename, "utf8")));
    if (reference.generation !== attempt.serverGeneration) throw new Error("OpenCode dispatch server identity changed");
    await stopOpenCodeServer(reference);
    await stopExecutionProcesses(this.runtimeDirectory(scope), attempt.serverGeneration);
    await this.ensureSession(scope, intent.sessionID);
    const observed = await this.observe(scope, { ...intent, dispatch: "not_submitted" });
    if (observed.admission === "observed" && (["admitted", "running"].includes(observed.state) || observed.reason === "native_abort") && observed.status?.type === "idle") {
      if (observed.unsettledTools) return { ...observed, state: "unknown", reason: "tool_execution_after_server_crash", executionUncertain: { stoppedServerGeneration: attempt.serverGeneration } };
      return { ...observed, state: "interrupted", reason: "dispatch_process_stopped", interruptedExecution: { stoppedServerGeneration: attempt.serverGeneration } };
    }
    return observed;
  }

  async dispatch(scope: TaskScope, intent: PromptIntent, claim: (serverGeneration: string) => Promise<boolean>): Promise<PromptObservation> {
    const reference = await readOpenCodeServer(this.runtimeDirectory(scope));
    if (!reference) throw new Error("OpenCode server reference is missing");
    const filename = join(this.runtimeDirectory(scope), `dispatch-server-${reference.generation}.json`);
    const pending = `${filename}.${randomUUID()}.pending`;
    await writeFile(pending, JSON.stringify(reference), { mode: 0o600 });
    await rename(pending, filename);
    const client = openCodeServerClient(reference);
    await replayOpenCodePrompt(client, { ...intent, system: taskRolePrompt(scope.role, { workflow: scope.workflow, ...(scope.role === "worker" ? { workerMode: scope.workerMode, purpose: scope.purpose } : {}) }) }, () => claim(reference.generation));
    return reconcileOpenCodePrompt(client, { ...intent, dispatch: "ambiguous" });
  }

  /** The whole correlated native turn: every tool call after the admitted prompt, not the display API's bounded page. */
  async turnEvidence(scope: TaskScope, observation: PromptObservation): Promise<{ tools: ReturnType<typeof executionFromMessages>["tools"]; limit: string | null }> {
    try {
      const reference = await readOpenCodeServer(this.runtimeDirectory(scope));
      if (!reference) throw new Error("OpenCode server reference is missing");
      const messages = await openCodeServerClient(reference).getMessages(observation.sessionID, { directory: scope.directory });
      const prompt = messages.find((message) => message.info.id === observation.messageID);
      const correlated = prompt ? messages.filter((message) => message.info.time.created >= prompt.info.time.created) : messages;
      return { tools: executionFromMessages(correlated).tools, limit: prompt ? null : "The admitted prompt was not found among the native messages; every message in the session is included." };
    } catch (error) {
      return { tools: [], limit: `Native tool evidence could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async resultText(scope: TaskScope, observation: PromptObservation): Promise<string> {
    const reference = await readOpenCodeServer(this.runtimeDirectory(scope));
    if (!reference) throw new Error("OpenCode server reference is missing");
    const messages = await openCodeServerClient(reference).getMessages(observation.sessionID, { directory: scope.directory });
    const final = messages.find((message) => message.info.id === observation.assistantMessageID);
    return final?.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
  }
}
