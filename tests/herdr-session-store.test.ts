import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { expect, test, vi } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { runCommand } from "../src/command-runner.js";
import { HerdrFailure, type HerdrAgent, type Pane } from "../src/herdr-client.js";
import { agentName, developerPaneEnvironment, HerdrSessionStore, herdrLabel, launchFingerprint, type RoleSessionTask } from "../src/herdr-session-store.js";
import { claudeRuntime } from "../src/agent-providers/herdr-runtime.js";
import { ProviderCredentialStore } from "../src/provider-credentials.js";

test("labels and agent names are bounded, stable, and valid", () => {
  expect(herdrLabel("ACME / Issue 12!")).toBe("acme-issue-12");
  expect(agentName("A very long issue title that needs clipping", "task-0123456789", "builder")).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  expect(agentName("issue", "task-0123456789", "planner", true)).not.toBe(agentName("issue", "task-0123456789", "planner"));
  expect(agentName("A very long issue title that needs clipping", "task-0123456789", "reviewer", false, 1)).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  expect(launchFingerprint({ model: "gpt", reasoningLevel: "high", serviceTier: "priority" })).toHaveLength(64);
  expect(launchFingerprint({ model: "gpt", reasoningLevel: "high", serviceTier: "priority" }, "/worktrees/one")).not.toBe(launchFingerprint({ model: "gpt", reasoningLevel: "high", serviceTier: "priority" }, "/worktrees/two"));
});

test("developer pane replacement clears secrets and preserves terminal and locale defaults", () => {
  const command = developerPaneEnvironment({
    guardDirectory: "/guard",
    gitRealBin: "/usr/bin/git",
    env: {
      PATH: "/mise/shims:/usr/bin",
      HOME: "/home/forge",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "pane-1",
      SECRET: "never",
      MISE_TRUSTED_CONFIG_PATHS: "/repo",
    },
    readinessSentinel: "/runtime/herdr-ready/sentinel",
  });
  expect(command).toContain("exec env -i");
  expect(command).toContain("PATH='/guard:/mise/shims:/usr/bin'");
  expect(command).toContain("FORGE_GIT_REAL_BIN='/usr/bin/git'");
  expect(command).toContain("ZDOTDIR='/guard'");
  expect(command).toContain("FORGE_HERDR_READINESS_SENTINEL='/runtime/herdr-ready/sentinel'");
  expect(command).toContain("TERM='xterm-256color'");
  expect(command).toContain("/bin/sh -c");
  expect(command).not.toContain("SECRET");
  expect(command).toContain("HERDR_SOCKET_PATH='/tmp/herdr.sock'");
  expect(command).toContain('HERDR_PANE_ID="$HERDR_PANE_ID"');
  expect(command).not.toContain("pane-1");
});

test("OpenRouter developer preparation sources the secret file without writing its value", () => {
  const command = developerPaneEnvironment({
    guardDirectory: "/guard",
    gitRealBin: "/usr/bin/git",
    env: { PATH: "/usr/bin" },
    secretsFile: "/runtime/secrets/openrouter-session.env",
  });
  expect(command).toContain(". '/runtime/secrets/openrouter-session.env';");
  expect(command).toContain('OPENROUTER_API_KEY="$OPENROUTER_API_KEY"');
  expect(command).not.toContain("sk-openrouter-secret");
});

test("removes a retired OpenRouter secret file", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-openrouter-secret-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const path = join(root, "secrets", "openrouter-session-1.env");
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, "export OPENROUTER_API_KEY='sk-openrouter-secret'\n", { mode: 0o600 });
    const store = new HerdrSessionStore(database, {} as never);
    await store.removeSecrets(root, "session-1");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("role sessions use workflow-compatible session identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-herdr-session-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', '/repo', '/worktrees', 'acme/forge', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('artifact_1', 'company_1', 'task-brief', 'task.md', 'text/markdown', 1, ?, 'artifacts/task.md', ?)").run("a".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', 'artifact_1', '[]', '{}', 0, 'workflow_1', 'revision_1', 'key_1', ?, ?)").run(now, now);
    });
    const store = new HerdrSessionStore(database, {} as never);
    const row = (store as unknown as { reserve(task: { taskId: string; projectId: string; projectSlug: string; worktreePath: string }, role: "planner"): { id: string } }).reserve({ taskId: "task_1", projectId: "project_1", projectSlug: "project", worktreePath: "/worktrees/task_1" }, "planner");
    expect(row.id).toMatch(/^session_[a-f0-9]{24}$/);
    expect(store.readRoleSession(row.id)).toMatchObject({ id: row.id });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stale workspace and tab mappings are replaced with live layout coordinates", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-herdr-stale-layout-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  const calls: string[] = [];
  const herdr = {
    async getWorkspace(id: string) {
      calls.push(`workspace:${id}`);
      return null;
    },
    async createWorkspace() {
      calls.push("create-workspace");
      return {
        workspace: { workspaceId: "wA", label: "sampler" },
        tab: { tabId: "wA:t1", label: "initial" },
        rootPane: { paneId: "wA:p1" },
      };
    },
    async getTab(id: string) {
      calls.push(`tab:${id}`);
      return null;
    },
    async getPane(id: string) {
      calls.push(`pane:${id}`);
      return null;
    },
    async createTab() {
      calls.push("create-tab");
      return {
        tab: { tabId: "wA:t2", label: "TASK-1" },
        rootPane: { paneId: "wA:p2" },
      };
    },
    async renamePane(id: string, label: string) {
      calls.push(`rename:${id}:${label}`);
    },
  };
  const task = {
    taskId: "task_1",
    projectId: "project_1",
    projectSlug: "sampler",
    issueKey: "TASK-1",
    worktreePath: "/worktrees/task_1",
    runtimeRoot: root,
  };
  try {
    database.authQuery((db) => {
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project_1', 'company_1', 'Sampler', '/repo', '/worktrees', 'acme/sampler', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('artifact_1', 'company_1', 'task-brief', 'task.md', 'text/markdown', 1, ?, 'artifacts/task.md', ?)").run("a".repeat(64), now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Task', 'artifact_1', '[]', '{}', 0, 'workflow_1', 'revision_1', 'key_1', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_herdr_project_workspaces (project_id, workspace_label, workspace_id, state, created_at, updated_at) VALUES ('project_1', 'sampler', 'w2E', 'open', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_herdr_task_tabs (task_id, project_id, workspace_id, tab_label, tab_id, shell_pane_id, state, created_at, updated_at) VALUES ('task_1', 'project_1', 'w2E', 'TASK-1', 'w2E:t2', 'w2E:p2', 'open', ?, ?)").run(now, now);
    });
    const store = new HerdrSessionStore(database, herdr as never);
    const workspace = await (store as unknown as { workspace(task: RoleSessionTask): Promise<{ workspaceId: string }> }).workspace(task);
    const tab = await (store as unknown as { tab(task: RoleSessionTask, workspaceId: string): Promise<{ tabId: string; workspaceId: string; freshRootPaneId: string | null }> }).tab(task, workspace.workspaceId);

    expect(workspace).toEqual({ workspaceId: "wA" });
    expect(tab).toEqual({ tabId: "wA:t2", workspaceId: "wA", freshRootPaneId: "wA:p2" });
    expect(calls).toEqual([
      "workspace:w2E",
      "create-workspace",
      "tab:w2E:t2",
      "create-tab",
    ]);
    expect(database.authQuery((db) => db.prepare("SELECT workspace_id FROM forge_herdr_project_workspaces WHERE project_id = 'project_1'").get())).toEqual({ workspace_id: "wA" });
    expect(database.authQuery((db) => db.prepare("SELECT workspace_id, tab_id, shell_pane_id FROM forge_herdr_task_tabs WHERE task_id = 'task_1'").get())).toEqual({ workspace_id: "wA", tab_id: "wA:t2", shell_pane_id: null });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

class StartupHerdrFake {
  readonly agents = new Map<string, HerdrAgent>();
  readonly closed: string[] = [];
  readonly starts: string[] = [];
  readonly renames: string[] = [];
  readonly startInputs: Array<{ name: string; paneId: string; kind?: string; args?: string[] }> = [];
  readonly splitFrom: string[] = [];
  readonly panes: string[] = [];
  readonly commands: string[] = [];
  readonly launchPaths: string[] = [];
  readonly launchScripts: string[] = [];
  readonly closeFailures = new Map<string, HerdrFailure>();
  readonly startAttempts: string[] = [];
  readonly renamed: Array<{ target: string; name: string }> = [];
  failStartOnce = false;
  startFailure: unknown;
  renameFailure: unknown;
  inactiveNameOnStart = false;
  writeReadiness = true;
  responses: Array<HerdrAgent | null> = [];
  getAgentFailure: HerdrFailure | undefined;
  paneText = "";

  async readPane() { return this.paneText; }

  async getAgent(_name: string) {
    if (this.getAgentFailure) throw this.getAgentFailure;
    return this.responses.shift() ?? this.agents.get(_name) ?? null;
  }
  async renameAgent(target: string, name: string) {
    this.renamed.push({ target, name });
    if (this.renameFailure) throw this.renameFailure;
  }
  async listAgents() { return [...this.agents.values()]; }
  async getWorkspace() { return null; }
  async createWorkspace() {
    return { workspace: { workspaceId: "workspace", label: "project" }, tab: { tabId: "tab", label: "task" }, rootPane: { paneId: "workspace-root" } };
  }
  tabResult: { tabId: string; label: string } | null = null;
  async getTab() { return this.tabResult; }
  async getPane(id: string) {
    return this.panes.includes(id) ? { paneId: id, tabId: "tab" } : null;
  }
  nextPane(): string {
    const paneId = `pane-${this.panes.length + 1}`;
    this.panes.push(paneId);
    return paneId;
  }
  async createTab() {
    return { tab: { tabId: "tab", label: "task" }, rootPane: { paneId: this.nextPane() } };
  }
  async renamePane(id: string, label: string) {
    this.renames.push(`${id}:${label}`);
  }
  async runPaneCommand(paneId: string, command: string) {
    this.commands.push(`${paneId}:${command}`);
    const script = /^source '([^']+)'$/.exec(command)?.[1];
    const body = script ? await readFile(script, "utf8") : command;
    if (script) {
      this.launchPaths.push(script);
      this.launchScripts.push(body);
    }
    const readinessId = /herdr-ready\/([0-9a-f-]+)/.exec(body)?.[1];
    const path = script && readinessId
      ? join(dirname(dirname(script)), "herdr-ready", readinessId)
      : /FORGE_HERDR_READINESS_SENTINEL='([^']+)'/.exec(body)?.[1];
    if (path && this.writeReadiness) await writeFile(path, "ok");
  }
  async splitPane(input: { paneId: string }): Promise<Pane> {
    this.splitFrom.push(input.paneId);
    const paneId = this.nextPane();
    return { paneId };
  }
  async closePane(paneId: string) {
    this.closed.push(paneId);
    const failure = this.closeFailures.get(paneId);
    if (failure) throw failure;
  }
  async startAgent(input: { name: string; paneId: string; kind?: string; args?: string[] }) {
    this.startInputs.push(input);
    this.startAttempts.push(input.name);
    if (this.startFailure) throw this.startFailure;
    if (this.inactiveNameOnStart) {
      this.inactiveNameOnStart = false;
      throw new HerdrFailure(
        "agent_name_not_found",
        true,
        `agent ${input.name} is not an active named agent`,
      );
    }
    if (this.failStartOnce) {
      this.failStartOnce = false;
      throw new HerdrFailure(
        "pane_not_available",
        true,
        "agent target pane is not an available shell",
      );
    }
    this.starts.push(input.name);
    const live = { name: input.name, paneId: input.paneId, status: "starting" };
    this.agents.set(input.name, live);
    return live;
  }
}

async function startupFixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-herdr-startup-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'owner/repo', 'main', 'main', 'true', 'true', '[]', '{}', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief.md', ?)").run("b".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?)").run(now, now);
  });
  return { database, root };
}

const startupTask: RoleSessionTask = {
  taskId: "task",
  projectId: "project",
  projectSlug: "project",
  issueKey: "TASK",
  worktreePath: "/worktrees/task",
  runtimeRoot: "/runtime",
};
const startupSettings = { model: "gpt", reasoningLevel: "high", serviceTier: "priority" as const };
const taskFor = (runtimeRoot: string): RoleSessionTask => ({
  ...startupTask,
  runtimeRoot,
});

test("an OpenRouter session rejects a missing key before it creates a pane", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  const store = new HerdrSessionStore(value.database, herdr as never);
  try {
    await expect(store.ensureRoleSession(taskFor(value.root), "planner", { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", reasoningLevel: "high", serviceTier: "default" })).rejects.toMatchObject({
      code: "authentication-required", message: expect.stringContaining("Settings > Providers"),
    });
    expect(herdr.panes).toEqual([]);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("an OpenRouter lead sources a protected secret file without exposing its key", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  const credentials = new ProviderCredentialStore(value.database);
  credentials.set("openrouter", "sk-openrouter-session-secret");
  const store = new HerdrSessionStore(value.database, herdr as never, process.env, undefined, undefined, credentials);
  try {
    await store.ensureRoleSession(taskFor(value.root), "planner", { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", reasoningLevel: "high", serviceTier: "default" });
    const file = join(value.root, "secrets", (await readdir(join(value.root, "secrets")))[0]!);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(herdr.commands.join("\n")).toContain(file);
    expect(herdr.commands.join("\n")).not.toContain("sk-openrouter-session-secret");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("starts a fresh session without waiting for its lazy Codex identity", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    await expect(
      store.ensureRoleSession(taskFor(value.root), "planner", startupSettings),
    ).resolves.toMatchObject({ codexSessionId: null, paneId: "pane-1" });
    expect(herdr.panes).toEqual(["pane-1"]);
    expect(herdr.starts).toHaveLength(1);
    expect(herdr.commands[0]).toContain("/herdr-ready/");
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("the first role pane is the tab root pane and no pane is named shell", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    await expect(
      store.ensureRoleSession(taskFor(value.root), "planner", startupSettings),
    ).resolves.toMatchObject({ paneId: "pane-1" });
    expect(herdr.panes).toEqual(["pane-1"]);
    expect(herdr.renames).toEqual(["pane-1:planner"]);
    expect(herdr.renames.some((entry) => entry.endsWith(":shell"))).toBe(false);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a second role splits from the live sibling role pane", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  herdr.tabResult = { tabId: "tab", label: "task" };
  try {
    const home = join(value.root, "home");
    await mkdir(home);
    await writeFile(join(home, ".zshrc"), 'export PATH="/usr/bin"\n');
    const store = new HerdrSessionStore(
      value.database,
      herdr as never,
      {
        ...process.env,
        PATH: "/mise/shims:/usr/bin",
        HOME: home,
        SHELL: "/bin/zsh",
      },
      async () => {},
    );
    await store.ensureRoleSession(taskFor(value.root), "planner", startupSettings);
    await store.ensureRoleSession(taskFor(value.root), "builder", startupSettings);

    expect(herdr.panes).toEqual(["pane-1", "pane-2"]);
    expect(herdr.splitFrom).toEqual(["pane-1"]);
    expect(herdr.renames).toContain("pane-2:builder");
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("keeps an agent pane open and records its startup trust prompt", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  herdr.startFailure = new HerdrFailure("agent_not_ready", false, "agent is blocked during startup and is not ready for prompts");
  herdr.paneText = "Do you trust the contents of this directory?   1. Yes, continue";
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    await expect(store.ensureRoleSession(taskFor(value.root), "planner", startupSettings)).rejects.toMatchObject({ code: "agent_startup_blocked" });
    expect(value.database.authQuery((db) => db.prepare("SELECT status, pane_id, attention_excerpt FROM forge_herdr_role_sessions WHERE task_id = 'task'").get())).toEqual({ status: "blocked", pane_id: "pane-1", attention_excerpt: "Do you trust the contents of this directory? 1. Yes, continue" });
    expect(herdr.closed).toEqual([]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("developer launches the guarded environment from a short private script", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  try {
    const home = join(value.root, "home");
    await mkdir(home);
    await writeFile(
      join(home, ".zshrc"),
      'export PATH="/usr/bin"\nTRAPEXIT() { echo "$PATH"; command -v git; }\n',
    );
    const store = new HerdrSessionStore(
      value.database,
      herdr as never,
      {
        ...process.env,
        PATH: "/mise/shims:/usr/bin",
        HOME: home,
        SHELL: "/bin/zsh",
        SECRET: "never",
      },
      async () => {},
    );
    await store.ensureRoleSession(
      taskFor(value.root),
      "builder",
      startupSettings,
    );

    const command = herdr.commands.at(-1)!;
    expect(command.length).toBeLessThan(200);
    expect(command).toMatch(/:source '.*\/herdr-launch\/.*\.sh'$/);
    expect(herdr.launchScripts).toHaveLength(1);
    expect(herdr.launchScripts[0]).toContain("exec env -i");
    expect(herdr.launchScripts[0]).toContain("PATH='");
    expect(herdr.launchScripts[0]).toContain("FORGE_GIT_GUARD_DIR='");
    expect(herdr.launchScripts[0]).toContain("exec '");
    expect(herdr.launchScripts[0]).not.toContain("SECRET");
    expect(herdr.commands.at(-1)).not.toContain("exec env -i");
    const guard = value.database.authQuery((db) =>
      db
        .prepare("SELECT guard_directory FROM forge_herdr_role_sessions WHERE task_id = 'task'")
        .get() as { guard_directory: string },
    ).guard_directory;
    const launched = await runCommand({
      taskId: null,
      stepId: null,
      command: "/bin/sh",
      args: ["-c", herdr.launchScripts[0]!.replace("exec '/bin/zsh' -i", "exec '/bin/zsh' -ic 'exit'")],
      cwd: value.root,
      timeout: 5_000,
    });
    expect(launched.exitCode).toBe(0);
    expect(launched.stdout).toContain(`${guard}:`);
    expect(launched.stdout).toContain(`${dirname(process.execPath)}:/usr/bin`);
    expect(launched.stdout).toContain(`${guard}/git`);
    await expect(readFile(herdr.launchPaths[0]!, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a retired Developer session is replaced by a new generation", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    const first = await store.ensureRoleSession(taskFor(value.root), "builder", startupSettings);
    value.database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET is_current = 0, status = 'closed' WHERE id = ?").run(first.id));

    const second = await store.ensureRoleSession(taskFor(value.root), "builder", startupSettings);

    expect(second.id).not.toBe(first.id);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(value.database.authQuery((db) => db.prepare("SELECT is_current, status FROM forge_herdr_role_sessions WHERE id = ?").get(first.id))).toEqual({ is_current: 0, status: "closed" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("adopts a recorded live agent with a matching fingerprint without splitting", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  herdr.responses = [{ name: "task-planner", paneId: "pane-recorded", status: "starting" }];
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    const row = (store as unknown as {
      reserve(task: RoleSessionTask, role: "planner"): { id: string };
    }).reserve(taskFor(value.root), "planner");
    value.database.authQuery((db) =>
      db
        .prepare(
          "UPDATE forge_herdr_role_sessions SET agent_name = 'task-planner', pane_id = 'pane-recorded', launch_fingerprint = ? WHERE id = ?",
        )
        .run(launchFingerprint(startupSettings, taskFor(value.root).worktreePath), row.id),
    );
    await expect(
      store.ensureRoleSession(taskFor(value.root), "planner", startupSettings),
    ).resolves.toMatchObject({ codexSessionId: null, paneId: "pane-recorded" });
    expect(herdr.closed).toEqual([]);
    expect(herdr.panes).toEqual([]);
    expect(herdr.starts).toHaveLength(0);
    expect(value.database.authQuery((db) => db.prepare("SELECT agent_name, pane_id FROM forge_herdr_role_sessions WHERE id = ?").get(row.id))).toEqual({ agent_name: "task-planner", pane_id: "pane-recorded" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("does not adopt a matching live name from another pane", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  herdr.agents.set("task-planner", { name: "task-planner", paneId: "foreign-pane", status: "starting" });
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    const row = (store as unknown as { reserve(task: RoleSessionTask, role: "planner"): { id: string } }).reserve(taskFor(value.root), "planner");
    value.database.authQuery((db) =>
      db.prepare("UPDATE forge_herdr_role_sessions SET agent_name = 'task-planner', pane_id = 'pane-recorded', launch_fingerprint = ? WHERE id = ?").run(launchFingerprint(startupSettings, taskFor(value.root).worktreePath), row.id),
    );

    await expect(store.ensureRoleSession(taskFor(value.root), "planner", startupSettings)).resolves.toMatchObject({
      agentName: agentName("TASK", "task", "planner", true),
      paneId: "pane-1",
    });
    expect(herdr.panes).toEqual(["pane-1"]);
    expect(herdr.starts).toEqual([agentName("TASK", "task", "planner", true)]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("serializes concurrent ensures for the same role session", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    await Promise.all([
      store.ensureRoleSession(taskFor(value.root), "planner", startupSettings),
      store.ensureRoleSession(taskFor(value.root), "planner", startupSettings),
    ]);
    expect(herdr.panes).toEqual(["pane-1"]);
    expect(herdr.starts).toHaveLength(1);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("failed pane cleanup does not clear a row moved to another pane", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    const row = (store as unknown as { reserve(task: RoleSessionTask, role: "planner"): { id: string } }).reserve(taskFor(value.root), "planner");
    value.database.authQuery((db) =>
      db.prepare("UPDATE forge_herdr_role_sessions SET agent_name = 'task-planner', pane_id = 'new-pane', status = 'starting' WHERE id = ?").run(row.id),
    );

    await (store as unknown as { cleanupFailedPane(id: string, paneId: string): Promise<void> }).cleanupFailedPane(row.id, "old-pane");

    expect(value.database.authQuery((db) => db.prepare("SELECT agent_name, pane_id, status FROM forge_herdr_role_sessions WHERE id = ?").get(row.id))).toEqual({ agent_name: "task-planner", pane_id: "new-pane", status: "starting" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("relaunches a recorded live agent when its launch fingerprint changes", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  herdr.responses = [{ name: "task-planner", paneId: "pane-recorded", status: "starting" }];
  const changedSettings = { ...startupSettings, model: "gpt-new" };
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    const row = (store as unknown as {
      reserve(task: RoleSessionTask, role: "planner"): { id: string };
    }).reserve(taskFor(value.root), "planner");
    value.database.authQuery((db) =>
      db
        .prepare(
          "UPDATE forge_herdr_role_sessions SET agent_name = 'task-planner', pane_id = 'pane-recorded', launch_fingerprint = ? WHERE id = ?",
        )
        .run(launchFingerprint(startupSettings, taskFor(value.root).worktreePath), row.id),
    );

    await expect(
      store.ensureRoleSession(taskFor(value.root), "planner", changedSettings),
    ).resolves.toMatchObject({ paneId: "pane-1" });

    expect(herdr.closed).toEqual(["pane-recorded"]);
    expect(herdr.panes).toEqual(["pane-1"]);
    expect(herdr.starts).toEqual(["task-planner"]);
    expect(
      value.database.authQuery((db) =>
        db
          .prepare(
            "SELECT pane_id, launch_fingerprint FROM forge_herdr_role_sessions WHERE id = ?",
          )
          .get(row.id),
      ),
    ).toEqual({
      pane_id: "pane-1",
      launch_fingerprint: launchFingerprint(changedSettings, taskFor(value.root).worktreePath),
    });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("replaces a recorded pane that Herdr has already removed", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  herdr.closeFailures.set(
    "stale-pane",
    new HerdrFailure("pane_not_found", true, "Herdr resource is unavailable"),
  );
  try {
    const store = new HerdrSessionStore(
      value.database,
      herdr as never,
      process.env,
      async () => {},
    );
    const row = (store as unknown as {
      reserve(task: RoleSessionTask, role: "planner"): { id: string };
    }).reserve(taskFor(value.root), "planner");
    value.database.authQuery((db) =>
      db
        .prepare(
          "UPDATE forge_herdr_role_sessions SET agent_name = 'recorded-planner', pane_id = 'stale-pane' WHERE id = ?",
        )
        .run(row.id),
    );

    await expect(
      store.ensureRoleSession(taskFor(value.root), "planner", startupSettings),
    ).resolves.toMatchObject({ paneId: "pane-1" });

    expect(herdr.closed).toEqual(["stale-pane"]);
    expect(
      value.database.authQuery((db) =>
        db
          .prepare(
            "SELECT pane_id FROM forge_herdr_role_sessions WHERE id = ?",
          )
          .get(row.id),
      ),
    ).toEqual({ pane_id: "pane-1" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("propagates a non-missing error while closing a recorded pane", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  herdr.closeFailures.set(
    "stale-pane",
    new HerdrFailure("unavailable", true, "Herdr command failed"),
  );
  try {
    const store = new HerdrSessionStore(
      value.database,
      herdr as never,
      process.env,
      async () => {},
    );
    const row = (store as unknown as {
      reserve(task: RoleSessionTask, role: "planner"): { id: string };
    }).reserve(taskFor(value.root), "planner");
    value.database.authQuery((db) =>
      db
        .prepare(
          "UPDATE forge_herdr_role_sessions SET agent_name = 'recorded-planner', pane_id = 'stale-pane' WHERE id = ?",
        )
        .run(row.id),
    );

    await expect(
      store.ensureRoleSession(taskFor(value.root), "planner", startupSettings),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(herdr.panes).toEqual(["pane-1"]);
    expect(
      value.database.authQuery((db) =>
        db
          .prepare(
            "SELECT pane_id FROM forge_herdr_role_sessions WHERE id = ?",
          )
          .get(row.id),
      ),
    ).toEqual({ pane_id: "stale-pane" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a recorded name never derives a replacement after its agent is missing", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    const row = (store as unknown as {
      reserve(task: RoleSessionTask, role: "planner"): { id: string };
    }).reserve(taskFor(value.root), "planner");
    value.database.authQuery((db) =>
      db
        .prepare(
          "UPDATE forge_herdr_role_sessions SET agent_name = 'recorded-planner' WHERE id = ?",
        )
        .run(row.id),
    );
    const derive = vi.spyOn(store as unknown as { deriveAgentName: (...args: unknown[]) => string }, "deriveAgentName");

    await store.ensureRoleSession(taskFor(value.root), "planner", startupSettings);

    expect(derive).not.toHaveBeenCalled();
    expect(herdr.starts).toEqual(["recorded-planner"]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("relaunches over an inactive recorded name with a collision suffix", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  herdr.getAgentFailure = new HerdrFailure(
    "agent_name_not_found",
    true,
    "agent recorded-planner is not an active named agent",
  );
  herdr.inactiveNameOnStart = true;
  try {
    const store = new HerdrSessionStore(
      value.database,
      herdr as never,
      process.env,
      async () => {},
    );
    const row = (store as unknown as {
      reserve(task: RoleSessionTask, role: "planner"): { id: string };
    }).reserve(taskFor(value.root), "planner");
    value.database.authQuery((db) =>
      db
        .prepare(
          "UPDATE forge_herdr_role_sessions SET agent_name = 'recorded-planner', pane_id = 'stale-pane' WHERE id = ?",
        )
        .run(row.id),
    );

    await expect(
      store.ensureRoleSession(taskFor(value.root), "planner", startupSettings),
    ).resolves.toMatchObject({
      agentName: agentName("TASK", "task", "planner", true),
      paneId: "pane-1",
    });

    expect(herdr.closed).toEqual(["stale-pane"]);
    expect(herdr.startAttempts).toEqual([
      "recorded-planner",
      agentName("TASK", "task", "planner", true),
    ]);
    expect(
      value.database.authQuery((db) =>
        db
          .prepare(
            "SELECT agent_name, pane_id FROM forge_herdr_role_sessions WHERE id = ?",
          )
          .get(row.id),
      ),
    ).toEqual({
      agent_name: agentName("TASK", "task", "planner", true),
      pane_id: "pane-1",
    });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a fresh row collision-renames a foreign live agent", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  herdr.agents.set("task-planner", { name: "task-planner", paneId: "foreign-pane" });
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});

    await store.ensureRoleSession(taskFor(value.root), "planner", startupSettings);

    expect(herdr.starts).toEqual([agentName("TASK", "task", "planner", true)]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("retries an unavailable shell once with a fresh pane", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  herdr.failStartOnce = true;
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    await expect(
      store.ensureRoleSession(taskFor(value.root), "planner", startupSettings),
    ).resolves.toMatchObject({ paneId: "pane-2" });
    expect(herdr.closed).toEqual(["pane-1"]);
    expect(herdr.panes).toEqual(["pane-1", "pane-2"]);
    expect(herdr.commands.some((entry) => entry.startsWith("pane-2:"))).toBe(true);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a missing resumed rollout fails the role session without another pane", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  const codexHome = join(value.root, "codex");
  herdr.startFailure = new HerdrFailure("launch_failed", true, "Codex exited immediately");
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, { ...process.env, CODEX_HOME: codexHome }, async () => {});
    const row = (store as unknown as { reserve(task: RoleSessionTask, role: "planner"): { id: string } }).reserve(taskFor(value.root), "planner");
    value.database.authQuery((db) =>
      db.prepare("UPDATE forge_herdr_role_sessions SET codex_session_id = 'missing-session' WHERE id = ?").run(row.id),
    );

    await expect(store.ensureRoleSession(taskFor(value.root), "planner", startupSettings)).rejects.toMatchObject({ code: "codex_session_unrecoverable", retryable: false });
    expect(herdr.panes).toEqual(["pane-1"]);
    expect(value.database.authQuery((db) => db.prepare("SELECT codex_session_id, status FROM forge_herdr_role_sessions WHERE id = ?").get(row.id))).toEqual({ codex_session_id: "missing-session", status: "failed" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude sessions preassign identities and launch through Herdr as Claude", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  const runtime = { ...claudeRuntime, candidatePaths: async () => [], prepareLaunch: async () => {} };
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {}, () => runtime);
    const session = await store.ensureRoleSession(taskFor(value.root), "planner", { provider: "claude", model: "claude-fable-5", reasoningLevel: "high", serviceTier: "default" });
    expect(session.provider).toBe("claude");
    expect(session.codexSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(herdr.startInputs).toContainEqual(expect.objectContaining({ kind: "claude", args: ["--model", "claude-fable-5", "--effort", "high", "--permission-mode", "bypassPermissions", "--session-id", session.codexSessionId] }));
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Claude resumes when its preassigned transcript already exists", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  const configDir = join(value.root, "claude");
  const sessionId = randomUUID();
  const runtime = { ...claudeRuntime, prepareLaunch: async () => {} };
  try {
    await mkdir(join(configDir, "projects", "-tmp-x"), { recursive: true });
    await writeFile(
      join(configDir, "projects", "-tmp-x", `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "user", cwd: value.root })}\n`,
    );
    const store = new HerdrSessionStore(
      value.database,
      herdr as never,
      { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      async () => {},
      () => runtime,
    );
    const task = { ...taskFor(value.root), worktreePath: value.root };
    const row = (store as unknown as {
      reserve(task: RoleSessionTask, role: "planner", settings: { provider: "claude"; model: string; reasoningLevel: string; serviceTier: "default" }): { id: string };
    }).reserve(task, "planner", { provider: "claude", model: "claude-fable-5", reasoningLevel: "high", serviceTier: "default" });
    value.database.authQuery((db) =>
      db.prepare("UPDATE forge_herdr_role_sessions SET codex_session_id = ? WHERE id = ?").run(sessionId, row.id),
    );

    await store.ensureRoleSession(task, "planner", { provider: "claude", model: "claude-fable-5", reasoningLevel: "high", serviceTier: "default" });

    expect(herdr.startInputs).toContainEqual(expect.objectContaining({
      kind: "claude",
      args: ["--model", "claude-fable-5", "--effort", "high", "--permission-mode", "bypassPermissions", "--resume", sessionId],
    }));
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("switching providers retires the old role session and closes its pane", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  const runtime = { ...claudeRuntime, candidatePaths: async () => [], prepareLaunch: async () => {} };
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {}, () => runtime);
    const old = (store as unknown as {
      reserve(task: RoleSessionTask, role: "planner", settings: { provider: "codex"; model: string; reasoningLevel: string; serviceTier: "priority" }): { id: string };
    }).reserve(taskFor(value.root), "planner", { provider: "codex", model: "gpt", reasoningLevel: "high", serviceTier: "priority" });
    value.database.authQuery((db) =>
      db.prepare("UPDATE forge_herdr_role_sessions SET pane_id = 'old-pane', agent_name = 'old-planner', status = 'ready' WHERE id = ?").run(old.id),
    );

    const current = await store.ensureRoleSession(taskFor(value.root), "planner", { provider: "claude", model: "claude-fable-5", reasoningLevel: "high", serviceTier: "default" });

    expect(herdr.closed).toEqual(["old-pane"]);
    expect(value.database.authQuery((db) =>
      db.prepare("SELECT is_current, status, pane_id, agent_name FROM forge_herdr_role_sessions WHERE id = ?").get(old.id),
    )).toEqual({ is_current: 0, status: "closed", pane_id: null, agent_name: null });
    expect(value.database.authQuery((db) =>
      db.prepare("SELECT provider_kind, is_current FROM forge_herdr_role_sessions WHERE id = ?").get(current.id),
    )).toEqual({ provider_kind: "claude", is_current: 1 });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("retiring a role session closes the current row and reports when none remains", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  try {
    const store = new HerdrSessionStore(value.database, herdr as never);
    const current = (store as unknown as {
      reserve(task: RoleSessionTask, role: "builder", settings: typeof startupSettings): { id: string };
    }).reserve(taskFor(value.root), "builder", startupSettings);
    value.database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET pane_id = 'builder-pane', agent_name = 'builder-agent', status = 'ready' WHERE id = ?").run(current.id));

    await expect(store.retireRoleSession("task", "builder")).resolves.toBe(true);
    expect(herdr.closed).toEqual(["builder-pane"]);
    expect(value.database.authQuery((db) => db.prepare("SELECT is_current, status, pane_id, agent_name FROM forge_herdr_role_sessions WHERE id = ?").get(current.id))).toEqual({ is_current: 0, status: "closed", pane_id: null, agent_name: null });
    await expect(store.retireRoleSession("task", "builder")).resolves.toBe(false);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("reviewer sessions are persistent and have bounded agent names", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    const task = { ...taskFor(value.root), issueKey: "A very long issue key that must leave room" };
    const first = await store.ensureRoleSession(task, "reviewer", startupSettings);
    const second = await store.ensureRoleSession(task, "reviewer", startupSettings);
    expect(first.id).toBe(second.id);
    expect(first.agentName).toBe(second.agentName);
    expect(first.agentName).toHaveLength(32);
    expect(second.agentName).toHaveLength(32);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test.each(["working", "idle", "done"])(
  "adopts a %s OMP argv-prompt agent after the live Herdr startup timeout",
  async (status) => {
    const value = await startupFixture();
    const herdr = new StartupHerdrFake();
    const credentials = new ProviderCredentialStore(value.database);
    credentials.set("openrouter", "sk-openrouter-session-secret");
    herdr.startFailure = Object.assign(
      new Error("Herdr command failed: timed out waiting for agent startup"),
      { code: "timeout", retryable: true },
    );
    herdr.responses.push({ name: "task-builder", paneId: "pane-1", status });
    try {
      const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {}, undefined, credentials);
      await expect(store.ensureRoleSession(
        taskFor(value.root),
        "builder",
        { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", reasoningLevel: "high", serviceTier: "default" },
        { initialPrompt: { path: join(value.root, "prompt.forge"), content: "prompt" } },
      )).resolves.toMatchObject({ agentName: "task-builder", paneId: "pane-1", launched: true });
      expect(herdr.closed).toEqual([]);
      expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_role_sessions WHERE task_id = 'task'").get())).toEqual({ status: status === "working" ? "working" : "ready" });
    } finally {
      value.database.close();
      await rm(value.root, { recursive: true, force: true });
    }
  },
);

test("rebinds an unnamed working OMP agent by its created pane after startup timeout", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  const credentials = new ProviderCredentialStore(value.database);
  credentials.set("openrouter", "sk-openrouter-session-secret");
  herdr.startFailure = new HerdrFailure("timeout", true, "timed out waiting for agent startup");
  herdr.responses.push(null, { name: "task-builder", paneId: "pane-1", status: "working" });
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {}, undefined, credentials);
    await expect(store.ensureRoleSession(
      taskFor(value.root),
      "builder",
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", reasoningLevel: "high", serviceTier: "default" },
      { initialPrompt: { path: join(value.root, "prompt.forge"), content: "prompt" } },
    )).resolves.toMatchObject({ agentName: "task-builder", paneId: "pane-1", launched: true });
    expect(herdr.renamed).toEqual([{ target: "pane-1", name: "task-builder" }]);
    expect(herdr.closed).toEqual([]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("closes the pane when rebinding a timed-out OMP agent conflicts", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  const credentials = new ProviderCredentialStore(value.database);
  credentials.set("openrouter", "sk-openrouter-session-secret");
  herdr.startFailure = new HerdrFailure("timeout", true, "timed out waiting for agent startup");
  herdr.renameFailure = new HerdrFailure("agent_name_conflict", false, "agent name is in use");
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {}, undefined, credentials);
    await expect(store.ensureRoleSession(
      taskFor(value.root),
      "builder",
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", reasoningLevel: "high", serviceTier: "default" },
      { initialPrompt: { path: join(value.root, "prompt.forge"), content: "prompt" } },
    )).rejects.toMatchObject({ code: "agent_name_conflict" });
    expect(herdr.renamed).toEqual([{ target: "pane-1", name: "task-builder" }]);
    expect(herdr.closed).toEqual(["pane-1"]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("does not adopt an absent OMP argv-prompt agent after Herdr startup timeout", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  const credentials = new ProviderCredentialStore(value.database);
  credentials.set("openrouter", "sk-openrouter-session-secret");
  herdr.startFailure = new HerdrFailure("timeout", true, "timed out waiting for agent startup");
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {}, undefined, credentials);
    await expect(store.ensureRoleSession(
      taskFor(value.root),
      "builder",
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", reasoningLevel: "high", serviceTier: "default" },
      { initialPrompt: { path: join(value.root, "prompt.forge"), content: "prompt" } },
    )).rejects.toMatchObject({ code: "timeout" });
    expect(herdr.closed).toEqual(["pane-1"]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});
test("does not adopt a startup timeout agent from another pane", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  const credentials = new ProviderCredentialStore(value.database);
  credentials.set("openrouter", "sk-openrouter-session-secret");
  herdr.startFailure = Object.assign(
    new Error("Herdr command failed: timed out waiting for agent startup"),
    { code: "timeout", retryable: true },
  );
  herdr.responses.push({ name: "task-builder", paneId: "foreign-pane", status: "working" });
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {}, undefined, credentials);
    await expect(store.ensureRoleSession(
      taskFor(value.root),
      "builder",
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", reasoningLevel: "high", serviceTier: "default" },
      { initialPrompt: { path: join(value.root, "prompt.forge"), content: "prompt" } },
    )).rejects.toMatchObject({ code: "timeout" });
    expect(herdr.closed).toEqual(["pane-1"]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("does not adopt a startup timeout without an OMP argv prompt", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  herdr.startFailure = Object.assign(
    new Error("Herdr command failed: timed out waiting for agent startup"),
    { code: "timeout", retryable: true },
  );
  herdr.responses.push({ name: "task-planner", paneId: "pane-1", status: "working" });
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    await expect(store.ensureRoleSession(
      taskFor(value.root),
      "planner",
      startupSettings,
      { initialPrompt: { path: join(value.root, "prompt.forge"), content: "prompt" } },
    )).rejects.toMatchObject({ code: "timeout" });
    expect(herdr.closed).toEqual(["pane-1"]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("does not adopt an OMP agent after a non-startup timeout", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  const credentials = new ProviderCredentialStore(value.database);
  credentials.set("openrouter", "sk-openrouter-session-secret");
  herdr.startFailure = Object.assign(
    new Error("Herdr command failed: timed out waiting for output match"),
    { code: "timeout", retryable: true },
  );
  herdr.responses.push({ name: "task-builder", paneId: "pane-1", status: "working" });
  try {
    const store = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {}, undefined, credentials);
    await expect(store.ensureRoleSession(
      taskFor(value.root),
      "builder",
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", reasoningLevel: "high", serviceTier: "default" },
      { initialPrompt: { path: join(value.root, "prompt.forge"), content: "prompt" } },
    )).rejects.toMatchObject({ code: "timeout" });
    expect(herdr.closed).toEqual(["pane-1"]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("startup timeout closes its created pane and releases the name", async () => {
  const value = await startupFixture();
  const herdr = new StartupHerdrFake();
  try {
    herdr.writeReadiness = false;
    const timedOut = new HerdrSessionStore(value.database, herdr as never, process.env, async () => {});
    await expect(
      timedOut.ensureRoleSession(taskFor(value.root), "planner", startupSettings),
    ).rejects.toMatchObject({ code: "readiness_timeout" });
    expect(herdr.closed).toEqual(["pane-1"]);
    expect(value.database.authQuery((db) => db.prepare("SELECT agent_name, pane_id, status FROM forge_herdr_role_sessions WHERE task_id = 'task'").get())).toEqual({ agent_name: null, pane_id: null, status: "unbound" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});
