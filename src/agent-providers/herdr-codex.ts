import type { ForgeDatabase } from "../database.js";
import { HerdrTurnRunner } from "../herdr-turn-runner.js";
import type { HerdrClient } from "../herdr-client.js";
import { IssueTimelineEvents } from "../issue-timeline-events.js";
import { HerdrSessionStore } from "../herdr-session-store.js";
import type { AgentProvider, InteractiveTurnRequest, InteractiveTurnResult } from "./provider.js";
import { CodexReadinessProbe } from "./codex-readiness.js";
import type { CommandRunner } from "../provider-readiness.js";

export async function forwardHerdrAgent(database: ForgeDatabase | undefined, herdr: HerdrClient | undefined, taskId: string, role: "lead" | "developer", text: string): Promise<void> {
  if (!database || !herdr) throw new Error("Herdr provider requires database and HerdrClient for forwarding");
  const row = database.authQuery((db) => db.prepare("SELECT agent_name FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = ? AND is_current = 1").get(taskId, role === "lead" ? "planner" : "builder") as { agent_name: string | null } | undefined);
  if (row?.agent_name) await herdr.prompt(row.agent_name, text);
}

export async function interruptHerdrAgent(database: ForgeDatabase | undefined, herdr: HerdrClient | undefined, taskId: string, role: "lead" | "developer"): Promise<void> {
  if (!database || !herdr) throw new Error("Herdr provider requires database and HerdrClient for interruption");
  const row = database.authQuery((db) => db.prepare("SELECT agent_name FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = ? AND is_current = 1").get(taskId, role === "lead" ? "planner" : "builder") as { agent_name: string | null } | undefined);
  if (row?.agent_name) await herdr.sendKeys(row.agent_name, ["ctrl+c"]);
}

/** The only production provider: Codex runs inside a Herdr-owned interactive pane. */
export class HerdrCodexProvider implements AgentProvider {
  readonly id = "codex";
  constructor(private readonly database?: ForgeDatabase, private readonly herdr?: HerdrClient) {}
  readinessProbe(command?: string, runner?: CommandRunner) {
    return new CodexReadinessProbe(command ?? process.env.FORGE_CODEX_COMMAND ?? "codex", runner);
  }
  async runTurn<T>(request: InteractiveTurnRequest<T>): Promise<InteractiveTurnResult<T>> {
    if (!this.database || !this.herdr) throw new Error("HerdrCodexProvider requires database and HerdrClient for interactive turns");
    const runner = new HerdrTurnRunner(this.database, this.herdr, new HerdrSessionStore(this.database, this.herdr), new IssueTimelineEvents(this.database));
    return runner.run(request);
  }
  async forward(taskId: string, role: "lead" | "developer", text: string): Promise<void> {
    if (!this.database || !this.herdr) throw new Error("HerdrCodexProvider requires database and HerdrClient for forwarding");
    const row = this.database.authQuery((db) => db.prepare("SELECT agent_name FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = ? AND is_current = 1").get(taskId, role === "lead" ? "planner" : "builder") as { agent_name: string | null } | undefined);
    if (!row?.agent_name) return;
    await this.herdr.prompt(row.agent_name, text);
  }
  async interrupt(taskId: string, role: "lead" | "developer"): Promise<void> {
    if (!this.database || !this.herdr) throw new Error("HerdrCodexProvider requires database and HerdrClient for interruption");
    const row = this.database.authQuery((db) => db.prepare("SELECT agent_name FROM forge_herdr_role_sessions WHERE task_id = ? AND session_role = ? AND is_current = 1").get(taskId, role === "lead" ? "planner" : "builder") as { agent_name: string | null } | undefined);
    if (row?.agent_name) await this.herdr.sendKeys(row.agent_name, ["ctrl+c"]);
  }
}

export const herdrCodexProvider = new HerdrCodexProvider();
