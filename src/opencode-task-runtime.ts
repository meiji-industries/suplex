import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HerdrClient } from "./herdr-client.js";
import type { RootIdentity } from "./root-contracts.js";
import { createGitCommandGuard, withWorktreeMiseTrust } from "./worktrees.js";
import { resolveOpenCodeExecutable } from "./opencode-executable.js";
import { ensureOpenCodeServer, openCodeAttachCommand, openCodeRoleConfig, openCodeServerClient, readOpenCodeServer, type OpenCodeProfile } from "./opencode-server.js";
import { reconcileOpenCodePrompt, replayOpenCodePrompt, type OpenCodePromptClaim, type OpenCodePromptIntent, type OpenCodePromptObservation } from "./opencode-session.js";

type TaskPanePort = Pick<HerdrClient, "getPane" | "createWorkspace" | "splitPane" | "renamePane" | "runPaneCommand" | "reportPaneMetadata">;

export type OpenCodeTaskScope = {
  id: string;
  taskId: string;
  directory: string;
  profile: OpenCodeProfile;
} & ({ role: "root"; identity: RootIdentity } | { role: "worker" });

export class OpenCodeTaskRuntime {
  constructor(private readonly databasePath: string, private readonly herdr: TaskPanePort, private readonly executable?: string) {}

  private runtimeDirectory(scope: OpenCodeTaskScope): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(scope.id)) throw new Error("Invalid task session identity");
    return join(dirname(this.databasePath), "runtime", "task-sessions", scope.id);
  }

  // The controller holds the durable session claim and persists the returned
  // identity before permitting any prompt dispatch.
  async ensureSession(scope: OpenCodeTaskScope, nativeSessionId: string | null): Promise<string> {
    const runtimeDirectory = this.runtimeDirectory(scope);
    const executable = await resolveOpenCodeExecutable(this.executable ? { executable: this.executable } : {});
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
      await writeFile(bindingPath, JSON.stringify({ version: 1, root: scope.identity, databasePath: this.databasePath, server: bridge }), { mode: 0o600 });
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
      if (bridgeStatus?.status !== "connected") throw new Error(`Forge Root bridge is unavailable: ${bridgeStatus?.error ?? bridgeStatus?.status ?? "not configured"}`);
    }
    if (nativeSessionId) return (await client.getSession(nativeSessionId, scope.directory)).id;
    const native = await client.createSession({
      title: `${scope.taskId} ${scope.role}`, directory: scope.directory,
      model: { providerID: scope.profile.providerID, id: scope.profile.modelID, variant: scope.profile.reasoningEffort },
      agent: `forge-${scope.role}`,
    });
    return native.id;
  }

  async attach(input: { scope: OpenCodeTaskScope; nativeSessionId: string; paneId: string | null; rootPaneId?: string | null; persistPane: (paneId: string) => void }): Promise<string> {
    const { scope } = input;
    if (input.paneId && await this.herdr.getPane(input.paneId)) return input.paneId;
    const reference = await readOpenCodeServer(this.runtimeDirectory(scope));
    if (!reference) throw new Error("OpenCode server reference is missing");
    const pane = input.rootPaneId && await this.herdr.getPane(input.rootPaneId)
      ? await this.herdr.splitPane({ paneId: input.rootPaneId, direction: "right", cwd: scope.directory, focus: false })
      : (await this.herdr.createWorkspace({ label: `forge-${scope.taskId}`, cwd: scope.directory, focus: false })).rootPane;
    input.persistPane(pane.paneId);
    const title = `${scope.taskId} ${scope.role}`;
    await this.herdr.renamePane(pane.paneId, title);
    await this.herdr.reportPaneMetadata({ paneId: pane.paneId, source: "forge", title, tokens: { forge_binding_id: scope.id, forge_task_id: scope.taskId, forge_native_session_id: input.nativeSessionId, forge_server_generation: reference.generation } });
    const command = await openCodeAttachCommand({ reference, runtimeDirectory: this.runtimeDirectory(scope), sessionID: input.nativeSessionId });
    await this.herdr.runPaneCommand(pane.paneId, command);
    return pane.paneId;
  }

  async observe(scope: OpenCodeTaskScope, intent: OpenCodePromptIntent): Promise<OpenCodePromptObservation> {
    const reference = await readOpenCodeServer(this.runtimeDirectory(scope));
    if (!reference) throw new Error("OpenCode server reference is missing");
    return reconcileOpenCodePrompt(openCodeServerClient(reference), intent);
  }

  async dispatch(scope: OpenCodeTaskScope, intent: OpenCodePromptIntent, claim: OpenCodePromptClaim): Promise<OpenCodePromptObservation> {
    const reference = await readOpenCodeServer(this.runtimeDirectory(scope));
    if (!reference) throw new Error("OpenCode server reference is missing");
    const client = openCodeServerClient(reference);
    await replayOpenCodePrompt(client, intent, claim);
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
