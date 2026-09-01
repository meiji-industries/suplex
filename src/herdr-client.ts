import { runCommand } from "./command-runner.js";
import type { HerdrAgentKind } from "./agent-providers/provider.js";
import { json } from "./task-utils.js";
type ExecFileRunner = (
  file: string,
  args: readonly string[],
  options: {
    maxBuffer: number;
    expectNonZero?: (result: import("./command-runner.js").CommandRunResult) => boolean;
  },
) => Promise<{
  stdout: string;
  stderr?: string;
}>;
const missingResourceResult = (result: import("./command-runner.js").CommandRunResult): boolean => {
  const output = `${result.stdout} ${result.stderr}`;
  return [...missing].some((code) => output.includes(`"code":"${code}"`));
};
const execute: ExecFileRunner = async (file, args, options) => {
  const result = await runCommand({
    taskId: null,
    stepId: null,
    ...(options.expectNonZero ? { expectNonZero: options.expectNonZero } : {}),
    command: file,
    args,
  });
  if (result.exitCode !== 0)
    throw Object.assign(new Error("Herdr command failed"), {
      code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  return { stdout: result.stdout, stderr: result.stderr };
};
export class HerdrFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "HerdrFailure";
  }
}
export interface Workspace {
  workspaceId: string;
  label: string;
  cwd?: string;
  [key: string]: unknown;
}
export interface Tab {
  tabId: string;
  workspaceId?: string;
  label: string;
  cwd?: string;
  [key: string]: unknown;
}
export interface Pane {
  paneId: string;
  terminalId?: string;
  tabId?: string;
  workspaceId?: string;
  label?: string;
  cwd?: string;
  foregroundCwd?: string;
  agent?: string;
  title?: string;
  terminalTitle?: string;
  terminalTitleStripped?: string;
  displayAgent?: string;
  status?: string;
  agentStatus?: string;
  stateLabels?: Record<string, string>;
  tokens?: Record<string, string>;
  agentSession?: string;
  [key: string]: unknown;
}
export interface HerdrAgent {
  name: string;
  paneId: string;
  workspaceId?: string;
  tabId?: string;
  agentSession?: string;
  status?: string;
  screenDetectionSkipped?: boolean;
  [key: string]: unknown;
}
export interface PromptOptions {
  waitForWorking?: boolean;
}
/** A single live Herdr observation; pane display metadata is transient. */
export interface HerdrRuntimeSnapshot {
  agents: HerdrAgent[];
  panes: Pane[];
  [key: string]: unknown;
}
/**
 * Display-only pane hints for Herdr. Herdr does not persist this metadata across
 * server restarts, so callers must not treat it as durable Forge state.
 */
export interface HerdrPaneMetadataReport {
  paneId: string;
  source: string;
  agent?: string;
  appliesToSource?: string;
  title?: string;
  clearTitle?: boolean;
  displayAgent?: string;
  clearDisplayAgent?: boolean;
  stateLabels?: Readonly<Record<string, string>>;
  clearStateLabels?: boolean;
  tokens?: Readonly<Record<string, string>>;
  clearTokens?: readonly string[];
  seq?: number;
  ttlMs?: number;
}
type Json = Record<string, unknown>;
const missing = new Set([
  "workspace_not_found",
  "tab_not_found",
  "pane_not_found",
  "agent_not_found",
  "agent_name_not_found",
]);
function value<T extends Json>(raw: unknown, key: string): T {
  if (!raw || typeof raw !== "object")
    throw new HerdrFailure(
      "invalid_response",
      false,
      "Herdr returned an invalid response",
    );
  const found = (raw as Json)[key];
  if (!found || typeof found !== "object")
    throw new HerdrFailure(
      "invalid_response",
      false,
      "Herdr response was missing required data",
    );
  return found as T;
}
function id(raw: Json, ...keys: string[]): string {
  for (const key of keys)
    if (typeof raw[key] === "string" && raw[key]) return raw[key] as string;
  throw new HerdrFailure(
    "invalid_response",
    false,
    "Herdr response had no identifier",
  );
}
function workspace(raw: Json): Workspace {
  return {
    ...raw,
    workspaceId: id(raw, "workspace_id", "workspaceId"),
    label: String(raw.label ?? ""),
  };
}
function tab(raw: Json): Tab {
  return {
    ...raw,
    tabId: id(raw, "tab_id", "tabId"),
    ...(typeof raw.workspace_id === "string"
      ? { workspaceId: raw.workspace_id }
      : {}),
    label: String(raw.label ?? ""),
  };
}
function optionalString(raw: Json, ...keys: string[]): string | undefined {
  for (const key of keys)
    if (typeof raw[key] === "string") return raw[key] as string;
  return undefined;
}
function stringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  );
}
function agentSession(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object" || !("value" in raw)) return undefined;
  return typeof (raw as Json).value === "string"
    ? ((raw as Json).value as string)
    : undefined;
}
function pane(raw: Json): Pane {
  const status = optionalString(raw, "agent_status", "agentStatus", "status");
  const session = agentSession(raw.agent_session ?? raw.agentSession);
  return {
    ...raw,
    paneId: id(raw, "pane_id", "paneId"),
    ...(typeof raw.terminal_id === "string"
      ? { terminalId: raw.terminal_id }
      : {}),
    ...(typeof raw.tab_id === "string" ? { tabId: raw.tab_id } : {}),
    ...(typeof raw.workspace_id === "string"
      ? { workspaceId: raw.workspace_id }
      : {}),
    ...(typeof raw.foreground_cwd === "string"
      ? { foregroundCwd: raw.foreground_cwd }
      : {}),
    ...(typeof raw.terminal_title === "string"
      ? { terminalTitle: raw.terminal_title }
      : {}),
    ...(typeof raw.terminal_title_stripped === "string"
      ? { terminalTitleStripped: raw.terminal_title_stripped }
      : {}),
    ...(typeof raw.display_agent === "string"
      ? { displayAgent: raw.display_agent }
      : {}),
    ...(status !== undefined ? { status, agentStatus: status } : {}),
    stateLabels: stringRecord(raw.state_labels ?? raw.stateLabels),
    tokens: stringRecord(raw.tokens),
    ...(session !== undefined ? { agentSession: session } : {}),
  };
}
function agent(raw: Json): HerdrAgent {
  const session = agentSession(raw.agent_session ?? raw.agentSession);
  const status = raw.agent_status ?? raw.status;
  return {
    ...raw,
    name: id(raw, "name"),
    paneId: id(raw, "pane_id", "paneId"),
    ...(typeof raw.tab_id === "string" ? { tabId: raw.tab_id } : {}),
    ...(typeof raw.workspace_id === "string"
      ? { workspaceId: raw.workspace_id }
      : {}),
    ...(session !== undefined ? { agentSession: session } : {}),
    ...(typeof status === "string" ? { status } : {}),
    ...(typeof raw.screen_detection_skipped === "boolean" ? { screenDetectionSkipped: raw.screen_detection_skipped } : {}),
  };
}
export interface HerdrClient {
  listWorkspaces(): Promise<Workspace[]>;
  createWorkspace(input: {
    label: string;
    cwd: string;
    focus: false;
  }): Promise<{
    workspace: Workspace;
    tab: Tab;
    rootPane: Pane;
  }>;
  getWorkspace(id: string): Promise<Workspace | null>;
  renameWorkspace(id: string, label: string): Promise<void>;
  closeWorkspace(id: string): Promise<void>;
  listTabs(workspaceId: string): Promise<Tab[]>;
  createTab(input: {
    workspaceId: string;
    label: string;
    cwd: string;
    focus: false;
  }): Promise<{
    tab: Tab;
    rootPane: Pane;
  }>;
  getTab(id: string): Promise<Tab | null>;
  renameTab(id: string, label: string): Promise<void>;
  closeTab(id: string): Promise<void>;
  listPanes(workspaceId: string): Promise<Pane[]>;
  getPane(id: string): Promise<Pane | null>;
  splitPane(input: {
    paneId: string;
    direction: "right" | "down";
    cwd: string;
    focus: false;
  }): Promise<Pane>;
  renamePane(id: string, label: string): Promise<void>;
  readPane(id: string): Promise<string>;
  runPaneCommand(id: string, command: string): Promise<void>;
  waitPaneOutput(id: string, match: string): Promise<void>;
  sendPaneKeys(id: string, keys: string[]): Promise<void>;
  closePane(id: string): Promise<void>;
  reportPaneMetadata(input: HerdrPaneMetadataReport): Promise<void>;
  listAgents(): Promise<HerdrAgent[]>;
  runtimeSnapshot(): Promise<HerdrRuntimeSnapshot>;
  snapshot(): Promise<HerdrAgent[]>;
  getAgent(name: string): Promise<HerdrAgent | null>;
  renameAgent(target: string, name: string): Promise<void>;
  readAgent(name: string, source?: "recent-unwrapped", lines?: number, format?: "text" | "ansi"): Promise<string>;
  waitAgent(name: string): Promise<HerdrAgent>;
  prompt(name: string, text: string, options?: PromptOptions): Promise<HerdrAgent>;
  sendKeys(name: string, keys: ["ctrl+c"]): Promise<void>;
  startAgent(input: {
    name: string;
    paneId: string;
    kind: HerdrAgentKind;
    args: string[];
  }): Promise<HerdrAgent>;
}
type HerdrSnapshotClient = Partial<
  Pick<HerdrClient, "runtimeSnapshot" | "snapshot" | "listAgents">
>;
function snapshotFromAgents(agents: HerdrAgent[]): HerdrRuntimeSnapshot {
  return {
    agents,
    // Agent rows contain their pane identity and metadata. Deriving only those
    // panes stays bounded; enumerating every legacy pane requires N workspace
    // calls and is intentionally not attempted by the compatibility path.
    panes: agents.map((entry) => pane(entry as Json)),
  };
}
export async function snapshotHerdrRuntime(
  client: HerdrSnapshotClient,
): Promise<HerdrRuntimeSnapshot> {
  if (typeof client.runtimeSnapshot === "function") {
    try {
      return await client.runtimeSnapshot();
    } catch {
      // Older Herdr servers do not expose the batched runtime snapshot.
    }
    const agents =
      typeof client.listAgents === "function" ? await client.listAgents() : [];
    return snapshotFromAgents(agents);
  }
  if (typeof client.snapshot === "function") {
    try {
      return snapshotFromAgents(await client.snapshot());
    } catch {
      // Older clients can still provide the bounded agent listing fallback.
    }
  }
  const agents =
    typeof client.listAgents === "function" ? await client.listAgents() : [];
  return snapshotFromAgents(agents);
}
export async function snapshotAgents(
  client: HerdrSnapshotClient,
): Promise<HerdrAgent[]> {
  return (await snapshotHerdrRuntime(client)).agents;
}
export class CliHerdrClient implements HerdrClient {
  constructor(
    private readonly binary = "herdr",
    private readonly runner: ExecFileRunner = execute,
  ) {}
  private async call(args: string[], expectMissing = false): Promise<Json> {
    return this.callAllowingEmpty(args, false, expectMissing) as Promise<Json>;
  }
  private async callAllowingEmpty(
    args: string[],
    allowingEmpty = true,
    expectMissing = false,
  ): Promise<Json | undefined> {
    try {
      const { stdout } = await this.runner(this.binary, args, {
        maxBuffer: 1024 * 1024,
        ...(expectMissing ? { expectNonZero: missingResourceResult } : {}),
      });
      if (allowingEmpty && !stdout.trim()) return undefined;
      const parsed = json(stdout, undefined);
      if (!parsed || typeof parsed !== "object")
        throw new HerdrFailure("invalid_response", false, "Invalid Herdr JSON response");
      const response = parsed as Json;
      const envelope = value<Json>(response, "result");
      if (typeof response.id !== "string")
        throw new HerdrFailure(
          "invalid_response",
          false,
          "Herdr response had no request id",
        );
      return envelope;
    } catch (error) {
      if (error instanceof HerdrFailure) throw error;
      const detail = error as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      const output = `${detail.stdout ?? ""} ${detail.stderr ?? ""}`;
      if (args[0] === "agent" && args[1] === "start" && args.includes("omp") && /(?:omp.*(?:not found|ENOENT)|(?:not found|ENOENT).*omp)/i.test(output))
        throw new HerdrFailure("provider-unavailable", false, "omp is not installed on the Forge host");
      const bodies = [detail.stdout, detail.stderr]
        .map((stream) => json<Json | undefined>(stream ?? "", undefined))
        .filter((candidate): candidate is Json => candidate !== undefined);
      const body =
        bodies.find(
          (candidate) =>
            typeof candidate.error === "object" ||
            typeof candidate.code === "string",
        ) ?? bodies[0];
      const nested =
        body && typeof body.error === "object" && body.error
          ? (body.error as Json)
          : undefined;
      const code =
        detail.code === 2
          ? "syntax"
          : typeof nested?.code === "string"
            ? nested.code
            : typeof body?.code === "string"
              ? body.code
              : "unavailable";
      const message =
        typeof nested?.message === "string"
          ? nested.message
          : typeof body?.message === "string"
            ? body.message
            : undefined;
      const retryable =
        detail.code !== 2 &&
        code !== "syntax" &&
        !["invalid_argument", "invalid_request"].includes(code);
      const resourceMissing = missing.has(code) && code !== "timeout";
      throw new HerdrFailure(
        code,
        retryable,
        resourceMissing
          ? "Herdr resource is unavailable"
          : message
            ? `Herdr command failed: ${message}`
            : "Herdr command failed",
      );
    }
  }
  private async optional<T>(operation: () => Promise<T>): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HerdrFailure && missing.has(error.code)) return null;
      throw error;
    }
  }
  private async empty(
    args: string[],
    allowingEmpty = false,
  ): Promise<void> {
    await this.callAllowingEmpty(args, allowingEmpty);
  }
  async listWorkspaces(): Promise<Workspace[]> {
    return (
      ((await this.call(["workspace", "list"])).workspaces as Json[]) ?? []
    ).map(workspace);
  }
  async createWorkspace(input: {
    label: string;
    cwd: string;
    focus: false;
  }): Promise<{
    workspace: Workspace;
    tab: Tab;
    rootPane: Pane;
  }> {
    const r = await this.call([
      "workspace",
      "create",
      "--label",
      input.label,
      "--cwd",
      input.cwd,
      "--no-focus",
    ]);
    return {
      workspace: workspace(value<Json>(r, "workspace")),
      tab: tab(value<Json>(r, "tab")),
      rootPane: pane(value<Json>(r, "root_pane")),
    };
  }
  async getWorkspace(idValue: string): Promise<Workspace | null> {
    return this.optional(async () =>
      workspace(
        value<Json>(
          await this.call(["workspace", "get", idValue], true),
          "workspace",
        ),
      ),
    );
  }
  renameWorkspace(idValue: string, label: string): Promise<void> {
    return this.empty(["workspace", "rename", idValue, label]);
  }
  closeWorkspace(idValue: string): Promise<void> {
    return this.empty(["workspace", "close", idValue]);
  }
  async listTabs(workspaceId: string): Promise<Tab[]> {
    return (
      ((await this.call(["tab", "list", "--workspace", workspaceId]))
        .tabs as Json[]) ?? []
    ).map(tab);
  }
  async createTab(input: {
    workspaceId: string;
    label: string;
    cwd: string;
    focus: false;
  }): Promise<{
    tab: Tab;
    rootPane: Pane;
  }> {
    const r = await this.call([
      "tab",
      "create",
      "--workspace",
      input.workspaceId,
      "--label",
      input.label,
      "--cwd",
      input.cwd,
      "--no-focus",
    ]);
    return {
      tab: tab(value<Json>(r, "tab")),
      rootPane: pane(value<Json>(r, "root_pane")),
    };
  }
  async getTab(idValue: string): Promise<Tab | null> {
    return this.optional(async () =>
      tab(value<Json>(await this.call(["tab", "get", idValue], true), "tab")),
    );
  }
  renameTab(idValue: string, label: string): Promise<void> {
    return this.empty(["tab", "rename", idValue, label]);
  }
  closeTab(idValue: string): Promise<void> {
    return this.empty(["tab", "close", idValue]);
  }
  async listPanes(workspaceId: string): Promise<Pane[]> {
    return (
      ((await this.call(["pane", "list", "--workspace", workspaceId]))
        .panes as Json[]) ?? []
    ).map(pane);
  }
  async getPane(idValue: string): Promise<Pane | null> {
    return this.optional(async () =>
      pane(value<Json>(await this.call(["pane", "get", idValue], true), "pane")),
    );
  }
  async splitPane(input: {
    paneId: string;
    direction: "right" | "down";
    cwd: string;
    focus: false;
  }): Promise<Pane> {
    return pane(
      value<Json>(
        await this.call([
          "pane",
          "split",
          input.paneId,
          "--direction",
          input.direction,
          "--cwd",
          input.cwd,
          "--no-focus",
        ]),
        "pane",
      ),
    );
  }
  renamePane(idValue: string, label: string): Promise<void> {
    return this.empty(["pane", "rename", idValue, label]);
  }
  async readPane(idValue: string): Promise<string> {
    return String(
      (
        await this.call([
          "pane",
          "read",
          idValue,
          "--source",
          "recent-unwrapped",
        ])
      ).text ?? "",
    );
  }
  runPaneCommand(idValue: string, command: string): Promise<void> {
    return this.empty(["pane", "run", idValue, command], true);
  }
  waitPaneOutput(idValue: string, match: string): Promise<void> {
    return this.empty(["pane", "wait-output", idValue, "--match", match]);
  }
  sendPaneKeys(idValue: string, keys: string[]): Promise<void> {
    return this.empty(["pane", "send-keys", idValue, ...keys], true);
  }
  closePane(idValue: string): Promise<void> {
    return this.empty(["pane", "close", idValue]);
  }
  reportPaneMetadata(input: HerdrPaneMetadataReport): Promise<void> {
    const args = [
      "pane",
      "report-metadata",
      input.paneId,
      "--source",
      input.source,
    ];
    if (input.agent !== undefined) args.push("--agent", input.agent);
    if (input.appliesToSource !== undefined)
      args.push("--applies-to-source", input.appliesToSource);
    if (input.title !== undefined) args.push("--title", input.title);
    else if (input.clearTitle) args.push("--clear-title");
    if (input.displayAgent !== undefined)
      args.push("--display-agent", input.displayAgent);
    else if (input.clearDisplayAgent) args.push("--clear-display-agent");
    if (input.clearStateLabels) args.push("--clear-state-labels");
    for (const [status, text] of Object.entries(input.stateLabels ?? {}))
      args.push("--state-label", `${status}=${text}`);
    for (const name of input.clearTokens ?? [])
      args.push("--clear-token", name);
    for (const [name, value] of Object.entries(input.tokens ?? {}))
      args.push("--token", `${name}=${value}`);
    if (input.seq !== undefined) args.push("--seq", String(input.seq));
    if (input.ttlMs !== undefined)
      args.push("--ttl-ms", String(input.ttlMs));
    return this.empty(args, true);
  }
  async listAgents(): Promise<HerdrAgent[]> {
    return (((await this.call(["agent", "list"])).agents as Json[]) ?? [])
      .filter((raw) => typeof raw.name === "string")
      .map(agent);
  }
  async runtimeSnapshot(): Promise<HerdrRuntimeSnapshot> {
    const result = await this.call(["api", "snapshot"]);
    const rawSnapshot =
      result.snapshot &&
      typeof result.snapshot === "object" &&
      !Array.isArray(result.snapshot)
        ? (result.snapshot as Json)
        : result;
    const agents = Array.isArray(rawSnapshot.agents)
      ? rawSnapshot.agents.filter(
          (raw): raw is Json =>
            !!raw && typeof raw === "object" && !Array.isArray(raw),
        )
      : [];
    const panes = Array.isArray(rawSnapshot.panes)
      ? rawSnapshot.panes.filter(
          (raw): raw is Json =>
            !!raw && typeof raw === "object" && !Array.isArray(raw),
        )
      : [];
    return {
      ...rawSnapshot,
      agents: agents
        .filter((raw) => typeof raw.name === "string")
        .map(agent),
      panes: panes.map(pane),
    };
  }
  async snapshot(): Promise<HerdrAgent[]> {
    return (await this.runtimeSnapshot()).agents;
  }
  async getAgent(name: string): Promise<HerdrAgent | null> {
    return this.optional(async () =>
      agent(value<Json>(await this.call(["agent", "get", name], true), "agent")),
    );
  }
  renameAgent(target: string, name: string): Promise<void> {
    return this.empty(["agent", "rename", target, name]);
  }
  async readAgent(name: string, source = "recent-unwrapped" as const, lines?: number, format?: "text" | "ansi"): Promise<string> {
    // `agent read` prints plain text; older builds wrapped it in the JSON envelope.
    const { stdout } = await this.runner(this.binary, ["agent", "read", name, "--source", source, ...(lines ? ["--lines", String(lines)] : []), ...(format ? ["--format", format] : [])], { maxBuffer: 1024 * 1024 });
    const parsed = json(stdout, undefined) as Json | undefined;
    const result = parsed && typeof parsed === "object" ? ((parsed.result as Json | undefined) ?? parsed) : undefined;
    return typeof result?.text === "string" ? result.text : stdout;
  }
  async waitAgent(name: string): Promise<HerdrAgent> {
    return agent(
      value<Json>(await this.call(["agent", "wait", name]), "agent"),
    );
  }
  async prompt(name: string, text: string, options?: PromptOptions): Promise<HerdrAgent> {
    return agent(
      value<Json>(await this.call([
        "agent",
        "prompt",
        name,
        text,
        ...(options?.waitForWorking ? ["--wait", "--until", "working", "--timeout", "6000"] : []),
      ]), "agent"),
    );
  }
  sendKeys(name: string, keys: ["ctrl+c"]): Promise<void> {
    return this.empty(["agent", "send-keys", name, ...keys]);
  }
  async startAgent(input: {
    name: string;
    paneId: string;
    kind: HerdrAgentKind;
    args: string[];
  }): Promise<HerdrAgent> {
    try {
      return agent(value<Json>(await this.call([
          "agent",
          "start",
          input.name,
          "--kind",
          input.kind,
          "--pane",
          input.paneId,
          "--timeout",
          "120000",
          "--",
          ...input.args,
        ]), "agent"));
    } catch (error) {
      const output = `${String((error as { stderr?: unknown }).stderr ?? "")} ${String((error as { message?: unknown }).message ?? "")}`;
      if (input.kind === "omp" && /(?:omp.*(?:not found|ENOENT)|(?:not found|ENOENT).*omp)/i.test(output)) throw new HerdrFailure("provider-unavailable", false, "omp is not installed on the Forge host");
      throw error;
    }
  }
}
