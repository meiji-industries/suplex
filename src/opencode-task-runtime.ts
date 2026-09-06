import { randomUUID } from "node:crypto";
import { openCodeRolePrompt } from "./opencode-role-prompt.js";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { HerdrClient, PaneProcessInfo } from "./herdr-client.js";
import type { RootIdentity } from "./root-contracts.js";
import { createGitCommandGuard, withWorktreeMiseTrust } from "./worker-environment.js";
import { resolveOpenCodeExecutable } from "./opencode-executable.js";
import { ensureOpenCodeServer, OpenCodeServerReferenceSchema, openCodeAttachCommand, openCodeProcessAlive, openCodeRoleConfig, openCodeServerClient, readOpenCodeServer, stopOpenCodeServer, type OpenCodeProfile } from "./opencode-server.js";
import { reconcileOpenCodePrompt, replayOpenCodePrompt, type OpenCodePromptIntent, type OpenCodePromptObservation } from "./opencode-session.js";
import { PromptDispatchAttemptSchema, type PromptDispatchAttempt } from "./task-control.js";

type TaskPanePort = Pick<HerdrClient, "getPane" | "getPaneProcessInfo" | "createWorkspace" | "splitPane" | "renamePane" | "runPaneCommand" | "reportPaneMetadata">;

function isInteractiveShell(info: PaneProcessInfo): boolean {
  const foreground = info.foreground_processes[0];
  return info.foreground_processes.length === 1 && foreground !== undefined && foreground.pid === info.shell_pid && info.foreground_process_group_id === info.shell_pid && ["zsh", "bash", "sh", "fish", "nu", "pwsh"].includes(basename(foreground.name));
}

export type OpenCodeTaskScope = {
  id: string;
  taskId: string;
  directory: string;
  profile: OpenCodeProfile;
} & ({ role: "root"; identity: RootIdentity } | { role: "worker" });

export class OpenCodeTaskRuntime {
  constructor(private readonly databasePath: string, private readonly herdr: TaskPanePort, private readonly options: { executable?: string; artifactRoot?: string } = {}) {}

  private runtimeDirectory(scope: Pick<OpenCodeTaskScope, "id">): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(scope.id)) throw new Error("Invalid task session identity");
    return join(dirname(this.databasePath), "runtime", "task-sessions", scope.id);
  }

  // The controller holds the durable session claim and persists the returned
  // identity before permitting any prompt dispatch.
  async ensureSession(scope: OpenCodeTaskScope, nativeSessionId: string | null): Promise<string> {
    const runtimeDirectory = this.runtimeDirectory(scope);
    const executable = await resolveOpenCodeExecutable(this.options.executable ? { executable: this.options.executable } : {});
    let bridge: { command: string; args: string[] } | undefined;
    if (scope.role === "root") {
      await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
      const currentFile = fileURLToPath(import.meta.url);
      const source = currentFile.endsWith(".ts");
      const bindingPath = join(runtimeDirectory, "root.binding.json");
      bridge = {
        command: process.execPath,
        args: [
          ...(source ? [join(dirname(currentFile), "..", "node_modules", "tsx", "dist", "cli.mjs")] : []),
          join(dirname(currentFile), source ? "root-bridge.ts" : "root-bridge.js"), "--binding", bindingPath,
        ],
      };
      await writeFile(bindingPath, JSON.stringify({ version: 1, root: scope.identity, databasePath: this.databasePath, artifactRoot: this.options.artifactRoot ?? join(dirname(this.databasePath), "artifacts"), server: bridge }), { mode: 0o600 });
      await chmod(bindingPath, 0o600);
    }
    const guard = scope.role === "worker" ? await createGitCommandGuard(runtimeDirectory, "git-guard") : undefined;
    const reference = await ensureOpenCodeServer({
      runtimeDirectory, executable, directory: scope.directory,
      config: openCodeRoleConfig({ role: scope.role, profile: scope.profile, ...(bridge ? { bridge } : {}) }),
      env: withWorktreeMiseTrust(guard?.env ?? process.env, scope.directory),
    });
    const client = openCodeServerClient(reference);
    if (scope.role === "root") {
      const bridgeStatus = (await client.mcpStatus(scope.directory)).forge_root;
      if (bridgeStatus?.status !== "connected") throw new Error(`Forge Coordinator bridge is unavailable: ${bridgeStatus?.error ?? bridgeStatus?.status ?? "not configured"}`);
    }
    if (nativeSessionId) return (await client.getSession(nativeSessionId, scope.directory)).id;
    const native = await client.createSession({
      title: `${scope.taskId} ${scope.role === "root" ? "Coordinator" : "Worker"}`, directory: scope.directory,
      model: { providerID: scope.profile.providerID, id: scope.profile.modelID, variant: scope.profile.reasoningEffort },
      agent: `forge-${scope.role}`,
    });
    return native.id;
  }

  async attach(input: { scope: OpenCodeTaskScope; nativeSessionId: string; paneId: string | null; rootPaneId?: string | null; persistPane: (paneId: string) => void }): Promise<string> {
    const { scope } = input;
    const reference = await readOpenCodeServer(this.runtimeDirectory(scope));
    if (!reference) throw new Error("OpenCode server reference is missing");
    let pane = input.paneId ? await this.herdr.getPane(input.paneId) : null;
    if (pane) {
      const info = await this.herdr.getPaneProcessInfo(pane.paneId);
      const attached = info.foreground_processes.some(process => {
        const args = process.argv;
        return args?.[0] === reference.executable && args[1] === "attach" && args[2] === reference.baseUrl && args[args.indexOf("--session") + 1] === input.nativeSessionId && args[args.indexOf("--dir") + 1] === reference.directory;
      });
      if (attached) return pane.paneId;
      const owned = pane.tokens?.forge_binding_id === scope.id || !pane.tokens?.forge_binding_id && pane.cwd === scope.directory;
      if (owned && info.foreground_processes.length === 0) throw new Error("The task display process could not be inspected");
      if (!owned || !isInteractiveShell(info)) pane = null;
    }
    pane ??= input.rootPaneId && await this.herdr.getPane(input.rootPaneId)
      ? await this.herdr.splitPane({ paneId: input.rootPaneId, direction: "right", cwd: scope.directory, focus: false })
      : (await this.herdr.createWorkspace({ label: `forge-${scope.taskId}`, cwd: scope.directory, focus: false })).rootPane;
    input.persistPane(pane.paneId);
    const title = `${scope.taskId} ${scope.role === "root" ? "Coordinator" : "Worker"}`;
    await this.herdr.renamePane(pane.paneId, title);
    await this.herdr.reportPaneMetadata({ paneId: pane.paneId, source: "forge", title, tokens: { forge_binding_id: scope.id, forge_task_id: scope.taskId, forge_native_session_id: input.nativeSessionId, forge_server_generation: reference.generation } });
    const deadline = Date.now() + 2_000;
    for (;;) {
      const info = await this.herdr.getPaneProcessInfo(pane.paneId);
      if (isInteractiveShell(info)) break;
      if (Date.now() >= deadline) throw new Error("The task display is not at an interactive shell");
      await delay(100);
    }
    const command = await openCodeAttachCommand({ reference, runtimeDirectory: this.runtimeDirectory(scope), sessionID: input.nativeSessionId });
    await this.herdr.runPaneCommand(pane.paneId, command);
    return pane.paneId;
  }

  async observe(scope: OpenCodeTaskScope, intent: OpenCodePromptIntent, attempt?: PromptDispatchAttempt | null): Promise<OpenCodePromptObservation> {
    const reference = await readOpenCodeServer(this.runtimeDirectory(scope));
    if (!reference) throw new Error("OpenCode server reference is missing");
    const observed = await reconcileOpenCodePrompt(openCodeServerClient(reference), intent);
    if (attempt && attempt.serverGeneration !== reference.generation && observed.admission === "observed" && (["admitted", "running"].includes(observed.state) || observed.reason === "native_abort")) {
      return this.recoverDispatch(scope, intent, attempt);
    }
    return observed;
  }

  async stop(scope: Pick<OpenCodeTaskScope, "id">, nativeSessionId: string | null): Promise<void> {
    const reference = await readOpenCodeServer(this.runtimeDirectory(scope));
    if (!reference) {
      if (nativeSessionId) throw new Error("OpenCode server reference is missing");
      return;
    }
    if (nativeSessionId && openCodeProcessAlive(reference.pid)) {
      const client = openCodeServerClient(reference);
      await client.abortSession(nativeSessionId, reference.directory);
      const status = (await client.getStatus(reference.directory))[nativeSessionId];
      if (status && status.type !== "idle") throw new Error("OpenCode session has not stopped");
    }
    await stopOpenCodeServer(reference);
  }

  async recoverDispatch(scope: OpenCodeTaskScope, intent: OpenCodePromptIntent, attempt: PromptDispatchAttempt): Promise<OpenCodePromptObservation> {
    PromptDispatchAttemptSchema.parse(attempt);
    const filename = join(this.runtimeDirectory(scope), `dispatch-server-${attempt.serverGeneration}.json`);
    const reference = OpenCodeServerReferenceSchema.parse(JSON.parse(await readFile(filename, "utf8")));
    if (reference.generation !== attempt.serverGeneration) throw new Error("OpenCode dispatch server identity changed");
    await stopOpenCodeServer(reference);
    await this.ensureSession(scope, intent.sessionID);
    const observed = await this.observe(scope, { ...intent, dispatch: "not_submitted" });
    if (observed.admission === "observed" && (["admitted", "running"].includes(observed.state) || observed.reason === "native_abort") && observed.status?.type === "idle") {
      if (observed.unsettledTools) return { ...observed, state: "unknown", reason: "tool_execution_after_server_crash", executionUncertain: { stoppedServerGeneration: attempt.serverGeneration } };
      return { ...observed, state: "interrupted", reason: "dispatch_process_stopped", interruptedExecution: { stoppedServerGeneration: attempt.serverGeneration } };
    }
    return observed;
  }

  async dispatch(scope: OpenCodeTaskScope, intent: OpenCodePromptIntent, claim: (serverGeneration: string) => Promise<boolean>): Promise<OpenCodePromptObservation> {
    const reference = await readOpenCodeServer(this.runtimeDirectory(scope));
    if (!reference) throw new Error("OpenCode server reference is missing");
    const filename = join(this.runtimeDirectory(scope), `dispatch-server-${reference.generation}.json`);
    const pending = `${filename}.${randomUUID()}.pending`;
    await writeFile(pending, JSON.stringify(reference), { mode: 0o600 });
    await rename(pending, filename);
    const client = openCodeServerClient(reference);
    await replayOpenCodePrompt(client, { ...intent, system: openCodeRolePrompt(scope.role) }, () => claim(reference.generation));
    return reconcileOpenCodePrompt(client, { ...intent, dispatch: "ambiguous" });
  }

  async resultText(scope: OpenCodeTaskScope, observation: OpenCodePromptObservation): Promise<string> {
    const reference = await readOpenCodeServer(this.runtimeDirectory(scope));
    if (!reference) throw new Error("OpenCode server reference is missing");
    const messages = await openCodeServerClient(reference).getMessages(observation.sessionID, { directory: scope.directory });
    const final = messages.find((message) => message.info.id === observation.assistantMessageID);
    return final?.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
  }
}
