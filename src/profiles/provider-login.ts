import type { HerdrClient } from "../integrations/herdr/client.js";
import { CLAUDE_EXECUTABLE, CODEX_EXECUTABLE, DEVIN_EXECUTABLE, OPENCODE_EXECUTABLE, resolveClaudeExecutable, resolveCodexExecutable, resolveDevinExecutable, resolveOpenCodeExecutable, type ExecutableSpec } from "../platform/executable-resolver.js";
import type { HarnessKind } from "../runtimes/harness-kind.js";
import { CLAUDE_AUTH_ENVIRONMENT_KEYS, claudeEnvironment, claudeRoutingVariable } from "../runtimes/claude-code/environment.js";

export type ProviderLoginPort = Pick<HerdrClient, "getPane" | "createWorkspace" | "runPaneCommand" | "closePane" | "closeWorkspace">;

export const PROVIDER_LOGIN_WORKSPACE_LABEL = "suplex-provider-login";

const quoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const LOGIN_EXECUTABLES: Record<HarnessKind, { spec: ExecutableSpec; resolve: () => Promise<string>; loginArgs: string[] }> = {
  "claude-code": { spec: CLAUDE_EXECUTABLE, resolve: () => resolveClaudeExecutable(), loginArgs: ["auth", "login"] },
  devin: { spec: DEVIN_EXECUTABLE, resolve: () => resolveDevinExecutable(), loginArgs: ["auth", "login"] },
  opencode: { spec: OPENCODE_EXECUTABLE, resolve: () => resolveOpenCodeExecutable(), loginArgs: ["auth", "login"] },
  codex: { spec: CODEX_EXECUTABLE, resolve: () => resolveCodexExecutable(), loginArgs: ["login"] },
};

export interface ProviderLoginCommandOptions {
  resolveExecutable?: () => Promise<string>;
}

/**
 * Interactive sign-in command for a provider; a local instance scopes Claude
 * Code to its home directory. The executable resolves through Suplex's
 * executable resolver so the pane does not depend on the pane shell PATH;
 * when resolution fails the command falls back to the bare binary name so the
 * interactive pane stays usable.
 */
export async function providerLoginCommand(providerId: HarnessKind, homeDirectory?: string | null, options: ProviderLoginCommandOptions = {}): Promise<string> {
  const entry = LOGIN_EXECUTABLES[providerId];
  const binary = await (options.resolveExecutable ?? entry.resolve)().then(quoted, () => entry.spec.binary);
  const command = [binary, ...entry.loginArgs].join(" ");
  if (!homeDirectory || providerId !== "claude-code") return command;
  const removed = [...new Set([...CLAUDE_AUTH_ENVIRONMENT_KEYS, ...Object.keys(process.env).filter(claudeRoutingVariable)])].map(key => `-u ${quoted(key)}`).join(" ");
  const scoped = Object.entries(claudeEnvironment(homeDirectory, {})).map(([key, value]) => `${key}=${quoted(value ?? "")}`).join(" ");
  return `env ${removed} ${scoped} ${command} --setting-sources ''`;
}

export interface ProviderLoginSession {
  target: string;
  paneId: string;
  workspaceId: string;
  label: string;
}

/**
 * Interactive provider sign-ins run in a dedicated Herdr workspace. The registry
 * is the authority for which panes the terminal route can attach to; a session
 * whose pane disappeared from Herdr is forgotten and recreated on demand. Only
 * one sign-in session runs at a time: starting a new login closes the previous
 * session so Herdr is not left running orphaned suplex-provider-login workspaces.
 */
export class ProviderLoginService {
  private readonly sessions = new Map<string, ProviderLoginSession>();
  private readonly byTarget = new Map<string, string>();

  constructor(private readonly herdr: ProviderLoginPort) {}

  async start(input: { target: string; label: string; command: string; cwd?: string }): Promise<ProviderLoginSession> {
    const existingPane = this.byTarget.get(input.target);
    const existing = existingPane ? this.sessions.get(existingPane) : undefined;
    if (existing && await this.herdr.getPane(existing.paneId).then(pane => pane !== null, () => false)) return existing;
    const { workspace, rootPane } = await this.herdr.createWorkspace({ label: PROVIDER_LOGIN_WORKSPACE_LABEL, cwd: input.cwd ?? process.cwd(), focus: false });
    try {
      await this.herdr.runPaneCommand(rootPane.paneId, input.command);
    } catch (error) {
      await this.herdr.closeWorkspace(workspace.workspaceId).catch(() => undefined);
      throw error;
    }
    for (const session of [...this.sessions.values()]) await this.closeSession(session);
    const session: ProviderLoginSession = { target: input.target, paneId: rootPane.paneId, workspaceId: workspace.workspaceId, label: input.label };
    this.sessions.set(session.paneId, session);
    this.byTarget.set(session.target, session.paneId);
    return session;
  }

  get(paneId: string): ProviderLoginSession | undefined {
    return this.sessions.get(paneId);
  }

  async close(paneId: string): Promise<boolean> {
    const session = this.sessions.get(paneId);
    if (!session) return false;
    await this.closeSession(session);
    return true;
  }

  private async closeSession(session: ProviderLoginSession): Promise<void> {
    this.forget(session);
    await this.herdr.closePane(session.paneId).catch(() => undefined);
    await this.herdr.closeWorkspace(session.workspaceId).catch(() => undefined);
  }

  private forget(session: ProviderLoginSession): void {
    this.sessions.delete(session.paneId);
    if (this.byTarget.get(session.target) === session.paneId) this.byTarget.delete(session.target);
  }
}
