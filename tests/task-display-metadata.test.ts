import { expect, test, vi } from "vitest";
import type { PaneProcessInfo } from "../src/integrations/herdr/client.js";
import type { TaskScope } from "../src/runtimes/task-harness.js";
import { attachTaskDisplay, type TaskPanePort } from "../src/runtimes/task-display.js";

const profile = { providerID: "openai", modelID: "gpt-5.6-sol", reasoningEffort: "medium", serviceTier: "priority" } as const;
const scopes: { scope: TaskScope; role: string }[] = [
  { scope: { id: "root-session", taskId: "task-123", directory: "/repo", workflow: "standard", evidenceRoot: null, profile, role: "root", identity: { taskId: "task-123", sessionId: "root-session", generation: 1 } }, role: "Coordinator" },
  { scope: { id: "worker-session", taskId: "task-123", directory: "/repo", workflow: "standard", evidenceRoot: null, profile, role: "worker", workerMode: "planned", purpose: "implementation" }, role: "Worker" },
  { scope: { id: "advisor-session", taskId: "task-123", directory: "/repo", workflow: "independent_review", evidenceRoot: "/evidence", profile, role: "advisor", advisorRole: "reviewer", label: "Security reviewer" }, role: "Security reviewer" },
];
const workerScope: TaskScope = { id: "worker-session", taskId: "task-123", directory: "/repo", workflow: "standard", evidenceRoot: null, profile, role: "worker", workerMode: "planned", purpose: "implementation" };

function matchingDisplay(scope: TaskScope, reportPaneMetadata = vi.fn<TaskPanePort["reportPaneMetadata"]>(async () => {})) {
  const argv = ["native", "attach", scope.id];
  const info: PaneProcessInfo = { pane_id: "pane", shell_pid: 10, foreground_process_group_id: 11, foreground_processes: [{ pid: 11, name: "native", argv }] };
  const shell: PaneProcessInfo = { pane_id: "pane-new", shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: "zsh", argv: ["/bin/zsh"] }] };
  const herdr: TaskPanePort = {
    getPane: async id => ({ paneId: id, cwd: scope.directory }),
    getPaneProcessInfo: async id => id === "pane-new" ? shell : info,
    createWorkspace: vi.fn(async () => ({ workspace: { workspaceId: "workspace", label: "Task" }, tab: { tabId: "tab", label: "Task" }, rootPane: { paneId: "pane-new", cwd: scope.directory } })),
    splitPane: vi.fn(),
    renamePane: vi.fn(async () => {}),
    runPaneCommand: vi.fn(async () => {}),
    reportPaneMetadata,
  };
  return { argv, herdr, reportPaneMetadata };
}

test.each(scopes)("refreshes lost metadata on a matching $role display", async ({ scope, role }) => {
  const f = matchingDisplay(scope);
  const persistPane = vi.fn();
  await expect(attachTaskDisplay(f.herdr, {
    scope,
    nativeSessionId: "native-session",
    paneId: "pane",
    persistPane,
    generation: "generation",
    isAttached: actual => actual === f.argv,
    command: "native attach",
  })).resolves.toBe("pane");
  expect(persistPane).toHaveBeenCalledWith("pane");
  expect(f.herdr.renamePane).toHaveBeenCalledWith("pane", `task-123 ${role}`);
  expect(f.reportPaneMetadata).toHaveBeenCalledWith({
    paneId: "pane",
    source: "forge",
    title: `task-123 ${role}`,
    tokens: {
      forge_binding_id: scope.id,
      forge_task_id: "task-123",
      forge_native_session_id: "native-session",
      forge_server_generation: "generation",
      forge_task: "task-123",
      forge_role: role,
      forge_model: "gpt-5.6-sol",
      forge_provider: "openai",
    },
  });
  expect(f.herdr.runPaneCommand).not.toHaveBeenCalled();
});

test("metadata refresh failure does not gate a proven native attachment", async () => {
  const scope = workerScope;
  const f = matchingDisplay(scope, vi.fn(async () => { throw new Error("Metadata unavailable"); }));
  await expect(attachTaskDisplay(f.herdr, {
    scope,
    nativeSessionId: "native-session",
    paneId: "pane",
    persistPane: vi.fn(),
    generation: "generation",
    isAttached: actual => actual === f.argv,
    command: "native attach",
  })).resolves.toBe("pane");
  expect(f.herdr.runPaneCommand).not.toHaveBeenCalled();
});

test("title and metadata publication failures do not gate a fresh native attachment", async () => {
  const scope = workerScope;
  const f = matchingDisplay(scope, vi.fn(async () => { throw new Error("Metadata unavailable"); }));
  f.herdr.renamePane = vi.fn(async () => { throw new Error("Title unavailable"); });
  const persistPane = vi.fn();
  await expect(attachTaskDisplay(f.herdr, {
    scope,
    nativeSessionId: "native-session",
    paneId: null,
    persistPane,
    generation: "generation",
    isAttached: () => false,
    command: "native attach",
  })).resolves.toBe("pane-new");
  expect(persistPane).toHaveBeenCalledWith("pane-new");
  expect(f.herdr.runPaneCommand).toHaveBeenCalledWith("pane-new", "native attach");
});

test("metadata does not make a different native attachment reusable", async () => {
  const scope = workerScope;
  const f = matchingDisplay(scope);
  await attachTaskDisplay(f.herdr, {
    scope,
    nativeSessionId: "native-session",
    paneId: "pane",
    persistPane: vi.fn(),
    generation: "generation",
    isAttached: () => false,
    command: "native attach",
  });
  expect(f.herdr.runPaneCommand).toHaveBeenCalledWith("pane-new", "native attach");
});
