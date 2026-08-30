import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ForgeDatabase } from "./database.js";
import {
  HerdrFailure,
  type HerdrAgent,
  type HerdrClient,
} from "./herdr-client.js";
import { herdrRuntime, type HerdrProviderRuntime } from "./agent-providers/herdr-runtime.js";
import type { AgentProviderKind, HerdrAgentKind } from "./agent-providers/provider.js";
import { ProviderCredentialStore } from "./provider-credentials.js";
import { SUPPORTED_NODE_VERSION } from "./config.js";
import { runCommand } from "./command-runner.js";
import { createGitCommandGuard, withWorktreeMiseTrust } from "./worktrees.js";
export type RoleSessionRole = "planner" | "builder" | "reviewer" | "integrator";
export interface LaunchSettings {
  provider?: AgentProviderKind;
  model: string;
  reasoningLevel: string;
  serviceTier: "default" | "priority" | "fast";
}
export interface RoleSessionTask {
  taskId: string;
  projectId: string;
  projectSlug: string;
  issueKey?: string;
  worktreePath: string;
  runtimeRoot: string;
}
export interface EnsuredRoleSession {
  id: string;
  provider: AgentProviderKind;
  agentName: string;
  paneId: string;
  codexSessionId: string | null;
  generation: number;
  rolloutPath?: string;
  live: HerdrAgent;
  launched: boolean;
}
const now = (): string => new Date().toISOString();
export interface EnsureRoleSessionOptions {
  initialPrompt?: { path: string; content: string };
}
const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const isMissingHerdrFailure = (error: unknown): boolean =>
  error instanceof HerdrFailure &&
  [
    "pane_not_found",
    "tab_not_found",
    "workspace_not_found",
    "agent_not_found",
    "agent_name_not_found",
  ].includes(error.code);
const isAgentStartupTimeout = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === "timeout" &&
    (message === "timed out waiting for agent startup" ||
      message === "Herdr command failed: timed out waiting for agent startup")
  );
};
export function herdrLabel(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "task"
  );
}
export function agentName(
  issue: string,
  taskId: string,
  role: RoleSessionRole,
  collision = false,
  _generation?: number,
): string {
  const base = herdrLabel(issue);
  const suffix = collision
    ? `-${herdrLabel(taskId).slice(-8)}-${role}`
    : `-${role}`;
  return `${base.slice(0, 32 - suffix.length)}${suffix}`
    .replace(/^-/, "a-")
    .slice(0, 32);
}
export function launchFingerprint(settings: LaunchSettings, cwd = ""): string {
  const { provider, ...profile } = settings;
  return createHash("sha256").update(JSON.stringify({ ...profile, ...(provider !== "codex" ? { provider } : {}), cwd })).digest("hex");
}
export function developerPaneEnvironment(input: {
  guardDirectory: string;
  gitRealBin: string;
  env: NodeJS.ProcessEnv;
  readinessSentinel?: string;
  secretsFile?: string;
}): string {
  const keys = [
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "COLORTERM",
    "CODEX_HOME",
    "MISE_DATA_DIR",
    "MISE_CONFIG_DIR",
    "MISE_TRUSTED_CONFIG_PATHS",
    "CARGO_TARGET_DIR",
    "PNPM_STORE_PATH",
    "npm_config_cache",
    "GOCACHE",
    "PIP_CACHE_DIR",
    "UV_CACHE_DIR",
    "CCACHE_DIR",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  ];
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env))
    if (value && (keys.includes(key) || key.startsWith("HERDR_"))) values[key] = value;
  values.TERM ??= "xterm-256color";
  values.PATH = `${input.guardDirectory}:${input.env.PATH ?? ""}`;
  values.FORGE_GIT_GUARD_DIR = input.guardDirectory;
  values.FORGE_GIT_REAL_BIN = input.gitRealBin;
  values.ZDOTDIR = input.guardDirectory;
  if (input.readinessSentinel)
    values.FORGE_HERDR_READINESS_SENTINEL = input.readinessSentinel;
  const shell = "/bin/zsh";
  // CI images can omit zsh. Keep the guarded environment usable with sh.
  // The fallback also writes the readiness file because it does not read zshrc.
  const script = `if [ -x ${quote(shell)} ]; then exec ${quote(shell)} -i; fi; PATH="$FORGE_GIT_GUARD_DIR:/usr/bin"; export PATH; printf '%s\\n' "$PATH"; command -v git; if [ -n "$FORGE_HERDR_READINESS_SENTINEL" ]; then printf ok > "$FORGE_HERDR_READINESS_SENTINEL"; fi; exec /bin/sh -i`;
  // Pane identity must be the target pane's own, not the worker's: Herdr's agent hooks report state to HERDR_PANE_ID.
  const paneIdentity = new Set(["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_TERMINAL_ID"]);
  const command = `exec env -i ${Object.entries(values)
    .map(([key, value]) => paneIdentity.has(key) ? `${key}="$${key}"` : `${key}=${quote(value)}`)
    .join(" ")}${input.secretsFile ? " OPENROUTER_API_KEY=\"$OPENROUTER_API_KEY\"" : ""} /bin/sh -c ${quote(script)}`;
  return input.secretsFile ? `. ${quote(input.secretsFile)}; ${command}` : command;
}
export class HerdrSessionStore {
  private readonly ensuring = new Map<string, Promise<void>>();
  constructor(
    private readonly database: ForgeDatabase,
    private readonly herdr: HerdrClient,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly runtimes: (kind: AgentProviderKind) => HerdrProviderRuntime = herdrRuntime,
    private readonly credentials: ProviderCredentialStore = new ProviderCredentialStore(database),
  ) {}
  readRoleSession(id: string): Record<string, unknown> | null {
    return this.database.authQuery((db) =>
      (db
        .prepare("SELECT * FROM forge_herdr_role_sessions WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined) ?? null,
    );
  }
  async ensureRoleSession(
    task: RoleSessionTask,
    role: RoleSessionRole,
    settings: LaunchSettings,
    options: EnsureRoleSessionOptions = {},
  ): Promise<EnsuredRoleSession> {
    const existing = this.database.authQuery((db) => db.prepare("SELECT * FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = ? AND is_current = 1").get(task.taskId, role) as Record<string, any> | undefined);
    const provider = settings.provider ?? "codex";
    if (existing && existing.provider_kind !== provider) {
      if (existing.pane_id) await this.closeRecordedPane(existing.id, existing.pane_id);
      if (existing.provider_kind === "openrouter") await this.removeSecrets(task.runtimeRoot, existing.id);
      this.database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET is_current = 0, status = 'closed', pane_id = NULL, agent_name = NULL, updated_at = ? WHERE id = ?").run(now(), existing.id));
    }
    const reserved = this.reserve(task, role, { ...settings, provider });
    const previous = this.ensuring.get(reserved.id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.ensuring.set(reserved.id, gate);
    await previous;
    try {
      return await this.ensureReserved(
        this.readRoleSession(reserved.id) ?? reserved,
        task,
        role,
        { ...settings, provider },
        options,
      );
    } finally {
      release();
      if (this.ensuring.get(reserved.id) === gate)
        this.ensuring.delete(reserved.id);
    }
  }
  async retireRoleSession(taskId: string, role: RoleSessionRole): Promise<boolean> {
    const existing = this.database.authQuery((db) => db.prepare("SELECT id, pane_id FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = ? AND is_current = 1").get(taskId, role) as { id: string; pane_id: string | null } | undefined);
    if (!existing) return false;
    if (existing.pane_id) await this.closeRecordedPane(existing.id, existing.pane_id);
    this.database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET is_current = 0, status = 'closed', pane_id = NULL, agent_name = NULL, updated_at = ? WHERE id = ?").run(now(), existing.id));
    return true;
  }
  private async ensureReserved(
    row: Record<string, any>,
    task: RoleSessionTask,
    role: RoleSessionRole,
    settings: LaunchSettings,
    options: EnsureRoleSessionOptions,
  ): Promise<EnsuredRoleSession> {
    if (settings.provider === "openrouter" && !this.credentials.get("openrouter"))
      throw new HerdrFailure("authentication-required", false, "OpenRouter API key is not configured. Add it in Settings > Providers and retry.");
    const fingerprint = launchFingerprint(settings, task.worktreePath);
    let closedPaneId: string | undefined;
    let paneMismatch = false;
    let existing = row.agent_name
      ? await this.getRecordedAgent(row.agent_name)
      : null;
    if (existing && existing.paneId === row.pane_id) {
      this.assertIdentity(row, existing);
      if (row.launch_fingerprint === fingerprint)
        return this.ready(row, existing, fingerprint, false);
      await this.closeRecordedPane(row.id, existing.paneId);
      closedPaneId = existing.paneId;
      existing = null;
    }
    if (existing) {
      existing = null;
      paneMismatch = true;
    }
    const workspace = await this.workspace(task);
    const tab = await this.tab(task, workspace.workspaceId);
    let name = paneMismatch ? null : row.agent_name;
    if (!name) {
      name = this.deriveAgentName(task, role, Number(row.generation));
      const liveNames = await this.herdr.listAgents();
      if (liveNames.some((candidate) => candidate.name === name))
        name = this.deriveAgentName(task, role, Number(row.generation), true);
    }
    this.database.authQuery((db) =>
      db
        .prepare(
          "UPDATE forge_herdr_role_sessions SET agent_name = ?, status = 'starting', updated_at = ? WHERE id = ?",
        )
        .run(name, now(), row.id),
    );
    if (row.pane_id && !existing && row.pane_id !== closedPaneId)
      await this.closeRecordedPane(row.id, row.pane_id);
    let paneId: string | undefined;
    let secretsFile: string | undefined;
    try {
      const pane = await this.allocateRolePane(task, tab, role);
      paneId = pane.paneId;
      this.database.authQuery((db) =>
        db
          .prepare(
            "UPDATE forge_herdr_role_sessions SET agent_name = ?, pane_id = ?, launch_fingerprint = ?, status = 'starting', updated_at = ? WHERE id = ?",
          )
          .run(name, pane.paneId, fingerprint, now(), row.id),
      );
      const readinessPath = await this.readinessPath(task.runtimeRoot);
      const shell = this.environment.SHELL || "/bin/zsh";
      let preparation = `export FORGE_HERDR_READINESS_SENTINEL=${quote(readinessPath)}; exec ${quote(shell)} -ic ${quote(
        `printf ok > "$FORGE_HERDR_READINESS_SENTINEL"; exec ${quote(shell)} -f`,
      )}`;
      if (settings.provider === "openrouter") {
        const credential = this.credentials.get("openrouter");
        if (!credential) throw new HerdrFailure("authentication-required", false, "OpenRouter API key is not configured. Add it in Settings > Providers and retry.");
        const directory = join(task.runtimeRoot, "secrets");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        secretsFile = join(directory, `openrouter-${row.id}.env`);
        await writeFile(secretsFile, `export OPENROUTER_API_KEY=${quote(credential.secret)}\n`, { mode: 0o600 });
        await chmod(secretsFile, 0o600);
        if (role !== "builder" && role !== "integrator") preparation = `. ${quote(secretsFile)}; ${preparation}`;
      }
      if (role === "builder" || role === "integrator") {
        const guard = await createGitCommandGuard(task.runtimeRoot, `developer-guard-${row.id}`);
        const gitRealBin = guard.gitRealBin ?? guard.env.FORGE_GIT_REAL_BIN;
        if (!gitRealBin)
          throw new HerdrFailure(
            "guard_invalid",
            false,
            "Developer Git guard is incomplete",
          );
        await this.writeDeveloperZshrc(guard.directory, task.worktreePath);
        preparation = developerPaneEnvironment({
          guardDirectory: guard.directory,
          gitRealBin,
          env: withWorktreeMiseTrust(this.environment, task.worktreePath),
          readinessSentinel: readinessPath,
          ...(secretsFile ? { secretsFile } : {}),
        });
        await this.preparePane(
          pane.paneId,
          task.runtimeRoot,
          preparation,
          readinessPath,
          true,
        );
        this.database.authQuery((db) =>
          db
            .prepare(
              "UPDATE forge_herdr_role_sessions SET guard_directory = ? WHERE id = ?",
            )
            .run(guard.directory, row.id),
        );
      } else {
        await this.preparePane(
          pane.paneId,
          task.runtimeRoot,
          preparation,
          readinessPath,
        );
      }
      const runtime = this.runtimes(settings.provider ?? "codex");
      if (runtime.presetSessionId && !row.codex_session_id) {
        this.database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET codex_session_id = ? WHERE id = ? AND codex_session_id IS NULL").run(randomUUID(), row.id));
        row = this.readRoleSession(row.id)!;
      }
      const transcriptExists = row.codex_session_id ? await this.hasRollout(runtime, row.codex_session_id, task.worktreePath) : false;
      const initialPromptPath = runtime.kind === "omp" && options.initialPrompt
        ? await this.writeInitialPrompt(options.initialPrompt)
        : undefined;
      const args = runtime.launchArgs(settings, row.codex_session_id ?? null, transcriptExists, initialPromptPath);
      let live: HerdrAgent;
      try {
        await runtime.prepareLaunch({ cwd: task.worktreePath, env: this.environment });
        live = await this.startOrReplace({
          sessionId: row.id,
          name,
          paneId: pane.paneId,
          kind: runtime.kind,
          args,
          task,
          tab,
          role,
          generation: Number(row.generation),
          preparation,
          scriptFile: role === "builder" || role === "integrator",
          readinessPath,
          adoptTimedOutArgvPrompt: runtime.kind === "omp" && initialPromptPath !== undefined,
        });
      } catch (error) {
        if (!runtime.presetSessionId && row.codex_session_id && !transcriptExists)
          throw new HerdrFailure("codex_session_unrecoverable", false, "The recorded agent session transcript is missing");
        throw error;
      }
      this.assertIdentity(row, live);
      this.started(row, live, fingerprint);
      return this.ready(
        { ...row, agent_name: name, pane_id: live.paneId, generation: Number(row.generation) + 1 },
        live,
        fingerprint,
        true,
      );
    } catch (error) {
      if (secretsFile) await this.removeSecrets(task.runtimeRoot, row.id);
      if (paneId && error instanceof HerdrFailure && error.code === "agent_not_ready") {
        const excerpt = await this.startupExcerpt(paneId);
        const summary = `Agent blocked during startup in ${paneId}: ${excerpt.split("\n")[0] || error.message}`;
        this.database.authQuery((db) =>
          db.prepare("UPDATE forge_herdr_role_sessions SET status = 'blocked', attention_excerpt = ?, attention_activated_at = ?, updated_at = ? WHERE id = ? AND pane_id = ?")
            .run(excerpt, now(), now(), row.id, paneId),
        );
        throw new HerdrFailure("agent_startup_blocked", false, summary);
      }
      if (
        paneId &&
        !(error instanceof HerdrFailure && ["agent_blocked", "agent_startup_blocked"].includes(error.code))
      )
        await this.cleanupFailedPane(row.id, paneId);
      if (
        error instanceof HerdrFailure &&
        error.code === "codex_session_unrecoverable"
      )
        this.database.authQuery((db) =>
          db
            .prepare(
              "UPDATE forge_herdr_role_sessions SET status = 'failed', updated_at = ? WHERE id = ?",
            )
            .run(now(), row.id),
        );
      throw error;
    }
  }
  private async startupExcerpt(paneId: string): Promise<string> {
    try {
      return (await this.herdr.readPane(paneId)).replace(/\s+/g, " ").trim().slice(0, 300) || "Agent is waiting at a startup prompt.";
    } catch {
      return "Agent is waiting at a startup prompt.";
    }
  }
  private assertIdentity(row: Record<string, any>, live: HerdrAgent): void {
    if (
      row.codex_session_id &&
      live.agentSession &&
      row.codex_session_id !== live.agentSession
    )
      throw new HerdrFailure(
        "session_identity_conflict",
        false,
        "Herdr reported a different agent session",
      );
  }
  private async getRecordedAgent(name: string): Promise<HerdrAgent | null> {
    return this.getRecorded(() => this.herdr.getAgent(name));
  }
  private async getRecorded<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (error) {
      if (isMissingHerdrFailure(error)) return null;
      throw error;
    }
  }
  private async closeRecordedPane(id: string, paneId: string): Promise<void> {
    try {
      await this.herdr.closePane(paneId);
    } catch (error) {
      if (!isMissingHerdrFailure(error)) throw error;
    }
    this.database.authQuery((db) =>
      db
        .prepare(
          "UPDATE forge_herdr_role_sessions SET pane_id = NULL, updated_at = ? WHERE id = ? AND pane_id = ?",
        )
        .run(now(), id, paneId),
    );
  }
  async removeSecrets(runtimeRoot: string, sessionId: string): Promise<void> {
    await rm(join(resolve(runtimeRoot), "secrets", `openrouter-${sessionId}.env`), { force: true }).catch(() => undefined);
  }
  private deriveAgentName(
    task: RoleSessionTask,
    role: RoleSessionRole,
    generation: number,
    collision = false,
  ): string {
    return agentName(
      task.issueKey || task.taskId,
      task.taskId,
      role,
      collision,
      generation,
    );
  }
  private started(
    row: Record<string, any>,
    live: HerdrAgent,
    fingerprint: string,
  ): void {
    this.database.authQuery((db) =>
      db
        .prepare(
          `UPDATE forge_herdr_role_sessions
           SET agent_name = ?, pane_id = ?, launch_fingerprint = ?, generation = generation + 1,
               status = 'ready', last_seen_at = ?,
               updated_at = ?, ensure_token = NULL, ensure_expires_at = NULL
           WHERE id = ?`,
        )
        .run(
          live.name,
          live.paneId,
          fingerprint,
          now(),
          now(),
          row.id,
        ),
    );
  }
  private async startOrReplace(input: {
    sessionId: string;
    name: string;
    paneId: string;
    kind: HerdrAgentKind;
    args: string[];
    task: RoleSessionTask;
    role: RoleSessionRole;
    generation: number;
    preparation: string;
    scriptFile: boolean;
    readinessPath: string;
    tab: {
      tabId: string;
      workspaceId: string;
      freshRootPaneId: string | null;
    };
    adoptTimedOutArgvPrompt: boolean;
  }): Promise<HerdrAgent> {
    try {
      return await this.startOrAdopt(input);
    } catch (error) {
      if (this.isInactiveRecordedName(error)) {
        const replacement = this.deriveAgentName(
          input.task,
          input.role,
          input.generation,
          true,
        );
        this.recordStartingName(input.sessionId, replacement, input.paneId);
        return this.startOrAdopt({ ...input, name: replacement });
      }
      if (
        !(error instanceof HerdrFailure) ||
        (error.code !== "pane_not_available" &&
          !error.message.includes("not an available shell"))
      )
        throw error;
      const live = await this.getRecordedAgent(input.name);
      if (live && live.paneId === input.paneId) return live;
      await this.closeRecordedPane(input.sessionId, input.paneId);
      const pane = await this.allocateRolePane(
        input.task,
        input.tab,
        input.role,
      );
      await this.preparePane(
        pane.paneId,
        input.task.runtimeRoot,
        input.preparation,
        input.readinessPath,
        input.scriptFile,
      );
      try {
        return await this.startOrAdopt({ ...input, paneId: pane.paneId });
      } catch (retryError) {
        await this.closePaneDuringFailureCleanup(pane.paneId);
        throw retryError;
      }
    }
  }
  private async startOrAdopt(input: {
    name: string;
    paneId: string;
    kind: HerdrAgentKind;
    args: string[];
    adoptTimedOutArgvPrompt: boolean;
  }): Promise<HerdrAgent> {
    try {
      return await this.herdr.startAgent(input);
    } catch (error) {
      if (input.adoptTimedOutArgvPrompt && isAgentStartupTimeout(error)) {
        const live = await this.getRecordedAgent(input.name);
        if (
          live &&
          live.paneId === input.paneId &&
          (live.status === "working" ||
            live.status === "idle" ||
            live.status === "done"))
          return live;
      }
      throw error;
    }
  }
  private isInactiveRecordedName(error: unknown): boolean {
    return (
      error instanceof HerdrFailure &&
      error.code === "agent_name_not_found"
    );
  }
  private recordStartingName(
    id: string,
    name: string,
    paneId: string,
  ): void {
    this.database.authQuery((db) =>
      db
        .prepare(
          "UPDATE forge_herdr_role_sessions SET agent_name = ?, pane_id = ?, status = 'starting', updated_at = ? WHERE id = ?",
        )
        .run(name, paneId, now(), id),
    );
  }
  private async closePaneDuringFailureCleanup(paneId: string): Promise<void> {
    try {
      await this.herdr.closePane(paneId);
    } catch (error) {
      if (!isMissingHerdrFailure(error)) throw error;
    }
  }
  private async cleanupFailedPane(id: string, paneId: string): Promise<void> {
    await this.closePaneDuringFailureCleanup(paneId);
    this.database.authQuery((db) =>
      db
        .prepare(
          "UPDATE forge_herdr_role_sessions SET agent_name = NULL, pane_id = NULL, status = 'unbound', ensure_token = NULL, ensure_expires_at = NULL, updated_at = ? WHERE id = ? AND pane_id = ?",
        )
        .run(now(), id, paneId),
    );
  }
  private async hasRollout(runtime: HerdrProviderRuntime, sessionId: string, cwd: string): Promise<boolean> {
    try {
      await runtime.discover(await runtime.candidatePaths(this.environment), { sessionId, cwd });
      return true;
    } catch {
      return false;
    }
  }
  private async readinessPath(runtimeRoot: string): Promise<string> {
    const directory = join(resolve(runtimeRoot), "herdr-ready");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return join(directory, randomUUID());
  }
  private async preparePane(
    paneId: string,
    runtimeRoot: string,
    preparation: string,
    readinessPath: string,
    scriptFile = false,
  ): Promise<void> {
    if (!scriptFile) {
      await this.herdr.runPaneCommand(paneId, preparation);
      await this.waitForReadiness(readinessPath);
      return;
    }
    const launchPath = await this.writeLaunchScript(runtimeRoot, preparation);
    try {
      await this.herdr.runPaneCommand(paneId, `source ${quote(launchPath)}`);
      await this.waitForReadiness(readinessPath);
    } finally {
      await rm(launchPath, { force: true }).catch(() => undefined);
    }
  }
  private async writeInitialPrompt(input: { path: string; content: string }): Promise<string> {
    await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
    await writeFile(input.path, input.content, { mode: 0o600 });
    await chmod(input.path, 0o600);
    return resolve(input.path);
  }
  private async writeLaunchScript(
    runtimeRoot: string,
    body: string,
  ): Promise<string> {
    const directory = join(resolve(runtimeRoot), "herdr-launch");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const path = join(directory, `${randomUUID()}.sh`);
    await writeFile(path, `${body}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    return path;
  }
  private async writeDeveloperZshrc(directory: string, worktreePath: string): Promise<void> {
    const miseNode = await runCommand({ taskId: null, stepId: null, expectNonZero: true, command: "mise", args: ["which", "node"], cwd: worktreePath, env: withWorktreeMiseTrust(this.environment, worktreePath), timeout: 8_000 });
    const nodeDirectory = dirname(miseNode.exitCode === 0 && miseNode.stdout.trim() ? miseNode.stdout.trim() : process.execPath);
    await writeFile(
      join(directory, ".zshrc"),
      `if [ -r "$HOME/.zshrc" ]; then source "$HOME/.zshrc"; fi
export PATH="$FORGE_GIT_GUARD_DIR:${nodeDirectory}:$PATH"
if [ "$(node -v 2>/dev/null)" != "v${SUPPORTED_NODE_VERSION}" ]; then
  printf 'Forge error: developer pane Node version mismatch (node=%s, node_path=%s, mise_node_path=%s, expected=v${SUPPORTED_NODE_VERSION})\\n' "$(node -v 2>/dev/null || printf missing)" "$(command -v node 2>/dev/null || printf missing)" "${nodeDirectory}/node" >&2
fi
if [ -n "$FORGE_HERDR_READINESS_SENTINEL" ]; then printf ok > "$FORGE_HERDR_READINESS_SENTINEL"; fi
`,
      { mode: 0o600 },
    );
    await chmod(join(directory, ".zshrc"), 0o600);
  }
  private async waitForReadiness(path: string): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        await access(path);
        await rm(path, { force: true });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.wait(500);
    }
    throw new HerdrFailure(
      "readiness_timeout",
      true,
      "Timed out waiting for pane readiness sentinel",
    );
  }
  private reserve(
    task: RoleSessionTask,
    role: RoleSessionRole,
    settings: LaunchSettings,
  ): Record<string, any> {
    return this.database.authQuery((db) =>
      db.transaction(() => {
        let row = db
          .prepare(
            "SELECT * FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = ? AND is_current = 1 ORDER BY generation DESC LIMIT 1",
          )
          .get(task.taskId, role) as Record<string, any> | undefined;
        if (!row) {
          const id = `session_${randomBytes(12).toString("hex")}`;
          const generation =
            Number(
              (
                db
                  .prepare(
                    "SELECT COALESCE(MAX(generation), -1) AS generation FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = ?",
                  )
                  .get(task.taskId, role) as {
                  generation: number;
                }
              ).generation,
            ) + 1;
          db.prepare(
            "INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, status, created_at, updated_at, ensure_token, ensure_expires_at) VALUES (?, ?, ?, ?, 1, ?, 'unbound', ?, ?, ?, ?)",
          ).run(
            id,
            task.taskId,
            role,
            generation,
            settings?.provider ?? "codex",
            now(),
            now(),
            randomUUID(),
            now(),
          );
          row = db
            .prepare("SELECT * FROM forge_herdr_role_sessions WHERE id = ?")
            .get(id) as Record<string, any>;
        }
        return row;
      })(),
    );
  }
  private async workspace(task: RoleSessionTask): Promise<{
    workspaceId: string;
  }> {
    const row = this.database.authQuery(
      (db) =>
        db
          .prepare(
            "SELECT workspace_id FROM forge_herdr_project_workspaces WHERE project_id = ?",
          )
          .get(task.projectId) as
          | {
              workspace_id: string | null;
            }
          | undefined,
    );
    const workspaceId = row?.workspace_id;
    const found = workspaceId
      ? await this.getRecorded(() => this.herdr.getWorkspace(workspaceId))
      : null;
    if (found) return { workspaceId: found.workspaceId };
    const created = await this.herdr.createWorkspace({
      label: herdrLabel(task.projectSlug),
      cwd: task.worktreePath,
      focus: false,
    });
    this.database.authQuery((db) =>
      db
        .prepare(
          "INSERT INTO forge_herdr_project_workspaces (project_id, workspace_label, workspace_id, state, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?) ON CONFLICT(project_id) DO UPDATE SET workspace_id = excluded.workspace_id, state = 'open', updated_at = excluded.updated_at",
        )
        .run(
          task.projectId,
          herdrLabel(task.projectSlug),
          created.workspace.workspaceId,
          now(),
          now(),
        ),
    );
    return { workspaceId: created.workspace.workspaceId };
  }
  private async tab(
    task: RoleSessionTask,
    workspaceId: string,
  ): Promise<{
    tabId: string;
    workspaceId: string;
    freshRootPaneId: string | null;
  }> {
    const row = this.database.authQuery(
      (db) =>
        db
          .prepare(
            "SELECT tab_id FROM forge_herdr_task_tabs WHERE task_id = ?",
          )
          .get(task.taskId) as
          | {
              tab_id: string | null;
            }
          | undefined,
    );
    const tabId = row?.tab_id;
    if (tabId && (await this.getRecorded(() => this.herdr.getTab(tabId))))
      return { tabId, workspaceId, freshRootPaneId: null };
    const created = await this.herdr.createTab({
      workspaceId,
      label: task.issueKey || task.taskId,
      cwd: task.worktreePath,
      focus: false,
    });
    this.database.authQuery((db) =>
      db
        .prepare(
          "INSERT INTO forge_herdr_task_tabs (task_id, project_id, workspace_id, tab_label, tab_id, shell_pane_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?) ON CONFLICT(task_id) DO UPDATE SET tab_id = excluded.tab_id, shell_pane_id = excluded.shell_pane_id, workspace_id = excluded.workspace_id, state = 'open', updated_at = excluded.updated_at",
        )
        .run(
          task.taskId,
          task.projectId,
          workspaceId,
          task.issueKey || task.taskId,
          created.tab.tabId,
          null,
          now(),
          now(),
        ),
    );
    return {
      tabId: created.tab.tabId,
      workspaceId,
      freshRootPaneId: created.rootPane.paneId,
    };
  }
  private async allocateRolePane(
    task: RoleSessionTask,
    tab: {
      tabId: string;
      workspaceId: string;
      freshRootPaneId: string | null;
    },
    role: RoleSessionRole,
  ): Promise<{ paneId: string }> {
    if (tab.freshRootPaneId) {
      const paneId = tab.freshRootPaneId;
      tab.freshRootPaneId = null;
      await this.herdr.renamePane(paneId, role);
      return { paneId };
    }
    const rows = this.database.authQuery((db) =>
      db
        .prepare(
          "SELECT pane_id FROM forge_herdr_role_sessions WHERE task_id = ? AND pane_id IS NOT NULL AND status NOT IN ('closed', 'failed')",
        )
        .all(task.taskId) as Array<{ pane_id: string | null }>,
    );
    for (const { pane_id: anchor } of rows) {
      if (!anchor) continue;
      const live = await this.getRecorded(() => this.herdr.getPane(anchor));
      if (
        !live ||
        (live.tabId !== undefined && live.tabId !== tab.tabId)
      )
        continue;
      const pane = await this.herdr.splitPane({
        paneId: anchor,
        direction: "down",
        cwd: task.worktreePath,
        focus: false,
      });
      await this.herdr.renamePane(pane.paneId, role);
      return { paneId: pane.paneId };
    }
    if (await this.getRecorded(() => this.herdr.getTab(tab.tabId)))
      await this.herdr.closeTab(tab.tabId);
    const created = await this.herdr.createTab({
      workspaceId: tab.workspaceId,
      label: task.issueKey || task.taskId,
      cwd: task.worktreePath,
      focus: false,
    });
    this.database.authQuery((db) =>
      db
        .prepare(
          "INSERT INTO forge_herdr_task_tabs (task_id, project_id, workspace_id, tab_label, tab_id, shell_pane_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?) ON CONFLICT(task_id) DO UPDATE SET tab_id = excluded.tab_id, shell_pane_id = excluded.shell_pane_id, workspace_id = excluded.workspace_id, state = 'open', updated_at = excluded.updated_at",
        )
        .run(
          task.taskId,
          task.projectId,
          tab.workspaceId,
          task.issueKey || task.taskId,
          created.tab.tabId,
          null,
          now(),
          now(),
        ),
    );
    tab.tabId = created.tab.tabId;
    await this.herdr.renamePane(created.rootPane.paneId, role);
    return { paneId: created.rootPane.paneId };
  }
  private ready(
    row: Record<string, any>,
    live: HerdrAgent,
    fingerprint: string,
    launched: boolean,
  ): EnsuredRoleSession {
    this.database.authQuery((db) =>
      db
        .prepare(
          "UPDATE forge_herdr_role_sessions SET agent_name = ?, pane_id = ?, codex_session_id = COALESCE(codex_session_id, ?), status = ?, last_agent_status = ?, last_seen_at = ?, launch_fingerprint = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          live.name,
          live.paneId,
          live.agentSession ?? null,
          live.status === "working" ? "working" : "ready",
          live.status ?? null,
          now(),
          fingerprint,
          now(),
          row.id,
        ),
    );
    return {
      id: row.id,
      provider: row.provider_kind as AgentProviderKind,
      agentName: live.name,
      paneId: live.paneId,
      codexSessionId:
        typeof row.codex_session_id === "string"
          ? row.codex_session_id
          : live.agentSession ?? null,
      generation: Number(row.generation),
      ...(typeof row.rollout_path === "string"
        ? { rolloutPath: row.rollout_path }
        : {}),
      live,
      launched,
    };
  }
}
