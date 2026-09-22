import { expect, test, vi } from "vitest";
import type { Pane, PaneProcessInfo } from "../src/integrations/herdr/client.js";
import type { TaskScope } from "../src/runtimes/task-harness.js";
import { attachTaskDisplay, ensureTaskShellPane, type TaskPanePort } from "../src/runtimes/task-display.js";

const profile = { providerID: "opencode", modelID: "openai/gpt-5.6-sol", reasoningEffort: "medium", serviceTier: "priority" } as const;
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
    getPane: async id => id === "pane-gone" ? null : ({ paneId: id, cwd: scope.directory }),
    getPaneProcessInfo: async id => id === "pane" ? info : shell,
    createWorkspace: vi.fn(async () => ({ workspace: { workspaceId: "workspace", label: "Task" }, tab: { tabId: "tab", label: "Task" }, rootPane: { paneId: "pane-new", cwd: scope.directory } })),
    splitPane: vi.fn(async () => ({ paneId: "pane-split", cwd: scope.directory })),
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
    source: "suplex",
    title: `task-123 ${role}`,
    tokens: {
      suplex_binding_id: scope.id,
      suplex_task_id: "task-123",
      suplex_native_session_id: "native-session",
      suplex_server_generation: "generation",
      suplex_task: "task-123",
      suplex_role: role,
      suplex_model: "openai/gpt-5.6-sol",
      suplex_provider: "opencode",
    },
  });
  expect(f.herdr.runPaneCommand).not.toHaveBeenCalled();
});

function desiredDisplayPane(): Pane {
  return {
    paneId: "pane",
    cwd: "/repo",
    label: "task-123 Worker",
    title: "task-123 Worker",
    tokens: {
      suplex_binding_id: "worker-session",
      suplex_task_id: "task-123",
      suplex_native_session_id: "native-session",
      suplex_server_generation: "generation",
      suplex_task: "task-123",
      suplex_role: "Worker",
      suplex_model: "openai/gpt-5.6-sol",
      suplex_provider: "opencode",
      foreign_token: "kept",
    },
  };
}

function recoveryInput(argv: readonly string[]) {
  return {
    scope: workerScope,
    nativeSessionId: "native-session",
    paneId: "pane",
    persistPane: vi.fn(),
    generation: "generation",
    isAttached: (actual: readonly string[]) => actual === argv,
    command: "native attach",
  };
}

test("an unchanged native attachment needs no display writes on repeated recovery", async () => {
  const f = matchingDisplay(workerScope);
  const pane = desiredDisplayPane();
  f.herdr.getPane = async () => pane;
  const input = recoveryInput(f.argv);

  await attachTaskDisplay(f.herdr, input);
  await attachTaskDisplay(f.herdr, input);

  expect(f.herdr.renamePane).not.toHaveBeenCalled();
  expect(f.reportPaneMetadata).not.toHaveBeenCalled();
  expect(f.herdr.runPaneCommand).not.toHaveBeenCalled();
});

test.each([
  { name: "missing metadata after restart", change: (pane: Pane) => { delete pane.title; delete pane.tokens; }, rename: 0 },
  { name: "stale native session token", change: (pane: Pane) => { pane.tokens = { ...pane.tokens, suplex_native_session_id: "old" }; }, rename: 0 },
  { name: "stale generation token", change: (pane: Pane) => { pane.tokens = { ...pane.tokens, suplex_server_generation: "old" }; }, rename: 0 },
  { name: "stale metadata title", change: (pane: Pane) => { pane.title = "old title"; }, rename: 0 },
  { name: "stale pane label", change: (pane: Pane) => { pane.label = "old label"; }, rename: 1 },
])("repairs $name without replaying native work", async ({ change, rename }) => {
  const f = matchingDisplay(workerScope);
  const pane = desiredDisplayPane();
  change(pane);
  f.herdr.getPane = async () => pane;

  await attachTaskDisplay(f.herdr, recoveryInput(f.argv));

  expect(f.herdr.renamePane).toHaveBeenCalledTimes(rename);
  expect(f.reportPaneMetadata).toHaveBeenCalledTimes(rename === 1 ? 0 : 1);
  expect(f.herdr.runPaneCommand).not.toHaveBeenCalled();
});

test("a failed display write retries only its unrepaired field", async () => {
  const f = matchingDisplay(workerScope);
  const pane = desiredDisplayPane();
  pane.label = "old label";
  pane.title = "old title";
  f.herdr.getPane = async () => pane;
  let renameAttempts = 0;
  f.herdr.renamePane = vi.fn(async () => {
    renameAttempts += 1;
    if (renameAttempts === 1) throw new Error("rename unavailable");
    pane.label = "task-123 Worker";
  });
  let reportAttempts = 0;
  f.herdr.reportPaneMetadata = vi.fn(async () => {
    reportAttempts += 1;
    if (reportAttempts === 2) throw new Error("metadata unavailable");
    pane.title = "task-123 Worker";
  });
  const input = recoveryInput(f.argv);

  await attachTaskDisplay(f.herdr, input);
  expect(pane.label).toBe("old label");
  expect(pane.title).toBe("task-123 Worker");
  await attachTaskDisplay(f.herdr, input);
  expect(pane.label).toBe("task-123 Worker");
  pane.title = "old title";
  await attachTaskDisplay(f.herdr, input);
  expect(pane.title).toBe("old title");
  await attachTaskDisplay(f.herdr, input);
  expect(pane.title).toBe("task-123 Worker");

  expect(f.herdr.renamePane).toHaveBeenCalledTimes(2);
  expect(f.herdr.reportPaneMetadata).toHaveBeenCalledTimes(3);
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
  })).resolves.toBe("pane-split");
  expect(persistPane).toHaveBeenCalledWith("pane-split");
  expect(f.herdr.runPaneCommand).toHaveBeenCalledWith("pane-split", "native attach");
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
  expect(f.herdr.renamePane).not.toHaveBeenCalledWith("pane", expect.anything());
  expect(f.reportPaneMetadata).not.toHaveBeenCalledWith(expect.objectContaining({ paneId: "pane" }));
  expect(f.herdr.runPaneCommand).toHaveBeenCalledWith("pane-split", "native attach");
});

test("an unchanged Shell display needs no writes, but lost metadata is restored", async () => {
  const f = matchingDisplay(workerScope);
  const pane: Pane = { paneId: "pane-shell", cwd: "/repo", label: "Shell", title: "Shell", tokens: { suplex_binding_id: "task-123:shell", suplex_task_id: "task-123", suplex_task: "task-123", suplex_role: "shell", foreign_token: "kept" } };
  f.herdr.getPane = async () => pane;
  const input = { taskId: "task-123", cwd: "/repo", paneId: "pane-shell" };

  await ensureTaskShellPane(f.herdr, input);
  expect(f.herdr.renamePane).not.toHaveBeenCalled();
  expect(f.reportPaneMetadata).not.toHaveBeenCalled();
  delete pane.tokens;
  await ensureTaskShellPane(f.herdr, input);
  expect(f.herdr.renamePane).not.toHaveBeenCalled();
  expect(f.reportPaneMetadata).toHaveBeenCalledTimes(1);
});

test("a fresh attachment establishes the Shell pane before the session pane", async () => {
  const scope = workerScope;
  const f = matchingDisplay(scope);
  const persistShellPane = vi.fn();
  await expect(attachTaskDisplay(f.herdr, {
    scope,
    nativeSessionId: "native-session",
    paneId: null,
    persistPane: vi.fn(),
    persistShellPane,
    generation: "generation",
    isAttached: () => false,
    command: "native attach",
  })).resolves.toBe("pane-split");
  expect(f.herdr.createWorkspace).toHaveBeenCalledWith({ label: "suplex-task-123", cwd: "/repo", focus: false });
  expect(persistShellPane).toHaveBeenCalledWith("pane-new");
  expect(f.herdr.renamePane).toHaveBeenCalledWith("pane-new", "Shell");
  expect(f.reportPaneMetadata).toHaveBeenCalledWith(expect.objectContaining({ paneId: "pane-new", title: "Shell", tokens: expect.objectContaining({ suplex_role: "shell", suplex_task_id: "task-123", suplex_binding_id: "task-123:shell" }) }));
  expect(f.herdr.splitPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: "pane-new", direction: "down" }));
  expect(f.herdr.runPaneCommand).not.toHaveBeenCalledWith("pane-new", expect.anything());
});

test("a stale shell binding is rediscovered from the task workspace", async () => {
  const scope = workerScope;
  const f = matchingDisplay(scope);
  const shellPane = { paneId: "pane-shell", workspaceId: "workspace", cwd: "/repo", tokens: { suplex_task_id: "task-123", suplex_role: "shell", suplex_binding_id: "task-123:shell" } };
  f.herdr.listWorkspaces = async () => [{ workspaceId: "workspace", label: "suplex-task-123" }];
  f.herdr.listPanes = async () => [shellPane];
  const persistShellPane = vi.fn();
  await expect(attachTaskDisplay(f.herdr, {
    scope,
    nativeSessionId: "native-session",
    paneId: null,
    shellPaneId: "pane-gone",
    persistPane: vi.fn(),
    persistShellPane,
    generation: "generation",
    isAttached: () => false,
    command: "native attach",
  })).resolves.toBe("pane-split");
  expect(persistShellPane).toHaveBeenCalledWith("pane-shell");
  expect(f.herdr.createWorkspace).not.toHaveBeenCalled();
  expect(f.herdr.splitPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: "pane-shell" }));
});

test("a missing shell pane never blocks a session attachment", async () => {
  const scope = workerScope;
  const f = matchingDisplay(scope);
  f.herdr.listWorkspaces = async () => { throw new Error("Herdr is unavailable"); };
  f.herdr.listPanes = async () => { throw new Error("Herdr is unavailable"); };
  await expect(attachTaskDisplay(f.herdr, {
    scope,
    nativeSessionId: "native-session",
    paneId: null,
    shellPaneId: "pane-gone",
    persistPane: vi.fn(),
    persistShellPane: vi.fn(),
    generation: "generation",
    isAttached: () => false,
    command: "native attach",
  })).resolves.toBe("pane-new");
  expect(f.herdr.runPaneCommand).toHaveBeenCalledWith("pane-new", "native attach");
});
