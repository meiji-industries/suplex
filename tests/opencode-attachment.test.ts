import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { HerdrClient, HerdrPaneMetadataReport, Pane, PaneProcessInfo } from "../src/integrations/herdr/client.js";
import { OpenCodeTaskRuntime, type OpenCodeTaskScope } from "../src/runtimes/opencode/task-runtime.js";
import type { OpenCodeServerReference } from "../src/runtimes/opencode/server.js";

test.each(["live", "failed_command", "old_server", "unrelated", "unknown"])("native attachment recovers from %s without treating pane existence as liveness", async condition => {
  const directory = await mkdtemp(join(tmpdir(), "forge-attachment-"));
  try {
    const scope: OpenCodeTaskScope = { id: "session", taskId: "task", role: "worker", workerMode: "planned", purpose: "implementation", workflow: "standard", evidenceRoot: null, directory, profile: { providerID: "openai", modelID: "test", reasoningEffort: "medium", serviceTier: "default" } };
    const reference: OpenCodeServerReference = { pid: process.pid, baseUrl: "http://127.0.0.1:1234", password: "a".repeat(64), directory, executable: "/bin/opencode", generation: "b775df17-718a-4cb2-8e23-6912b8aa0d39", configHash: "a".repeat(64), processIdentity: { command: "opencode serve", executable: "/bin/opencode", argv: ["opencode", "serve"], processGroup: process.pid, startTime: "start", ownerUid: 501 } };
    const runtimeDirectory = join(directory, "runtime", "task-sessions", scope.id);
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(join(runtimeDirectory, "server.json"), JSON.stringify(reference));
    const pane = (id: string): Pane => ({ paneId: id, cwd: directory, tokens: { forge_binding_id: scope.id } });
    const shell = (id: string): PaneProcessInfo => ({ pane_id: id, shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: "zsh", argv: ["/bin/zsh"] }] });
    const attached = (id: string, url = reference.baseUrl): PaneProcessInfo => ({ pane_id: id, shell_pid: 10, foreground_process_group_id: 11, foreground_processes: [{ pid: 11, name: "opencode", argv: [reference.executable, "attach", url, "--dir", directory, "--session", "ses_proof"] }] });
    let original = condition === "live" ? attached("pane-old") : condition === "old_server" ? attached("pane-old", "http://127.0.0.1:1233") : shell("pane-old");
    if (condition === "unrelated") original = { ...original, foreground_processes: [{ pid: 12, name: "vim", argv: ["vim", "file"] }], foreground_process_group_id: 12 };
    if (condition === "unknown") original = { pane_id: "pane-old", foreground_processes: [] };
    const processes = new Map<string, PaneProcessInfo>([["pane-old", original]]);
    let creates = 0;
    let splits = 0;
    let fail = condition === "failed_command";
    const commands: string[] = [];
    const paneCommands: string[] = [];
    const metadata: HerdrPaneMetadataReport[] = [];
    const herdr: Pick<HerdrClient, "getPane" | "getPaneProcessInfo" | "createWorkspace" | "splitPane" | "renamePane" | "runPaneCommand" | "reportPaneMetadata"> = {
      async getPane(id) { return pane(id); },
      async getPaneProcessInfo(id) { return processes.get(id)!; },
      async createWorkspace() { creates++; processes.set("pane-new", shell("pane-new")); return { workspace: { workspaceId: "workspace", label: "Proof" }, tab: { tabId: "tab", label: "Proof" }, rootPane: pane("pane-new") }; },
      async splitPane() { splits++; const id = `pane-split-${splits}`; processes.set(id, shell(id)); return pane(id); },
      async renamePane() {}, async reportPaneMetadata(report) { metadata.push(report); },
      async runPaneCommand(id, command) { commands.push(id); paneCommands.push(command); if (fail) { fail = false; throw new Error("Command transport failed"); } processes.set(id, attached(id)); },
    };
    const runtime = new OpenCodeTaskRuntime(join(directory, "forge.sqlite"), herdr);
    let paneId = "pane-old";
    const attach = () => runtime.attach({ scope, nativeSessionId: "ses_proof", paneId, persistPane: id => { paneId = id; } });
    if (condition === "unknown") {
      await expect(attach()).rejects.toThrow("could not be inspected");
      expect(creates).toBe(0);
      expect(commands).toEqual([]);
      return;
    }
    if (condition === "failed_command") await expect(attach()).rejects.toThrow("Command transport failed");
    const result = await attach();
    expect(await attach()).toBe(result);
    expect(creates).toBe(condition === "old_server" || condition === "unrelated" ? 1 : 0);
    expect(commands).toEqual(condition === "live" ? [] : condition === "failed_command" ? ["pane-old", "pane-old"] : ["pane-split-1"]);
    expect(paneCommands).toEqual(commands.map(() => expect.stringContaining("--mini")));
    expect(metadata.at(-1)?.tokens).toMatchObject({
      forge_binding_id: scope.id,
      forge_task: scope.taskId,
      forge_role: "Worker",
      forge_model: scope.profile.modelID,
      forge_provider: scope.profile.providerID,
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
