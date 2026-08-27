import type { ForgeDatabase } from "../database.js";
import type { HerdrClient } from "../herdr-client.js";
import { HerdrSessionStore } from "../herdr-session-store.js";
import { HerdrTurnRunner } from "../herdr-turn-runner.js";
import { IssueTimelineEvents } from "../issue-timeline-events.js";
import type { CommandRunner } from "../provider-readiness.js";
import { ClaudeReadinessProbe } from "./claude-readiness.js";
import { forwardHerdrAgent, interruptHerdrAgent } from "./herdr-codex.js";
import type { AgentProvider, InteractiveTurnRequest, InteractiveTurnResult } from "./provider.js";

export class HerdrClaudeProvider implements AgentProvider {
  readonly id = "claude";
  constructor(private readonly database?: ForgeDatabase, private readonly herdr?: HerdrClient) {}
  readinessProbe(command?: string, runner?: CommandRunner) { return new ClaudeReadinessProbe(command ?? process.env.FORGE_CLAUDE_COMMAND ?? "claude", runner); }
  async runTurn<T>(request: InteractiveTurnRequest<T>): Promise<InteractiveTurnResult<T>> {
    if (!this.database || !this.herdr) throw new Error("HerdrClaudeProvider requires database and HerdrClient for interactive turns");
    return new HerdrTurnRunner(this.database, this.herdr, new HerdrSessionStore(this.database, this.herdr), new IssueTimelineEvents(this.database)).run(request);
  }
  forward(taskId: string, role: "lead" | "developer", text: string) { return forwardHerdrAgent(this.database, this.herdr, taskId, role, text); }
  interrupt(taskId: string, role: "lead" | "developer") { return interruptHerdrAgent(this.database, this.herdr, taskId, role); }
}
export const herdrClaudeProvider = new HerdrClaudeProvider();
