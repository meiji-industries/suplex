import { runCommand, type CommandRunResult } from "./command-runner.js";
import { z } from "zod";

const PaneProcessInfoSchema = z.object({
  pane_id: z.string().min(1),
  shell_pid: z.number().int().positive().optional(),
  foreground_process_group_id: z.number().int().positive().optional(),
  foreground_processes: z.array(z.object({ pid: z.number().int().positive(), name: z.string(), argv: z.array(z.string()).optional() })).default([]),
});
export type PaneProcessInfo = z.infer<typeof PaneProcessInfoSchema>;
import { json } from "./task-utils.js";
type ExecFileRunner = (
  file: string,
  args: readonly string[],
  options: {
    maxBuffer: number;
    expectNonZero?: (result: CommandRunResult) => boolean;
  },
) => Promise<{
  stdout: string;
  stderr?: string;
}>;
const missingResourceResult = (result: CommandRunResult): boolean => {
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
  "pane_not_found",
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
  closeWorkspace(id: string): Promise<void>;
  getPane(id: string): Promise<Pane | null>;
  getPaneProcessInfo(id: string): Promise<PaneProcessInfo>;
  splitPane(input: {
    paneId: string;
    direction: "right" | "down";
    cwd: string;
    focus: false;
  }): Promise<Pane>;
  renamePane(id: string, label: string): Promise<void>;
  runPaneCommand(id: string, command: string): Promise<void>;
  closePane(id: string): Promise<void>;
  reportPaneMetadata(input: HerdrPaneMetadataReport): Promise<void>;
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
  closeWorkspace(idValue: string): Promise<void> {
    return this.empty(["workspace", "close", idValue]);
  }
  async getPane(idValue: string): Promise<Pane | null> {
    return this.optional(async () =>
      pane(value<Json>(await this.call(["pane", "get", idValue], true), "pane")),
    );
  }
  async getPaneProcessInfo(idValue: string): Promise<PaneProcessInfo> {
    const info = PaneProcessInfoSchema.parse((await this.call(["pane", "process-info", "--pane", idValue])).process_info);
    if (info.pane_id !== idValue) throw new Error("Herdr returned another pane's process information");
    return info;
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
  runPaneCommand(idValue: string, command: string): Promise<void> {
    return this.empty(["pane", "run", idValue, command], true);
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
}
